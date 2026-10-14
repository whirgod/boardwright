import {
  chancePending,
  forcedPass,
  type GameId,
  hasChance,
  type Outcome,
  pickChance,
  type RulesOutcome,
  type Seat,
} from "@boardwright/core";
import { drawChance, newChanceSeed } from "./chance.ts";
import { EngineRegistry } from "./engines.ts";
import type { AnyGameRules, GameRegistry } from "./games.ts";
import type {
  MatchCursor,
  MatchId,
  MatchQuery,
  MatchRecord,
  MatchStore,
  MoveListEntry,
  SeatRecord,
} from "./match-store.ts";
import { type Player, usesSeatToken } from "./players.ts";
import { hashToken, newSeatToken, sameHash } from "./tokens.ts";

/** Why a Match operation was refused. The HTTP layer maps each code to a status. */
export type MatchErrorCode =
  | "unknown-game"
  | "unknown-match"
  | "invalid-seats"
  | "invalid-move"
  | "illegal-move"
  | "invalid-token"
  | "not-your-turn"
  | "chance-pending"
  | "not-engine-seat"
  | "match-finished"
  | "conflict";

export class MatchError extends Error {
  override readonly name = "MatchError";
  constructor(readonly code: MatchErrorCode, message: string) {
    super(message);
  }
}

