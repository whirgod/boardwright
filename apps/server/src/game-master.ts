import type { GameId, Outcome, Seat } from "@boardwright/core";
import { EngineRegistry } from "./engines.ts";
import type { AnyGameRules, GameRegistry } from "./games.ts";
import type {
  MatchId,
  MatchRecord,
  MatchStore,
  SeatRecord,
} from "./match-store.ts";
import { isTokenHolder, type PlayerSpec } from "./players.ts";
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
  | "not-server-driven"
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
  readonly seats: Readonly<Record<Seat, PlayerSpec>>;
  /** Moves in play order, in the Game's Notation. */
  readonly moves: readonly string[];
  /** Current Position in the Game's Notation. */
  readonly position: string;
  /** Seat to move, or `null` once the Match has an Outcome. */
  readonly toMove: Seat | null;
  /** Legal Moves for `toMove`, in the Game's Notation. */
  readonly legalMoves: readonly string[];
  readonly outcome: Outcome | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatedMatch {
  readonly match: MatchView;
  /** One secret seat token per Seat whose Player moves over the API. Shown only once. */
  readonly tokens: Readonly<Record<Seat, string>>;
}

/**
 * Called after a Match is created and after each accepted Move, with a frozen
 * copy of the Match. May be async; a rejection is logged, never propagated.
 */
export type MatchListener = (match: MatchView) => void | Promise<void>;

export interface GameMasterOptions {
  readonly games: GameRegistry;
  readonly store: MatchStore;
  /** Engines that may be seated; defaults to none. */
  readonly engines?: EngineRegistry;
  readonly now?: () => Date;
  readonly newMatchId?: () => MatchId;
}

/**
 * The referee (GLOSSARY: Game master). Creates Matches, holds their
 * authoritative Position and accepts only legal Moves from the Seat to move.
 * Independent of HTTP.
 */
export class GameMaster {
  readonly #games: GameRegistry;
  readonly #store: MatchStore;
  readonly #engines: EngineRegistry;
  readonly #now: () => Date;
  readonly #newMatchId: () => MatchId;
  readonly #listeners = new Set<MatchListener>();

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
    players: Readonly<Record<Seat, PlayerSpec>>,
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
      if (isTokenHolder(player)) {
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
    this.#notify(match);
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
   * Observe Match changes: `listener` runs after every create, accepted Move
   * and forfeit (e.g. to let an Engine Seat move or to push updates to
   * clients, #9). Listeners are started synchronously and not awaited; errors
   * they throw or reject with are logged, not propagated. Returns a function
   * that unsubscribes.
   */
  onMatchChanged(listener: MatchListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(match: MatchView): void {
    if (this.#listeners.size === 0) return;
    const frozen = deepFreeze(structuredClone(match));
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

  async getMatch(id: MatchId): Promise<MatchView> {
    const record = await this.#load(id);
    const { game, position } = this.#restore(record);
    return this.#view(record, game, position);
  }

  /** Play `move` (Notation) for the Seat that `token` belongs to. */
  async playMove(id: MatchId, move: string, token: string): Promise<MatchView> {
    const record = await this.#load(id);
    const seat = await this.#seatOf(record, token);
    return this.#play(record, seat, move);
  }

  /**
   * Play `move` (Notation) for `seat` without a token. Only for Seats whose
   * Player the server drives itself (Engines, #7); Seats of token-holding
   * Players are refused with `not-server-driven`. The same referee checks apply.
   */
  async playAs(id: MatchId, seat: Seat, move: string): Promise<MatchView> {
    const record = await this.#load(id);
    const seatRecord = Object.hasOwn(record.seats, seat)
      ? record.seats[seat]
      : undefined;
    if (!seatRecord || isTokenHolder(seatRecord.player)) {
      throw new MatchError(
        "not-server-driven",
        `Seat ${quote(seat)} is not played by the server`,
      );
    }
    return this.#play(record, seat, move);
  }

  /**
   * End the Match because the server-driven `seat` failed (e.g. its Engine
   * crashed): the other Seat wins when the Game has exactly two, else there
   * is no winner. `reason` becomes the Outcome's reason.
   */
  async forfeit(id: MatchId, seat: Seat, reason: string): Promise<MatchView> {
    const record = await this.#load(id);
    const seatRecord = Object.hasOwn(record.seats, seat)
      ? record.seats[seat]
      : undefined;
    if (!seatRecord || isTokenHolder(seatRecord.player)) {
      throw new MatchError(
        "not-server-driven",
        `Seat ${quote(seat)} is not played by the server`,
      );
    }
    const { game, position } = this.#restore(record);
    const toMove = game.toMove(position);
    if (record.outcome || toMove === undefined) {
      throw new MatchError("match-finished", "The Match is finished");
    }
    if (toMove !== seat) {
      throw new MatchError(
        "not-your-turn",
        `It is ${toMove}'s turn, not ${seat}'s`,
      );
    }
    const others = game.seats.filter((s) => s !== seat);
    const outcome: Outcome = {
      ...(others.length === 1 ? { winner: others[0]! } : {}),
      reason,
    };
    const updated: MatchRecord = {
      ...record,
      outcome,
      version: record.version + 1,
      updatedAt: this.#now().toISOString(),
    };
    if (!(await this.#store.update(updated))) {
      throw new MatchError(
        "conflict",
        "The Match changed meanwhile; fetch it and retry",
      );
    }
    const match = this.#view(updated, game, position);
    this.#notify(match);
    return match;
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

  async #seatOf(record: MatchRecord, token: string): Promise<Seat> {
    if (token !== "") {
      const hash = await hashToken(token);
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

  async #play(
    record: MatchRecord,
    seat: Seat,
    text: string,
  ): Promise<MatchView> {
    const { game, position } = this.#restore(record);
    const toMove = game.toMove(position);
    if (record.outcome || toMove === undefined) {
      throw new MatchError("match-finished", "The Match is finished");
    }
    if (toMove !== seat) {
      throw new MatchError(
        "not-your-turn",
        `It is ${toMove}'s turn, not ${seat}'s`,
      );
    }

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
      throw new MatchError(
        "illegal-move",
        `Move ${quote(text)} is not legal`,
      );
    }
    let next: unknown;
    try {
      next = game.play(position, move);
    } catch (error) {
      // legalMoves listed it, so the Game contradicts itself: a server fault.
      throw new Error(
        `Game ${game.id} refused its own legal Move ${quote(encoded)}`,
        { cause: error },
      );
    }

    const outcome = game.outcome(next);
    const { outcome: _previous, ...rest } = record;
    const updated: MatchRecord = {
      ...rest,
      moves: [...record.moves, encoded],
      ...(outcome ? { outcome } : {}),
      version: record.version + 1,
      updatedAt: this.#now().toISOString(),
    };
    if (!(await this.#store.update(updated))) {
      throw new MatchError(
        "conflict",
        "The Match changed meanwhile; fetch it and retry",
      );
    }
    const match = this.#view(updated, game, next);
    this.#notify(match);
    return match;
  }

  #view(record: MatchRecord, game: AnyGameRules, position: unknown): MatchView {
    const { notation } = game;
    const seats: Record<Seat, PlayerSpec> = {};
    for (const seat of game.seats) seats[seat] = record.seats[seat]!.player;
    // A stored Outcome (e.g. a forfeit) ends the Match whatever the Position says.
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
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
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
