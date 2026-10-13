import type { Seat } from "@boardwright/core";
import {
  type GameMaster,
  MatchError,
  type MatchEvent,
  type MatchView,
} from "./game-master.ts";
import type { MatchId } from "./match-store.ts";
import {
  SearchError,
  type SearchFailure,
  searchInWorker,
  type SearchRequest,
} from "./engine-search.ts";

/**
 * Why an Engine Seat forfeited: the Forfeit's `reason` (public; details are
 * only logged). `illegal-move` covers undecodable Moves too; `not-registered`
 * means the server no longer offers the Seat's Engine.
 */
export type ForfeitReason = SearchFailure | "illegal-move" | "not-registered";

/** Search time used for an Engine Seat whose `limits.maxTimeMs` is unset. */
export const DEFAULT_SEARCH_TIME_MS = 5000;

export interface EngineDriverOptions {
  /**
   * Extra time beyond a Seat's `limits.maxTimeMs` before a search counts as
   * hung (covers worker start-up and the Engine's overshoot). Default 5000.
   */
  readonly graceMs?: number;
  /** Searches running at once; further ones wait their turn. Default 4. */
  readonly maxConcurrent?: number;
  /** Searches per Move before the Seat forfeits (default 2: one retry). */
  readonly attempts?: number;
  /** How a search runs; defaults to a Web Worker. Replaceable in tests. */
  readonly search?: typeof searchInWorker;
}

/**
 * Plays the Engine Seats of a GameMaster's Matches. After every Match event
 * that leaves a Seat to move, it loads the Match and, if it is still at that
 * event's version and the Seat is an Engine's, asks that Engine (in a Web
 * Worker, so the server keeps answering requests) and plays the Move with
 * `GameMaster.apply`, i.e. through the same referee checks as human Moves.
 *
 * A search that errors, hangs past its deadline or returns a Move the referee
 * refuses is retried with a fresh worker; when the attempts are used up the
 * Seat forfeits (a `forfeit` Outcome whose `reason` is a {@link ForfeitReason},
 * no raw error text), so a Match never hangs on a broken Engine.
 */
export class EngineDriver {
  readonly #master: GameMaster;
  readonly #graceMs: number;
  readonly #attempts: number;
  readonly #maxConcurrent: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  readonly #search: typeof searchInWorker;
  readonly #running = new Set<Promise<void>>();
  readonly #abort = new AbortController();
  readonly #unsubscribe: () => void;

  constructor(master: GameMaster, options: EngineDriverOptions = {}) {
    this.#master = master;
    this.#graceMs = options.graceMs ?? 5000;
    this.#attempts = options.attempts ?? 2;
    this.#maxConcurrent = options.maxConcurrent ?? 4;
    this.#search = options.search ?? searchInWorker;
    this.#unsubscribe = master.onMatchChanged((event) => this.#onEvent(event));
  }

  /** Resolves when no Engine is searching or about to play. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running]);
  }

  /** Stop reacting to Matches and terminate searches in flight (no forfeits). */
  async close(): Promise<void> {
    this.#unsubscribe();
    this.#abort.abort();
    await this.idle();
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#maxConcurrent) {
      this.#active++;
      return;
    }
    // The slot is handed over by #release without freeing it.
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#active--;
  }

  #onEvent(event: MatchEvent): void {
    if (event.toMove === null) return;
    const task = this.#play(event.matchId, event.version, event.toMove)
      .finally(() => this.#running.delete(task));
    this.#running.add(task);
  }

  async #play(id: MatchId, version: number, seat: Seat): Promise<void> {
    let match: MatchView;
    try {
      match = await this.#master.getMatch(id);
    } catch (error) {
      console.error(`Could not load Match ${id} for its Engine:`, error);
      return;
    }
    // A later event (or a Resignation) superseded this one; it is handled there.
    if (match.version !== version) return;
    const player = match.seats[seat];
    if (player?.kind !== "engine") return;
    const entry = this.#master.engines.get(match.gameId, player.engineId);
    // Public failure reason; details only go to the server log.
    let failure: ForfeitReason = "not-registered";
    for (let attempt = 1; attempt <= this.#attempts; attempt++) {
      if (this.#abort.signal.aborted) return;
      if (!entry) {
        break;
      }
      const request: SearchRequest = {
        module: entry.module,
        position: match.position,
        limits: {
          ...player.limits,
          maxTimeMs: player.limits.maxTimeMs ?? DEFAULT_SEARCH_TIME_MS,
        },
      };
      try {
        let move: string;
        await this.#acquire();
        try {
          if (this.#abort.signal.aborted) return;
          move = await this.#search(request, {
            timeoutMs: request.limits.maxTimeMs! + this.#graceMs,
            signal: this.#abort.signal,
          });
        } finally {
          this.#release();
        }
        await this.#master.apply(id, { seat }, { kind: "move", move });
        return;
      } catch (error) {
        if (this.#abort.signal.aborted) return;
        if (error instanceof MatchError && !REFUSED.has(error.code)) {
          // The Match moved on or is gone: nothing left for this Engine to do.
          return;
        }
        console.error(
          `Engine ${player.engineId} failed in Match ${id} (attempt ${attempt}):`,
          error,
        );
        failure = error instanceof MatchError
          ? "illegal-move"
          : error instanceof SearchError
          ? error.code
          : "engine-error";
      }
    }
    if (this.#abort.signal.aborted) return;
    try {
      await this.#master.apply(id, { seat }, {
        kind: "forfeit",
        reason: failure,
      });
    } catch (error) {
      console.error(`Could not forfeit ${seat} in Match ${id}:`, error);
    }
  }
}

/** Referee refusals that blame the Engine's Move (rather than a stale Match). */
const REFUSED: ReadonlySet<string> = new Set(["invalid-move", "illegal-move"]);