/** A Match as clients see it: Notation strings only, no seat tokens. */
export interface MatchView {
  readonly id: MatchId;
  readonly gameId: GameId;
  /** Seats in the Game's order, each with its Player. */
  readonly seats: Readonly<Record<Seat, Player>>;
  /** The Move list: Moves and Chance events in play order, in the Game's Notation. */
  readonly moves: readonly MoveListEntry[];
  /** Current Position in the Game's Notation. */
  readonly position: string;
  /**
   * Seat to move, or `null` once the Match has an Outcome (or, briefly,
   * while a Chance event is pending).
   */
  readonly toMove: Seat | null;
  /** Legal Moves for `toMove`, in the Game's Notation. */
  readonly legalMoves: readonly string[];
  readonly outcome: Outcome | null;
  /**
   * The secret seed the Chance events were drawn from (see `chance.ts`),
   * revealed once the Match has an Outcome. Absent for Games without chance
   * and while the Match runs.
   */
  readonly seed?: string;
  /** 1 when created, +1 per change: the `version` of the last {@link MatchEvent}. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A Match in a listing: who plays and how it stands, without Positions,
 * Moves, seed or tokens (fetch the Match for those).
 */
export interface MatchSummary {
  readonly id: MatchId;
  readonly gameId: GameId;
  readonly seats: Readonly<Record<Seat, Player>>;
  /** Length of the Move list (Moves and Chance events). */
  readonly moveCount: number;
  readonly outcome: Outcome | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One page of {@link MatchSummary}, newest Match first. */
export interface MatchSummaries {
  readonly matches: readonly MatchSummary[];
  /** Pass as `after` for the next page; absent on the last page. */
  readonly next?: MatchCursor;
}

export interface CreatedMatch {
  readonly match: MatchView;
  /** One secret seat token per Seat whose Player moves over the API. Shown only once. */
  readonly tokens: Readonly<Record<Seat, string>>;
}

/**
 * Who asks for a Match change:
 * - `{ token }`: a human Player proving its Seat with its seat token.
 * - `{ engineSeat }`: the server playing for the Engine in that Seat; a Seat
 *   whose Player is not an Engine is refused with `not-engine-seat`.
 * - `{ gameMaster: true }`: the Game master itself, imposing a change on the
 *   Match (a Forfeit, a Chance event or a forced pass).
 */
export type Actor = PlayerActor | GameMasterActor;
export type PlayerActor =
  | { readonly token: string }
  | { readonly engineSeat: Seat };
export type GameMasterActor = { readonly gameMaster: true };

/**
 * Why the Game master imposes a Forfeit; stored as the Outcome's `reason`.
 * All current codes are Engine failures (details only go to the server log):
 * the search threw (`engine-error`), its Worker failed (`worker-error`) or
 * answered garbage (`unreadable-reply`), it ran past its deadline
 * (`timeout`), its Move was refused (`illegal-move`), or the server no longer
 * offers the Engine (`not-registered`).
 */
export type ForfeitReason =
  | "engine-error"
  | "worker-error"
  | "unreadable-reply"
  | "timeout"
  | "illegal-move"
  | "not-registered";

/**
 * A change a Player makes for its own Seat:
 * - `move`: play `move` (Notation); only the Seat to move, only legal Moves.
 * - `resignation`: concede, at any time; the Opponent wins.
 */
export type PlayerChange =
  | { readonly kind: "move"; readonly move: string }
  | { readonly kind: "resignation" };

/**
 * A change the Game master imposes:
 * - `forfeit`: `seat`, which is to move, failed to play; the Opponent wins.
 * - `chance`: resolve the pending Chance event (ADR 0005) with the next
 *   draw from the Match's secret seed. The Game master does this on its
 *   own right after every change that leaves one pending (and at creation)
 *   and recovers failed rolls itself (see `GameMaster.apply`); refused with
 *   `conflict` when nothing is pending.
 * - `pass`: play the Seat to move's only legal Move because it is the empty
 *   play (the Game declares it with `isPass`; ADR 0005 amendment). It is a
 *   `move` in the Move list and a `move` event; only the Actor differs. Done
 *   automatically right after the change that leaves a forced pass (like
 *   rolls); refused with `conflict` when the Seat to move has a choice.
 */
export type ImposedChange =
  | {
    readonly kind: "forfeit";
    readonly seat: Seat;
    readonly reason: ForfeitReason;
  }
  | { readonly kind: "chance" }
  | { readonly kind: "pass" };

export type MatchChange = PlayerChange | ImposedChange;

export interface ApplyOptions {
  /**
   * Refuse with `conflict` unless the Match is still at this version, e.g.
   * the version of the event or view a decision was based on.
   */
  readonly expectedVersion?: number;
}

/** Fields every {@link MatchEvent} has: the Match's state right after it. */
export interface MatchEventBase {
  readonly matchId: MatchId;
  /** The Match's version after this event: 1 for `created`, then +1 per event. */
  readonly version: number;
  /** When it happened (ISO 8601); the Match's `updatedAt`. */
  readonly at: string;
  /** Position after the event, in the Game's Notation. */
  readonly position: string;
  /** Seat to move after the event; `null` once the Match has an Outcome. */
  readonly toMove: Seat | null;
  /** Set by the event that ended the Match, else `null`. */
  readonly outcome: Outcome | null;
}

/**
 * What happened to a Match, one event per version. Kinds mirror
 * {@link MatchChange}, plus `created`. A Move that ends the Match by the
 * rules is one `move` event carrying the Outcome.
 */
export type MatchEvent =
  | MatchEventBase & {
    readonly kind: "created";
    readonly gameId: GameId;
    readonly seats: Readonly<Record<Seat, Player>>;
  }
  | MatchEventBase & {
    readonly kind: "move";
    readonly seat: Seat;
    /** The Move in canonical Notation, as appended to the Move list. */
    readonly move: string;
  }
  | MatchEventBase & { readonly kind: "resignation"; readonly seat: Seat }
  | MatchEventBase & {
    readonly kind: "forfeit";
    /** The Seat that forfeited. */
    readonly seat: Seat;
  }
  | MatchEventBase & {
    readonly kind: "chance";
    /** The Chance event's result in Notation, as appended to the Move list. */
    readonly chance: string;
  };

/**
 * Called with a frozen {@link MatchEvent} after every committed change. May
 * be async; a rejection is logged, never propagated.
 */
export type MatchListener = (event: MatchEvent) => void | Promise<void>;

export interface GameMasterOptions {
  readonly games: GameRegistry;
  readonly store: MatchStore;
  /** Engines that may be seated; defaults to none. */
  readonly engines?: EngineRegistry;
  readonly now?: () => Date;
  readonly newMatchId?: () => MatchId;
  /**
   * Source of each new Match's secret seed for Chance events (Games with
   * chance only); defaults to 256 random bits. Inject a fixed one in tests
   * for deterministic rolls.
   */
  readonly newSeed?: () => string;
  /**
   * Delays (ms) before retrying a failed roll, one retry per entry; default
   * `[100, 500, 2000]`. See `GameMaster.apply` for what retries after that.
   */
  readonly rollRetryDelaysMs?: readonly number[];
  /**
   * After a roll gave up, how long (ms) the recovery triggers (a refused
   * Move/Forfeit, `getMatch`) leave that Match alone; default 30000. Bounds
   * the retry cycles (and log lines) a permanent fault causes while clients
   * keep polling. An explicit `{ kind: "chance" }` ignores it.
   */
  readonly rollCooldownMs?: number;
  /**
   * Longest a {@link MatchStore} call may take (ms) before the Game master
   * treats it as failed; default 10000. A safety net for the store's duty to
   * settle (see `MatchStore`): without it, one hung call would block every
   * later change to its Match.
   */
  readonly storeTimeoutMs?: number;
}

/** What judging a change decided: the record's new contents and the event. */
interface Verdict {
  readonly moves: readonly MoveListEntry[];
  readonly outcome?: Outcome;
  readonly position: unknown;
  readonly event:
    | { readonly kind: "move"; readonly seat: Seat; readonly move: string }
    | { readonly kind: "resignation" | "forfeit"; readonly seat: Seat }
    | { readonly kind: "chance"; readonly chance: string };
}

const GAME_MASTER: GameMasterActor = { gameMaster: true };

/**
 * The referee (GLOSSARY: Game master). Creates Matches, holds their
 * authoritative Position and applies every change to a Match (Move,
 * Resignation, Forfeit) through one path: load, authorize the Actor, judge
 * the change against the rules, one versioned write, one event. Independent
 * of HTTP.
 */
export class GameMaster {
  readonly #games: GameRegistry;
  readonly #store: MatchStore;
  readonly #engines: EngineRegistry;
  readonly #now: () => Date;
  readonly #newMatchId: () => MatchId;
  readonly #newSeed: () => string;
  readonly #rollRetryDelaysMs: readonly number[];
  readonly #rollCooldownMs: number;
  /** Per Match whose roll gave up, when recovery triggers may try again (ms since epoch). */
  readonly #rollCooldowns = new Map<MatchId, number>();
  /** Matches with a recovery roll queued by `getMatch`. */
  readonly #healing = new Set<MatchId>();
  readonly #listeners = new Set<MatchListener>();
  /** Per Match, the tail of its queue of changes (see `#serialize`). */
  readonly #queues = new Map<MatchId, Promise<unknown>>();

