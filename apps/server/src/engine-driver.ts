import type { GameId, Seat } from "@boardwright/core";
import {
  type ForfeitReason,
  type GameMaster,
  MatchError,
  type MatchEvent,
} from "./game-master.ts";
import type { MatchId } from "./match-store.ts";
import type { EnginePlayer, Player } from "./players.ts";
import type { EngineEntry } from "./engines.ts";
import { EngineRunner, SearchError } from "./engine-runner.ts";

export interface EngineDriverOptions {
  /**
   * Runs the searches and owns their deadline, default time limit and
   * concurrency cap. Default: a new `EngineRunner` (Web Workers). Pass the
   * server's shared runner so that Matches and Analysis share one cap.
   */
  readonly runner?: EngineRunner;
  /** Searches per Move before the Seat forfeits (default 2: one retry). */
  readonly attempts?: number;
}

/** What the driver remembers of a running Match: its Game and Engine Seats. */
interface Seating {
  readonly gameId: GameId;
  /** Only the Seats whose Player is an Engine. */
  readonly engines: Readonly<Record<Seat, EnginePlayer>>;
}

/**
 * Plays the Engine Seats of a GameMaster's Matches. It remembers each
 * running Match's Engine Seats from its `created` event (or loads the Match
 * once, for Matches created before it subscribed) and, after every event
 * that leaves an Engine Seat to move, asks that Engine for a Move from the
 * event's Position through the {@link EngineRunner} (by default in a Web
 * Worker, so the server keeps answering requests), taking the first Move of
 * the best Line of the last Analysis that has one.
 * It plays the Move with `GameMaster.apply` as that Engine Seat, expecting
 * the event's version, i.e. through the same referee checks as human Moves;
 * if the Match moved on meanwhile (e.g. a Resignation), the Move is dropped.
 *
 * A search that errors, hangs past its deadline, proposes no Move or a Move
 * the referee refuses is retried with a fresh search; when the attempts are used up the
 * Game master imposes a Forfeit on the Seat (reason: a {@link ForfeitReason}
 * code, no raw error text), so a Match never hangs on a broken Engine.
 */
export class EngineDriver {
  readonly #master: GameMaster;
  readonly #attempts: number;
  readonly #runner: EngineRunner;
  readonly #running = new Set<Promise<void>>();
  readonly #abort = new AbortController();
  readonly #unsubscribe: () => void;
  /** Running Matches seen so far; dropped when they end. */
  readonly #seatings = new Map<MatchId, Seating>();

  constructor(master: GameMaster, options: EngineDriverOptions = {}) {
    this.#master = master;
    this.#attempts = options.attempts ?? 2;
    this.#runner = options.runner ?? new EngineRunner();
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

  #onEvent(event: MatchEvent): void {
    if (event.kind === "created") {
      this.#seatings.set(event.matchId, seating(event.gameId, event.seats));
    }
    if (event.outcome !== null) {
      this.#seatings.delete(event.matchId);
      return;
    }
    if (event.toMove === null) return;
    const task = this.#onTurn(event, event.toMove)
      .finally(() => this.#running.delete(task));
    this.#running.add(task);
  }

  async #onTurn(event: MatchEvent, seat: Seat): Promise<void> {
    let known = this.#seatings.get(event.matchId);
    if (!known) {
      // A Match created before this driver subscribed: load it once.
      try {
        const match = await this.#master.getMatch(event.matchId);
        if (match.outcome === null) {
          known = seating(match.gameId, match.seats);
          this.#seatings.set(event.matchId, known);
        }
        // The Match moved on while loading; its newer event is handled on its own.
        if (!known || match.version !== event.version) return;
      } catch (error) {
        console.error(`Could not load Match ${event.matchId}:`, error);
        return;
      }
    }
    const player = known.engines[seat];
    if (player) await this.#play(event, known.gameId, seat, player);
  }

  async #play(
    event: MatchEvent,
    gameId: GameId,
    seat: Seat,
    player: EnginePlayer,
  ): Promise<void> {
    const id = event.matchId;
    const expect = { expectedVersion: event.version };
    const entry = this.#master.engines.get(gameId, player.engineId);
    // Public failure reason; details only go to the server log.
    let failure: ForfeitReason = "not-registered";
    for (let attempt = 1; entry && attempt <= this.#attempts; attempt++) {
      try {
        const move = await this.#bestMove(entry, event.position, player);
        await this.#master.apply(
          id,
          { engineSeat: seat },
          { kind: "move", move },
          expect,
        );
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
        failure = forfeitReason(error);
      }
    }
    if (this.#abort.signal.aborted) return;
    try {
      await this.#master.apply(id, { gameMaster: true }, {
        kind: "forfeit",
        seat,
        reason: failure,
      }, expect);
    } catch (error) {
      console.error(`Could not forfeit ${seat} in Match ${id}:`, error);
    }
  }

  /** First Move of the best Line of the last Analysis that has one. */
  async #bestMove(
    engine: EngineEntry,
    position: string,
    player: EnginePlayer,
  ): Promise<string> {
    let best: string | undefined;
    const analyses = this.#runner.analyze(
      { engine, position, limits: player.limits },
      { signal: this.#abort.signal },
    );
    for await (const analysis of analyses) {
      best = analysis.lines[0]?.moves[0] ?? best;
    }
    if (best === undefined) {
      throw new SearchError("engine-error", "Engine proposed no Move");
    }
    return best;
  }
}

/** Referee refusals that blame the Engine's Move (rather than a stale Match). */
const REFUSED: ReadonlySet<string> = new Set(["invalid-move", "illegal-move"]);

function seating(
  gameId: GameId,
  seats: Readonly<Record<Seat, Player>>,
): Seating {
  const engines: Record<Seat, EnginePlayer> = {};
  for (const [seat, player] of Object.entries(seats)) {
    if (player.kind === "engine") engines[seat] = player;
  }
  return { gameId, engines };
}

/** The public Forfeit reason for an attempt that failed with `error`. */
function forfeitReason(error: unknown): ForfeitReason {
  if (error instanceof MatchError) return "illegal-move";
  // `aborted` only happens on close(), which never forfeits.
  if (error instanceof SearchError && error.code !== "aborted") {
    return error.code;
  }
  return "engine-error";
}
