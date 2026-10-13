// Game-agnostic contracts. Vocabulary follows GLOSSARY.md; these shapes are a
// first draft and are expected to change once the first real Game exists.

/** Stable identifier of a Game, e.g. "chess", "nine-mens-morris". */
export type GameId = string;

/** One of the two sides of a Game that a Player occupies, e.g. "white" / "black". Not a person. */
export type Seat = string;

/** Result of a finished Match. `winner` is absent on a draw. */
export interface Outcome {
  readonly winner?: Seat;
  readonly reason: string;
}

/**
 * The rules of one Game. Pure and deterministic: the server uses it to
 * referee Matches, engines use it to search. Positions and Moves are
 * opaque to everything except the Game itself and its Notation.
 */
export interface GameRules<Position, Move> {
  readonly id: GameId;
  readonly name: string;
  readonly seats: readonly Seat[];
  initialPosition(): Position;
  /** Seat to move, or `undefined` when the position is terminal. */
  toMove(position: Position): Seat | undefined;
  legalMoves(position: Position): readonly Move[];
  /** Throws if `move` is not legal in `position`; never mutates `position`. */
  play(position: Position, move: Move): Position;
  outcome(position: Position): Outcome | undefined;
  readonly notation: Notation<Position, Move>;
}

/** Text encoding used on the wire and in stored Match records. */
export interface Notation<Position, Move> {
  encodePosition(position: Position): string;
  /** Throws on invalid text. */
  decodePosition(text: string): Position;
  encodeMove(move: Move): string;
  /** Throws on invalid text. */
  decodeMove(text: string, position: Position): Move;
}

/** Engine evaluation from the perspective of the Seat to move. */
export type Score =
  | { readonly kind: "value"; readonly value: number }
  | { readonly kind: "win-in"; readonly plies: number }
  | { readonly kind: "loss-in"; readonly plies: number };

/** A sequence of Moves an Engine expects from a Position, with its Score. */
export interface Line<Move> {
  readonly moves: readonly Move[];
  readonly score: Score;
}

export interface Analysis<Move> {
  readonly depth: number;
  /** Best Lines first. */
  readonly lines: readonly Line<Move>[];
}

export interface SearchLimits {
  /** Integer >= 1. */
  readonly maxDepth?: number;
  /** Milliseconds, >= 0. */
  readonly maxTimeMs?: number;
  /** Number of Lines to report (multi-PV), integer >= 1. Defaults to 1. */
  readonly lines?: number;
}

/** An AI that plays and analyzes one Game. */
export interface Engine<Position, Move> {
  readonly name: string;
  readonly gameId: GameId;
  /**
   * Streams progressively deeper Analysis until limits are hit or `signal`
   * aborts. Every Engine guarantees:
   * - At least one Analysis is yielded unless `signal` aborts before the
   *   first one completes (`maxTimeMs` alone never yields nothing).
   * - Only completed depths are yielded; an interrupted one is discarded.
   * - A terminal `position` yields exactly one `{ depth: 0, lines: [] }`.
   * - Invalid `limits` throw a `RangeError` synchronously from `analyze`.
   * - `maxTimeMs` counts from the start of iteration (first `next()`).
   */
  analyze(
    position: Position,
    limits: SearchLimits,
    signal?: AbortSignal,
  ): AsyncIterable<Analysis<Move>>;
}