  constructor(options: GameMasterOptions) {
    this.#games = options.games;
    this.#store = withTimeouts(options.store, options.storeTimeoutMs ?? 10_000);
    this.#engines = options.engines ?? new EngineRegistry();
    this.#now = options.now ?? (() => new Date());
    this.#newMatchId = options.newMatchId ?? (() => crypto.randomUUID());
    this.#newSeed = options.newSeed ?? newChanceSeed;
    this.#rollRetryDelaysMs = options.rollRetryDelaysMs ?? [100, 500, 2000];
    this.#rollCooldownMs = options.rollCooldownMs ?? 30_000;
  }

  /** Start a Match of `gameId` with one Player per Seat of the Game. */
  async createMatch(
    gameId: GameId,
    players: Readonly<Record<Seat, Player>>,
  ): Promise<CreatedMatch> {
    const game = this.#games.get(gameId);
    if (!game) {
      throw new MatchError(
        "unknown-game",
        `Unknown Game ${quote(gameId)}`,
      );
    }
    const missing = game.seats.filter((seat) => !Object.hasOwn(players, seat));
    const extra = Object.keys(players).filter((seat) =>
      !game.seats.includes(seat)
    );
    if (missing.length > 0 || extra.length > 0) {
      const problems = [
        ...(missing.length > 0
          ? [`missing Seat(s): ${missing.join(", ")}`]
          : []),
        ...(extra.length > 0 ? [`unknown Seat(s): ${extra.join(", ")}`] : []),
      ];
      throw new MatchError(
        "invalid-seats",
        `${problems.join("; ")} (${game.id} has Seats ${
          game.seats.join(", ")
        })`,
      );
    }

    for (const seat of game.seats) {
      const player = players[seat]!;
      if (
        player.kind === "engine" &&
        !this.#engines.get(gameId, player.engineId)
      ) {
        throw new MatchError(
          "invalid-seats",
          `Seat ${quote(seat)}: no Engine ${
            quote(player.engineId)
          } for ${game.id}`,
        );
      }
    }

    const seats: Record<Seat, SeatRecord> = {};
    const tokens: Record<Seat, string> = {};
    for (const seat of game.seats) {
      const player = players[seat]!;
      if (usesSeatToken(player)) {
        const token = newSeatToken();
        tokens[seat] = token;
        seats[seat] = { player, tokenHash: await hashToken(token) };
      } else {
        seats[seat] = { player };
      }
    }

    const now = this.#now().toISOString();
    const record: MatchRecord = {
      id: this.#newMatchId(),
      gameId,
      seats,
      moves: [],
      ...(hasChance(game) ? { seed: this.#newSeed() } : {}),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.create(record);
    const initial = game.initialPosition();
    const created = this.#view(record, game, initial);
    this.#notify({
      ...eventBase(created),
      kind: "created",
      gameId: created.gameId,
      seats: created.seats,
    });
    // E.g. backgammon's opening roll.
    const match = chancePending(game, initial)
      ? (await this.#serialize(
        record.id,
        () => this.#roll(record.id, created),
      )) ??
        created
      : created;
    return { match, tokens };
  }

