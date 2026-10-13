import { type GameMaster, MatchError, type MatchView } from "./game-master.ts";
import { searchInWorker, type SearchRequest } from "./engine-search.ts";

export interface EngineDriverOptions {
  /**
   * Extra time beyond a Seat's `limits.maxTimeMs` before a search counts as
   * hung (covers worker start-up and the Engine's overshoot). Default 5000.
   */
  readonly graceMs?: number;
  /** Searches per Move before the Seat forfeits (default 2: one retry). */
  readonly attempts?: number;
  /** How a search runs; defaults to a Web Worker. Replaceable in tests. */
  readonly search?: typeof searchInWorker;
}

/**
 * Plays the Engine Seats of a GameMaster's Matches. After every Match change
 * where an Engine Seat is to move, it asks that Engine (in a Web Worker, so
 * the server keeps answering requests) and plays the Move through
 * `GameMaster.playAs`, i.e. through the same referee checks as human Moves.
 *
 * A search that errors, hangs past its deadline or returns a Move the referee
 * refuses is retried with a fresh worker; when the attempts are used up the
 * Seat forfeits (Outcome reason `engine-failure: ...`), so a Match never
 * hangs on a broken Engine.
 */
export class EngineDriver {
  readonly #master: GameMaster;
  readonly #graceMs: number;
  readonly #attempts: number;
  readonly #search: typeof searchInWorker;
  readonly #running = new Set<Promise<void>>();
  readonly #abort = new AbortController();
  readonly #unsubscribe: () => void;

  constructor(master: GameMaster, options: EngineDriverOptions = {}) {
    this.#master = master;
    this.#graceMs = options.graceMs ?? 5000;
    this.#attempts = options.attempts ?? 2;
    this.#search = options.search ?? searchInWorker;
    this.#unsubscribe = master.onMatchChanged((match) => this.#onChange(match));
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

  #onChange(match: MatchView): void {
    if (match.outcome || match.toMove === null) return;
    const player = match.seats[match.toMove];
    if (player?.kind !== "engine") return;
    const task = this.#play(match, match.toMove).finally(() =>
      this.#running.delete(task)
    );
    this.#running.add(task);
  }

  async #play(match: MatchView, seat: string): Promise<void> {
    const player = match.seats[seat];
    if (player?.kind !== "engine") return;
    const entry = this.#master.engines.get(match.gameId, player.engineId);
    let lastProblem = "no attempt made";
    for (let attempt = 1; attempt <= this.#attempts; attempt++) {
      if (this.#abort.signal.aborted) return;
      if (!entry) {
        lastProblem = "Engine is not registered";
        break;
      }
      const request: SearchRequest = {
        module: entry.module,
        position: match.position,
        limits: player.limits,
      };
      try {
        const move = await this.#search(request, {
          timeoutMs: (player.limits.maxTimeMs ?? 0) + this.#graceMs,
          signal: this.#abort.signal,
        });
        await this.#master.playAs(match.id, seat, move);
        return;
      } catch (error) {
        if (this.#abort.signal.aborted) return;
        if (error instanceof MatchError && !REFUSED.has(error.code)) {
          // The Match moved on or is gone: nothing left for this Engine to do.
          return;
        }
        lastProblem = error instanceof Error ? error.message : String(error);
      }
    }
    if (this.#abort.signal.aborted) return;
    const detail = lastProblem.length > 200
      ? `${lastProblem.slice(0, 200)}…`
      : lastProblem;
    const reason = `engine-failure: ${player.engineId} for ${seat}: ${detail}`;
    try {
      await this.#master.forfeit(match.id, seat, reason);
    } catch (error) {
      console.error(`Could not forfeit ${seat} in Match ${match.id}:`, error);
    }
  }
}

/** Referee refusals that blame the Engine's Move (rather than a stale Match). */
const REFUSED: ReadonlySet<string> = new Set(["invalid-move", "illegal-move"]);
