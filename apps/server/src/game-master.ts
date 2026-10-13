import type { GameId, Outcome, RulesOutcome, Seat } from "@boardwright/core";
import { EngineRegistry } from "./engines.ts";
import type { AnyGameRules, GameRegistry } from "./games.ts";
import type {
  MatchId,
  MatchRecord,
  MatchStore,
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
  /** Moves in play order, in the Game's Notation. */
  readonly moves: readonly string[];
  /** Current Position in the Game's Notation. */
  readonly position: string;
  /** Seat to move, or `null` once the Match has an Outcome. */
  readonly toMove: Seat | null;
  /** Legal Moves for `toMove`, in the Game's Notation. */
  readonly legalMoves: readonly string[];
  readonly outcome: Outcome | null;
  /** 1 when created, +1 per change: the `version` of the last {@link MatchEvent}. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
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
 *   Match (a Forfeit now, a Chance event later).
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
 */
export type ImposedChange = {
  readonly kind: "forfeit";
  readonly seat: Seat;
  readonly reason: ForfeitReason;
};

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
}

/** What judging a change decided: the record's new contents and the event. */
interface Verdict {
  readonly moves: readonly string[];
  readonly outcome?: Outcome;
  readonly position: unknown;
  readonly event:
    | { readonly kind: "move"; readonly seat: Seat; readonly move: string }
    | { readonly kind: "resignation" | "forfeit"; readonly seat: Seat };
}

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
  readonly #listeners = new Set<MatchListener>();
  /** Per Match, the tail of its queue of changes (see `#serialize`). */
  readonly #queues = new Map<MatchId, Promise<unknown>>();

  constructor(options: GameMasterOptions) {
    this.#games = options.games;
    this.#store = options.store;
    this.#engines = options.engines ?? new EngineRegistry();
    this.#now = options.now ?? (() => new Date());
    this.#newMatchId = options.newMatchId ?? (() => crypto.randomUUID());
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
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.create(record);
    const match = this.#view(record, game, game.initialPosition());
    this.#notify({
      ...eventBase(match),
      kind: "created",
      gameId: match.gameId,
      seats: match.seats,
    });
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

  async getMatch(id: MatchId): Promise<MatchView> {
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
   * (`match-finished`), then the change's own rules (`not-your-turn`,
   * `invalid-move`, `illegal-move`). Then one versioned write (`conflict` if
   * another server process got there first) and one event to listeners.
   * Refusals change nothing and emit nothing. Changes to one Match are
   * applied one at a time, in call order.
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

  /** Run `task` after every earlier task for Match `id` has settled. */
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
    { expectedVersion }: ApplyOptions,
  ): Promise<MatchView> {
    const record = await this.#load(id);
    if (expectedVersion !== undefined && record.version !== expectedVersion) {
      throw new MatchError(
        "conflict",
        `The Match is at version ${record.version}, not ${expectedVersion}`,
      );
    }
    const imposed = change.kind === "forfeit";
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
    if (record.outcome || game.toMove(position) === undefined) {
      throw new MatchError("match-finished", "The Match is finished");
    }
    const verdict = judge(game, record, position, change, seat);

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

  /** Rebuild the current Position by replaying the Move list. */
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
    for (const text of record.moves) {
      position = game.play(position, game.notation.decodeMove(text, position));
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
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}

/**
 * Decide a change to a running Match: pure, no I/O. `player` is the Seat of
 * the Player making a {@link PlayerChange}, `undefined` for an imposed one.
 * Throws a `MatchError` to refuse it.
 */
function judge(
  game: AnyGameRules,
  record: MatchRecord,
  position: unknown,
  change: MatchChange,
  player: Seat | undefined,
): Verdict {
  switch (change.kind) {
    case "move": {
      const seat = player!;
      requireTurn(game, position, seat);
      const { move, next } = playLegal(game, position, change.move);
      const outcome = game.outcome(next);
      return {
        moves: [...record.moves, move],
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
  }
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