  /** The Games this referee hosts. */
  get games(): GameRegistry {
    return this.#games;
  }

  /** The Engines that may be seated in Matches. */
  get engines(): EngineRegistry {
    return this.#engines;
  }

  /**
   * Observe Matches: `listener` receives exactly one {@link MatchEvent} per
   * committed create or change (e.g. to let an Engine Seat move or to push
   * updates to clients, #9), never one for a refused change.
   *
   * Ordering: changes to one Match are applied one at a time, and each event
   * is delivered right after its write, so the events of one Match arrive in
   * version order (1, 2, 3, ...) without gaps while subscribed. Events of
   * different Matches may interleave.
   *
   * To follow a Match from a snapshot: subscribe first, then `getMatch`
   * (version n), then apply only events with `version > n`; events up to n
   * are already in the snapshot. (Snapshot-then-subscribe can miss events.)
   *
   * Listeners are started synchronously and not awaited; errors they throw or
   * reject with are logged, not propagated. Returns a function that
   * unsubscribes.
   */
  onMatchChanged(listener: MatchListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * The Match as it is now. If it waits for a roll that failed earlier, this
   * also queues a new attempt (not awaited; see `apply`).
   */
  async getMatch(id: MatchId): Promise<MatchView> {
    const match = await this.#current(id);
    this.#healPending(match);
    return match;
  }

  /**
   * One page of Matches, newest first, optionally of one Game and/or only
   * finished (`true`) or running (`false`) ones. Reads the store only: no
   * replay, so Matches of Games that are no longer registered still list.
   */
  async listMatches(query: MatchQuery): Promise<MatchSummaries> {
    const page = await this.#store.list(query);
    return {
      matches: page.matches.map((record) => ({
        id: record.id,
        gameId: record.gameId,
        seats: Object.fromEntries(
          Object.entries(record.seats).map(([seat, s]) => [seat, s.player]),
        ),
        moveCount: record.moves.length,
        outcome: record.outcome ?? null,
        version: record.version,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })),
      ...(page.next ? { next: page.next } : {}),
    };
  }

  async #current(id: MatchId): Promise<MatchView> {
    const record = await this.#load(id);
    const { game, position } = this.#restore(record);
    return this.#view(record, game, position);
  }

  /**
   * Apply `change` to Match `id` and return the updated Match. A Player
   * (`{ token }` or `{ engineSeat }`) makes a {@link PlayerChange} for its
   * own Seat; the Game master (`{ gameMaster: true }`) imposes an
   * {@link ImposedChange}. Every change goes through the same guards, in
   * this order: the Match exists (`unknown-match`), it is still at
   * `options.expectedVersion` if given (`conflict`), the Player holds a Seat
   * (`invalid-token`, `not-engine-seat`), the Match is not finished
   * (`match-finished`), then the change's own rules (`chance-pending`, `not-your-turn`,
   * `invalid-move`, `illegal-move`). Then one versioned write (`conflict` if
   * another server process got there first) and one event to listeners.
   * Refusals change nothing and emit nothing. Changes to one Match are
   * applied one at a time, in call order.
   *
   * Chance events (ADR 0005): when a change (or `createMatch`) leaves a
   * Chance event pending, the Game master resolves it right away, before any
   * other change to the Match, as its own imposed `chance` change (one more
   * version and event), repeating while one is pending; the returned view is
   * the Match after those rolls. While one is pending, Moves and Forfeits
   * are refused with `chance-pending` (fetch the Match and retry). The n-th
   * Chance event of a Match is drawn from its secret seed (`drawChance`).
   *
   * A forced pass (see {@link ImposedChange}) chains the same way: after a
   * roll that leaves the Seat to move with only a pass (or after a Move), the
   * Game master plays it right away, then rolls again: roll, pass, roll. It
   * is a plain Move for the Seat, so a Player may legitimately play the
   * `pass` first (same Move, only the Actor differs); the Game master's own
   * attempt then finds nothing to do (`expectedVersion`/no forced pass). A
   * Move refused because a pass is still pending does not trigger recovery
   * (unlike `chance-pending`); a stuck pass is retried by `getMatch` (and
   * the EngineDriver's re-checks) once the cooldown is over.
   *
   * A roll or pass that fails (e.g. a store error) never fails the change before it.
   * It is retried after each delay of `rollRetryDelaysMs`, inside the
   * Match's queue; if all fail, the roll is tried again on the next trigger
   * after the cooldown:
   * a Move or Forfeit refused with `chance-pending`, or any `getMatch` of the
   * Match (e.g. a polling client), but not within `rollCooldownMs` of the
   * last give-up: a permanent fault costs one retry cycle per cooldown, not
   * one per request. An explicit `{ kind: "chance" }` from the
   * Game master also rolls; it is refused with `conflict` when nothing is
   * pending.
   *
   * Do not await `apply` for a Match from inside a change to that same Match
   * (a listener that waits for its own follow-up change, a store call): the
   * new change queues behind the running one, which waits for it, and the
   * Match's queue deadlocks. Start it without awaiting (listeners are not
   * awaited anyway), or from a task outside the queue, as the EngineDriver
   * does. Store calls must settle; see `MatchStore` and `storeTimeoutMs`.
   */
  apply(
    id: MatchId,
    actor: PlayerActor,
    change: PlayerChange,
    options?: ApplyOptions,
  ): Promise<MatchView>;
  apply(
    id: MatchId,
    actor: GameMasterActor,
    change: ImposedChange,
    options?: ApplyOptions,
  ): Promise<MatchView>;
  apply(
    id: MatchId,
    actor: Actor,
    change: MatchChange,
    options: ApplyOptions = {},
  ): Promise<MatchView> {
    return this.#serialize(id, () => this.#apply(id, actor, change, options));
  }

