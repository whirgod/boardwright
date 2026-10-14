import type { GameId, Seat } from "@boardwright/core";
import {
  type ForfeitReason,
  type GameMaster,
  MatchError,
  type MatchEvent,
} from "./game-master.ts";
import type { MatchCursor, MatchId } from "./match-store.ts";
import type { EnginePlayer, Player } from "./players.ts";
import type { EngineEntry } from "./engines.ts";
import { type EngineRunner, SearchError } from "./engine-runner.ts";

export interface EngineDriverOptions {
  /**
   * The server's one runner (shared with Analysis requests, so the cap is
   * global): owns the deadline, default time limit, cap and queueing. The
   * driver's searches have purpose `match`, so they never queue behind
   * Analysis requests.
   */
  readonly runner: EngineRunner;
  /** Searches per Move before the Seat forfeits (default 2: one retry). */
  readonly attempts?: number;
  /**
   * How many Matches the driver remembers (default 1000); beyond that the
   * Match least recently seen taking a turn is forgotten and loaded again on its next
   * event. Bounds memory for Matches that are abandoned without an Outcome.
   */
  readonly maxMatches?: number;
  /**
   * While an Engine Seat's forced pass is not played yet, how often (ms,
   * default 30000, the Game master's roll cooldown) the driver asks the Game
   * master to try again (`getMatch` is its recovery trigger), so an unpolled
   * Engine-vs-Engine Match cannot stay stuck on a pass that failed to store.
   */
  readonly passRecheckMs?: number;
}

/** The part of a MatchEvent an Engine turn needs. */
type Turn = Pick<MatchEvent, "matchId" | "version" | "position">;

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
 * event's Position through the {@link EngineRunner} (in a Web Worker, so the
 * server keeps answering requests), taking the first Move of
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
  readonly #maxMatches: number;
  readonly #passRecheckMs: number;
  /**
   * Running Matches seen so far, least recently active first (Map order);
   * dropped when they end, and the oldest dropped beyond `maxMatches`.
   * Matches without Engine Seats are kept too, as an entry without Engines:
   * forgetting them would cost a load on each of their events.
   */
  readonly #seatings = new Map<MatchId, Seating>();
  /** Cache-miss loads in flight; `ended` is set when the Match finishes meanwhile. */
  readonly #loading = new Map<MatchId, Set<{ ended: boolean }>>();

  constructor(master: GameMaster, options: EngineDriverOptions) {
    this.#master = master;
    this.#attempts = options.attempts ?? 2;
    this.#runner = options.runner;
    const max = options.maxMatches ?? 1000;
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(`maxMatches must be a positive integer, got ${max}`);
    }
    this.#maxMatches = max;
    this.#passRecheckMs = options.passRecheckMs ?? 30_000;
    this.#unsubscribe = master.onMatchChanged((event) => this.#onEvent(event));
  }

  /** How many running Matches the driver remembers now (for tests and diagnostics). */
  get remembered(): number {
    return this.#seatings.size;
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
      this.#remember(event.matchId, seating(event.gameId, event.seats));
    }
    if (event.outcome !== null) {
      this.#seatings.delete(event.matchId);
      for (const load of this.#loading.get(event.matchId) ?? []) {
        load.ended = true;
      }
      return;
    }
    if (event.toMove === null) return;
    const task = this.#onTurn(event, event.toMove)
      .finally(() => this.#running.delete(task));
    this.#running.add(task);
  }

  /**
   * Start the Engine turns that no event will ever announce: after a
   * restart, every unfinished Match whose Seat to move is an Engine's would
   * wait forever. Pages through the running Matches of the store and plays
   * each such turn (not awaited; see {@link idle}). Returns how many turns it
   * started. Call once after construction. A Match that cannot be loaded
   * (e.g. of a Game no longer registered) is logged and skipped.
   */
  async resumeAll(): Promise<number> {
    let started = 0;
    let after: MatchCursor | undefined;
    do {
      const page = await this.#master.listMatches({
        finished: false,
        limit: 100,
        ...(after ? { after } : {}),
      });
      for (const summary of page.matches) {
        if (!Object.values(summary.seats).some((p) => p.kind === "engine")) {
          continue;
        }
        try {
          const match = await this.#master.getMatch(summary.id);
          const mover = match.toMove;
          if (mover === null || match.outcome !== null) continue;
          if (match.seats[mover]?.kind !== "engine") continue;
          const turn = {
            matchId: match.id,
            version: match.version,
            position: match.position,
          };
          const task = this.#onTurn(turn, mover)
            .finally(() => this.#running.delete(task));
          this.#running.add(task);
          started++;
        } catch (error) {
          console.error(`Could not resume Match ${summary.id}:`, error);
        }
      }
      after = page.next;
    } while (after);
    return started;
  }

  async #onTurn(event: Turn, seat: Seat): Promise<void> {
    let known = this.#seatings.get(event.matchId);
    if (known) {
      this.#remember(event.matchId, known); // most recently active
    } else {
      // A Match created before this driver subscribed, or forgotten: load it.
      const load = { ended: false };
      const loads = this.#loading.get(event.matchId) ?? new Set();
      loads.add(load);
      this.#loading.set(event.matchId, loads);
      try {
        const match = await this.#master.getMatch(event.matchId);
        // Cache only a Match still running: one that finished after the read
        // (`load.ended`, set by its event) must not be cached again.
        if (match.outcome === null && !load.ended) {
          known = seating(match.gameId, match.seats);
          this.#remember(event.matchId, known);
        }
        // The Match moved on while loading; its newer event is handled on its own.
        if (!known || match.version !== event.version) return;
      } catch (error) {
        console.error(`Could not load Match ${event.matchId}:`, error);
        return;
      } finally {
        loads.delete(load);
        if (loads.size === 0) this.#loading.delete(event.matchId);
      }
    }
    const player = known.engines[seat];
    // The Game master plays a forced pass itself; no Engine search for it.
    if (!player) return;
    if (this.#master.forcedPass(known.gameId, event.position)) {
      void this.#watchPass(event);
    } else {
      await this.#play(event, known.gameId, seat, player);
    }
  }

  /**
   * After a forced pass was left to the Game master: until the Match moves
   * on, ask for it every `passRecheckMs` (reading a Match with a stuck
   * pass makes the Game master retry it once its cooldown is over). Not
   * counted by {@link idle}; stops on close.
   */
  async #watchPass(turn: Turn): Promise<void> {
    while (!this.#abort.signal.aborted) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, this.#passRecheckMs);
        this.#abort.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve(undefined);
        }, { once: true });
      });
      if (this.#abort.signal.aborted) return;
      try {
        const match = await this.#master.getMatch(turn.matchId);
        if (match.version !== turn.version || match.outcome !== null) return;
      } catch (error) {
        console.error(`Could not check Match ${turn.matchId}:`, error);
        return;
      }
    }
  }

  /** Cache `seating` as the most recently active Match, evicting the oldest beyond the bound. */
  #remember(id: MatchId, seating: Seating): void {
    this.#seatings.delete(id);
    this.#seatings.set(id, seating);
    while (this.#seatings.size > this.#maxMatches) {
      this.#seatings.delete(this.#seatings.keys().next().value!);
    }
  }

  async #play(
    event: Turn,
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
      { signal: this.#abort.signal, purpose: "match" },
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
  // `aborted` only happens on close(), which never forfeits; `match` searches
  // are never refused as `busy`.
  if (
    error instanceof SearchError && error.code !== "aborted" &&
    error.code !== "busy"
  ) {
    return error.code;
  }
  return "engine-error";
}
