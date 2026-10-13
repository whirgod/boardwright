// Game-agnostic contracts. Vocabulary follows GLOSSARY.md; these shapes are a
// first draft and are expected to change once the first real Game exists.

/** Stable identifier of a Game, e.g. "chess", "nine-mens-morris". */
export type GameId = string;

/** A participant slot in a Game, e.g. "white" / "black". Not a person. */
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
  play(position: Position, move: Move): Position;
  outcome(position: Position): Outcome | undefined;
  readonly notation: Notation<Position, Move>;
}

/** Text encoding used on the wire and in stored Match records. */
export interface Notation<Position, Move> {
  encodePosition(position: Position): string;
  decodePosition(text: string): Position;
  encodeMove(move: Move): string;
  decodeMove(text: string, position: Position): Move;
}

/** Engine evaluation from the perspective of the Seat to move. */
export type Score =
  | { readonly kind: "value"; readonly value: number }
  | { readonly kind: "win-in"; readonly plies: number }
  | { readonly kind: "loss-in"; readonly plies: number };

/** A principal variation: a sequence of Moves the Engine expects. */
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
  readonly maxDepth?: number;
  readonly maxTimeMs?: number;
  /** Number of Lines to report (multi-PV). Defaults to 1. */
  readonly lines?: number;
}

/** An AI that plays and analyzes one Game. */
export interface Engine<Position, Move> {
  readonly name: string;
  readonly gameId: GameId;
  /** Streams progressively deeper Analysis until limits are hit or `signal` aborts. */
  analyze(
    position: Position,
    limits: SearchLimits,
    signal?: AbortSignal,
  ): AsyncIterable<Analysis<Move>>;
}