  /**
   * Run `task` after every earlier task for Match `id` has settled. Tasks
   * must not await another task of the same Match (deadlock, see `apply`).
   */
  #serialize<T>(id: MatchId, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(() => {}, () => {});
    this.#queues.set(id, tail);
    void tail.then(() => {
      if (this.#queues.get(id) === tail) this.#queues.delete(id);
    });
    return run;
  }

  async #apply(
    id: MatchId,
    actor: Actor,
    change: MatchChange,
    options: ApplyOptions,
  ): Promise<MatchView> {
    let match: MatchView;
    try {
      match = await this.#applyOne(id, actor, change, options);
    } catch (error) {
      // Recovery trigger: a change refused because a roll is still pending
      // (an earlier roll failed) makes the Game master try it again now.
      if (error instanceof MatchError && error.code === "chance-pending") {
        await this.#roll(id, undefined, true);
      }
      throw error;
    }
    return (await this.#roll(id, match)) ?? match;
  }

  /**
   * Make the Game master's own changes while one is due in the Match
   * (`match`, its latest view, or loaded): a pending Chance event's roll or a
   * forced pass, each as its own imposed change, so a roll, a pass and the
   * next roll chain. Runs inside
   * the Match's queue. A failed roll is retried after each delay of
   * `rollRetryDelaysMs`, then given up until the next trigger (a refused
   * Move/Forfeit or a `getMatch`) after `rollCooldownMs`. `recovery` marks
   * such a trigger: it does nothing during the cooldown. Never throws: the
   * change that led here is already committed.
   */
  async #roll(
    id: MatchId,
    match?: MatchView,
    recovery = false,
  ): Promise<MatchView | undefined> {
    if (recovery && this.#coolingDown(id)) return match;
    let last = match;
    let current = match;
    let failures = 0;
    let next: "chance" | "pass" | undefined;
    for (;;) {
      try {
        current ??= await this.#current(id);
        last = current;
        next = this.#automatic(current);
        if (next === undefined) {
          this.#rollCooldowns.delete(id);
          return last;
        }
        current = await this.#applyOne(id, GAME_MASTER, { kind: next }, {
          expectedVersion: current.version,
        });
        last = current;
        failures = 0;
      } catch (error) {
        const delay = this.#rollRetryDelaysMs[failures++];
        console.error(
          `Could not apply the ${
            next ?? "automatic change"
          } in Match ${id} (attempt ${failures}${
            delay === undefined ? ", giving up until the next trigger" : ""
          }):`,
          error,
        );
        if (delay === undefined) {
          const now = this.#now().getTime();
          // Prune expired entries so abandoned Matches cannot accumulate.
          for (const [other, until] of this.#rollCooldowns) {
            if (until <= now) this.#rollCooldowns.delete(other);
          }
          this.#rollCooldowns.set(id, now + this.#rollCooldownMs);
          return last;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        current = undefined; // reload: the Match may have changed meanwhile
      }
    }
  }

  /**
   * The change the Game master makes on its own in `match`: the pending
   * Chance event's roll, or the Seat to move's forced pass; `undefined` when
   * the Match waits for a Player (or is over).
   */
  #automatic(match: MatchView): "chance" | "pass" | undefined {
    if (match.outcome !== null) return undefined;
    if (match.toMove === null) return "chance";
    return this.forcedPass(match.gameId, match.position) ? "pass" : undefined;
  }

  /**
   * Whether the Seat to move in `position` (Notation) of `gameId` has only a
   * pass to play, which the Game master plays itself (see `ImposedChange`).
   * Players and the EngineDriver need not (and must not) act then. `false`
   * for unknown Games and unreadable Positions.
   */
  forcedPass(gameId: GameId, position: string): boolean {
    const game = this.#games.get(gameId);
    if (!game || typeof game.isPass !== "function") return false;
    try {
      return forcedPass(game, game.notation.decodePosition(position)) !==
        undefined;
    } catch {
      return false;
    }
  }

  #coolingDown(id: MatchId): boolean {
    const until = this.#rollCooldowns.get(id);
    if (until === undefined) return false;
    if (this.#now().getTime() < until) return true;
    this.#rollCooldowns.delete(id);
    return false;
  }

  /**
   * Recovery trigger for reads: if `match` waits for a roll and none is
   * queued for it, queue one (not awaited).
   */
  #healPending(match: MatchView): void {
    if (this.#automatic(match) === undefined) return;
    if (this.#healing.has(match.id) || this.#coolingDown(match.id)) return;
    this.#healing.add(match.id);
    void this.#serialize(match.id, () => this.#roll(match.id, undefined, true))
      .finally(() => this.#healing.delete(match.id));
  }

  async #applyOne(
    id: MatchId,
    actor: Actor,
    change: MatchChange,
    { expectedVersion }: ApplyOptions,
  ): Promise<MatchView> {
    const record = await this.#load(id);
    if (expectedVersion !== undefined && record.version !== expectedVersion) {
      throw new MatchError(
        "conflict",
        `The Match is at version ${record.version}, not ${expectedVersion}`,
      );
    }
    const imposed = change.kind === "forfeit" || change.kind === "chance" ||
      change.kind === "pass";
    if (imposed !== "gameMaster" in actor) {
      // The overloads rule this out; reaching it is a server bug.
      throw new TypeError(
        `A ${change.kind} cannot be made by ${JSON.stringify(actor)}`,
      );
    }
    const seat = "gameMaster" in actor
      ? undefined
      : await this.#seatOf(record, actor);
    const { game, position } = this.#restore(record);
    if (record.outcome || game.outcome(position) !== undefined) {
      throw new MatchError("match-finished", "The Match is finished");
    }
    const draw = change.kind === "chance"
      ? await this.#draw(record, game, position)
      : undefined;
    const verdict = judge(game, record, position, change, seat, draw);

    const { outcome: _previous, ...rest } = record;
    const updated: MatchRecord = {
      ...rest,
      moves: verdict.moves,
      ...(verdict.outcome ? { outcome: verdict.outcome } : {}),
      version: record.version + 1,
      updatedAt: this.#now().toISOString(),
    };
    if (!(await this.#store.update(updated))) {
      throw new MatchError(
        "conflict",
        "The Match changed meanwhile; fetch it and retry",
      );
    }
    const match = this.#view(updated, game, verdict.position);
    this.#notify({ ...eventBase(match), ...verdict.event });
    return match;
  }

  /**
   * The result of the Match's next Chance event: the n-th draw from its
   * seed, n counting the Chance events already in the Move list. Refuses
   * with `conflict` when no Chance event is pending.
   */
  async #draw(
    record: MatchRecord,
    game: AnyGameRules,
    position: unknown,
  ): Promise<unknown> {
    if (!hasChance(game) || !chancePending(game, position)) {
      throw new MatchError("conflict", "No Chance event is pending");
    }
    if (record.seed === undefined) {
      throw new Error(`Match ${record.id} has no seed to draw Chance events`);
    }
    const n = record.moves.filter((entry) => entry.kind === "chance").length;
    const results = game.chanceEvents(position);
    return pickChance(results, await drawChance(record.seed, n));
  }

  #notify(event: MatchEvent): void {
    if (this.#listeners.size === 0) return;
    const frozen = deepFreeze(structuredClone(event));
    const report = (error: unknown) =>
      console.error("Match listener failed:", error);
    for (const listener of this.#listeners) {
      try {
        Promise.resolve(listener(frozen)).catch(report);
      } catch (error) {
        report(error);
      }
    }
  }

  async #load(id: MatchId): Promise<MatchRecord> {
    const record = await this.#store.get(id);
    if (!record) {
      throw new MatchError(
        "unknown-match",
        `Unknown Match ${quote(id)}`,
      );
    }
    return record;
  }

  /** The Seat a Player acts for, or a refusal. */
  async #seatOf(record: MatchRecord, actor: PlayerActor): Promise<Seat> {
    if ("engineSeat" in actor) {
      const seat = actor.engineSeat;
      const seatRecord = Object.hasOwn(record.seats, seat)
        ? record.seats[seat]
        : undefined;
      if (seatRecord?.player.kind !== "engine") {
        throw new MatchError(
          "not-engine-seat",
          `Seat ${quote(seat)} is not played by an Engine`,
        );
      }
      return seat;
    }
    if (actor.token !== "") {
      const hash = await hashToken(actor.token);
      let found: Seat | undefined;
      // Check every Seat, in constant time per comparison.
      for (const [seat, { tokenHash }] of Object.entries(record.seats)) {
        if (tokenHash !== undefined && sameHash(tokenHash, hash)) found = seat;
      }
      if (found !== undefined) return found;
    }
    throw new MatchError(
      "invalid-token",
      "Seat token does not match any Seat of this Match",
    );
  }

  /** Rebuild the current Position by replaying the Move list (Moves and Chance events). */
  #restore(record: MatchRecord): { game: AnyGameRules; position: unknown } {
    const game = this.#games.get(record.gameId);
    if (!game) {
      throw new Error(
        `Match ${record.id} is of Game ${
          JSON.stringify(record.gameId)
        }, which is not registered`,
      );
    }
    let position = game.initialPosition();
    for (const entry of record.moves) {
      if (entry.kind === "move") {
        const move = game.notation.decodeMove(entry.move, position);
        position = game.play(position, move);
      } else if (hasChance(game)) {
        const chance = game.notation.decodeChance(entry.chance, position);
        position = game.resolveChance(position, chance);
      } else {
        throw new Error(
          `Match ${record.id} has a Chance event, but ${game.id} has no chance`,
        );
      }
    }
    return { game, position };
  }

  #view(record: MatchRecord, game: AnyGameRules, position: unknown): MatchView {
    const { notation } = game;
    const seats: Record<Seat, Player> = {};
    for (const seat of game.seats) seats[seat] = record.seats[seat]!.player;
    // A stored Outcome (e.g. a Forfeit) ends the Match whatever the Position says.
    const finished = record.outcome !== undefined;
    return {
      id: record.id,
      gameId: record.gameId,
      seats,
      moves: record.moves,
      position: notation.encodePosition(position),
      toMove: finished ? null : game.toMove(position) ?? null,
      legalMoves: finished
        ? []
        : game.legalMoves(position).map((m) => notation.encodeMove(m)),
      outcome: record.outcome ?? null,
      // Secret until the Match is over (ADR 0005).
      ...(finished && record.seed !== undefined ? { seed: record.seed } : {}),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}

/**
 * Decide a change to a running Match: pure, no I/O. `player` is the Seat of
 * the Player making a {@link PlayerChange}, `undefined` for an imposed one;
 * `drawn` is the Chance event's result for a `chance` change (see `#draw`).
 * Throws a `MatchError` to refuse it.
 */
function judge(
  game: AnyGameRules,
  record: MatchRecord,
  position: unknown,
  change: MatchChange,
  player: Seat | undefined,
  drawn: unknown,
): Verdict {
  switch (change.kind) {
    case "move": {
      const seat = player!;
      requireTurn(game, position, seat);
      const { move, next } = playLegal(game, position, change.move);
      const outcome = game.outcome(next);
      return {
        moves: [...record.moves, { kind: "move", move }],
        ...(outcome ? { outcome: byTheRules(outcome) } : {}),
        position: next,
        event: { kind: "move", seat, move },
      };
    }
    case "resignation": {
      const seat = player!;
      return {
        moves: record.moves,
        outcome: { kind: "resignation", winner: opponent(game, seat), seat },
        position,
        event: { kind: "resignation", seat },
      };
    }
    case "forfeit": {
      const { seat, reason } = change;
      requireTurn(game, position, seat);
      return {
        moves: record.moves,
        outcome: {
          kind: "forfeit",
          winner: opponent(game, seat),
          seat,
          reason,
        },
        position,
        event: { kind: "forfeit", seat },
      };
    }
    case "pass": {
      const forced = forcedPass(game, position);
      if (forced === undefined) {
        throw new MatchError("conflict", "No forced pass is pending");
      }
      const seat = game.toMove(position)!;
      const next = game.play(position, forced);
      const move = game.notation.encodeMove(forced);
      const outcome = game.outcome(next);
      return {
        moves: [...record.moves, { kind: "move", move }],
        ...(outcome ? { outcome: byTheRules(outcome) } : {}),
        position: next,
        event: { kind: "move", seat, move },
      };
    }
    case "chance": {
      if (!hasChance(game)) {
        throw new TypeError(`${game.id} has no Chance events`); // #draw refuses first
      }
      const next = game.resolveChance(position, drawn);
      const chance = game.notation.encodeChance(drawn);
      const outcome = game.outcome(next);
      return {
        moves: [...record.moves, { kind: "chance", chance }],
        ...(outcome ? { outcome: byTheRules(outcome) } : {}),
        position: next,
        event: { kind: "chance", chance },
      };
    }
  }
}

/**
 * `store` with every call bounded by `ms`: a call that has not settled by
 * then rejects (its write, if any, may still land later; the next change
 * reloads the Match, so a late write is picked up as a newer version). A
 * write that lands late emits no MatchEvent: listeners (clients, the
 * EngineDriver) never see that version, only the next event after it.
 */
function withTimeouts(store: MatchStore, ms: number): MatchStore {
  const bounded = <T>(what: string, call: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`MatchStore.${what} did not settle in ${ms} ms`)),
        ms,
      );
    });
    return Promise.race([call(), timeout]).finally(() => clearTimeout(timer));
  };
  return {
    create: (record) => bounded("create", () => store.create(record)),
    get: (id) => bounded("get", () => store.get(id)),
    update: (record) => bounded("update", () => store.update(record)),
    list: (query) => bounded("list", () => store.list(query)),
  };
}

/** The Outcome to record for a Game's verdict: only the known fields. */
function byTheRules(outcome: RulesOutcome): Outcome {
  return {
    kind: "rules",
    ...(outcome.winner !== undefined ? { winner: outcome.winner } : {}),
    reason: outcome.reason,
  };
}

function requireTurn(game: AnyGameRules, position: unknown, seat: Seat): void {
  const toMove = game.toMove(position);
  if (toMove === undefined) {
    // The Match is not over, so a Chance event is pending.
    throw new MatchError(
      "chance-pending",
      "A Chance event is pending; the Game master is to act",
    );
  }
  if (toMove !== seat) {
    throw new MatchError(
      "not-your-turn",
      `It is ${toMove}'s turn, not ${seat}'s`,
    );
  }
}

/** Decode `text` and play it if legal: the canonical Move and the next Position. */
function playLegal(
  game: AnyGameRules,
  position: unknown,
  text: string,
): { move: string; next: unknown } {
  const { notation } = game;
  let move: unknown;
  try {
    move = notation.decodeMove(text, position);
  } catch (error) {
    throw new MatchError(
      "invalid-move",
      `Cannot read Move ${quote(text)}: ${truncate(message(error), 200)}`,
    );
  }
  // Compare in Notation: Moves are opaque and may not be comparable with ===.
  const encoded = notation.encodeMove(move);
  if (
    !game.legalMoves(position).some((m) => notation.encodeMove(m) === encoded)
  ) {
    throw new MatchError("illegal-move", `Move ${quote(text)} is not legal`);
  }
  try {
    return { move: encoded, next: game.play(position, move) };
  } catch (error) {
    // legalMoves listed it, so the Game contradicts itself: a server fault.
    throw new Error(
      `Game ${game.id} refused its own legal Move ${quote(encoded)}`,
      { cause: error },
    );
  }
}

/** The other Seat; every Game has exactly two (ADR 0003). */
function opponent(game: AnyGameRules, seat: Seat): Seat {
  return game.seats.find((s) => s !== seat)!;
}

function eventBase(match: MatchView): MatchEventBase {
  return {
    matchId: match.id,
    version: match.version,
    at: match.updatedAt,
    position: match.position,
    toMove: match.toMove,
    outcome: match.outcome,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Client-supplied text for an error message: quoted and capped in length. */
export function quote(text: string, max = 40): string {
  return JSON.stringify(truncate(text, max));
}
