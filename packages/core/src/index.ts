// Game-agnostic contracts. Vocabulary follows GLOSSARY.md; these shapes are a
// first draft and are expected to change once the first real Game exists.

/** Stable identifier of a Game, e.g. "chess", "nine-mens-morris". */
export type GameId = string;

/** One of the two sides of a Game that a Player occupies, e.g. "white" / "black". Not a person. */
export type Seat = string;

/**
 * What a Game's rules decide for a terminal Position: the winning Seat
 * (absent on a draw) and `reason`, a short code such as "three-in-a-row".
 * The Game master records it as an {@link Outcome} of kind `rules`.
 */
export interface RulesOutcome {
  readonly winner?: Seat;
  readonly reason: string;
}

/**
 * How a Match ended (GLOSSARY: Outcome), stating its kind:
 * - `rules`: the Game's rules ended it; `winner`/`reason` as in
 *   {@link RulesOutcome}.
 * - `resignation`: `seat` resigned; the Opponent is `winner`.
 * - `forfeit`: the Game master ended it because `seat` failed to play; the
 *   Opponent is `winner`. `reason` is a short code such as "timeout"; the
 *   set is open (the server defines the codes it uses).
 *
 * Every kind has `winner`, absent only on a draw by the rules, so a draw
 * check never needs the kind.
 */
export type Outcome =
  | {
    readonly kind: "rules";
    readonly winner?: Seat;
    readonly reason: string;
  }
  | {
    readonly kind: "resignation";
    readonly winner: Seat;
    readonly seat: Seat;
  }
  | {
    readonly kind: "forfeit";
    readonly winner: Seat;
    readonly seat: Seat;
    readonly reason: string;
  };

/**
 * The rules of one Game. Pure and deterministic: the server uses it to
 * referee Matches, engines use it to search. Positions and Moves are
 * opaque to everything except the Game itself and its Notation.
 *
 * A Game with chance implements {@link ChanceGameRules} instead (ADR 0005);
 * for a plain `GameRules`, no Seat to move means the Match is over.
 */
export interface GameRules<Position, Move> {
  readonly id: GameId;
  readonly name: string;
  readonly seats: readonly Seat[];
  initialPosition(): Position;
  /**
   * Seat to move, or `undefined` when the position is terminal (or, in a
   * {@link ChanceGameRules}, while a Chance event is pending).
   */
  toMove(position: Position): Seat | undefined;
  legalMoves(position: Position): readonly Move[];
  /** Throws if `move` is not legal in `position`; never mutates `position`. */
  play(position: Position, move: Move): Position;
  outcome(position: Position): RulesOutcome | undefined;
  readonly notation: Notation<Position, Move>;
  /**
   * Optional: whether `move` is the empty play (a `pass`: the Seat to move
   * has no legal play, such as backgammon's after a roll that cannot be
   * played). The Game master applies a pass automatically when it is the
   * Seat's only legal Move ({@link forcedPass}, ADR 0005 amendment). Omit it
   * in Games where a pass is a real choice or does not exist.
   */
  isPass?(move: Move): boolean;
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

/** One possible result of a pending Chance event and its probability. */
export interface ChanceResult<Chance> {
  readonly chance: Chance;
  /** In (0, 1]; the probabilities of one Chance event sum to 1. */
  readonly probability: number;
}

/**
 * The rules of a Game with chance, such as backgammon's dice (ADR 0005).
 * Besides "a Seat is to move" and "terminal", a Position may have a
 * **pending Chance event**: no Seat to move (`toMove` is `undefined`), no
 * Outcome and no legal Moves. Only the Game master resolves it, by drawing
 * one of `chanceEvents(position)` and applying it with `resolveChance`, so
 * the Game itself stays pure and deterministic. Chance results (`Chance`)
 * are a type of their own, not Moves, with their own Notation.
 *
 * Structurally every `ChanceGameRules` is also a `GameRules`; code that must
 * tell them apart uses {@link hasChance}.
 */
export interface ChanceGameRules<Position, Move, Chance>
  extends GameRules<Position, Move> {
  /**
   * The possible results of the Chance event pending in `position`, each
   * once and with its probability (they sum to 1); empty when no Chance
   * event is pending.
   */
  chanceEvents(position: Position): readonly ChanceResult<Chance>[];
  /**
   * The Position after `chance` happened. Throws if no Chance event is
   * pending or `chance` is not one of its results; never mutates `position`.
   */
  resolveChance(position: Position, chance: Chance): Position;
  readonly notation: ChanceNotation<Position, Move, Chance>;
}

/** {@link Notation} plus the text encoding of chance results. */
export interface ChanceNotation<Position, Move, Chance>
  extends Notation<Position, Move> {
  encodeChance(chance: Chance): string;
  /** Throws on invalid text. */
  decodeChance(text: string, position: Position): Chance;
}

/**
 * Whether `rules` is a Game with chance. Structural (no `instanceof`), so it
 * also works on rules loaded in another realm, e.g. a Worker.
 */
export function hasChance<Position, Move>(
  rules: GameRules<Position, Move>,
): rules is ChanceGameRules<Position, Move, unknown> {
  const r = rules as Partial<ChanceGameRules<Position, Move, unknown>>;
  return typeof r.chanceEvents === "function" &&
    typeof r.resolveChance === "function" &&
    typeof r.notation?.encodeChance === "function" &&
    typeof r.notation?.decodeChance === "function";
}

/**
 * Whether a Chance event is pending in `position`: no Seat to move and no
 * Outcome. Always `false` for a Game without chance.
 */
export function chancePending<Position, Move>(
  rules: GameRules<Position, Move>,
  position: Position,
): boolean {
  return hasChance(rules) && rules.toMove(position) === undefined &&
    rules.outcome(position) === undefined;
}

/**
 * The Move the Game master plays for the Seat to move because it is a forced
 * pass: the Game declares passes (`isPass`) and the Seat's only legal Move is
 * one. `undefined` otherwise (no Seat to move, a choice, or a non-empty Move).
 */
export function forcedPass<Position, Move>(
  rules: GameRules<Position, Move>,
  position: Position,
): Move | undefined {
  if (typeof rules.isPass !== "function") return undefined;
  if (rules.toMove(position) === undefined) return undefined;
  const moves = rules.legalMoves(position);
  return moves.length === 1 && rules.isPass(moves[0]!) ? moves[0] : undefined;
}

/**
 * The result a draw `u` in [0, 1) selects among `results`: the first whose
 * cumulative probability (summed in the given order) exceeds `u`, i.e.
 * `acc += probability; if (u < acc) return chance`; the last result if
 * rounding leaves `u` at or beyond the sum. `results` must not be empty.
 * The Game master draws Chance events this way, so its rolls can be
 * checked by anyone who knows the draws.
 */
export function pickChance<Chance>(
  results: readonly ChanceResult<Chance>[],
  u: number,
): Chance {
  let acc = 0;
  for (const { chance, probability } of results) {
    acc += probability;
    if (u < acc) return chance;
  }
  const last = results[results.length - 1];
  if (last === undefined) throw new RangeError("no chance results to pick");
  return last.chance;
}

/**
 * Engine evaluation from the perspective of a Seat: in a {@link Line}, the
 * Seat to move; for {@link Analysis.score}, the Analysis's `seat`.
 */
export type Score =
  | { readonly kind: "value"; readonly value: number }
  | { readonly kind: "win-in"; readonly plies: number }
  | { readonly kind: "loss-in"; readonly plies: number };

/**
 * A sequence of Moves an Engine expects from a Position, with its Score. A
 * Line ends at the next Chance event: its last Move may lead to a pending
 * Chance event, but no Move follows one.
 */
export interface Line<Move> {
  readonly moves: readonly Move[];
  readonly score: Score;
}

export interface Analysis<Move> {
  readonly depth: number;
  /** Best Lines first; empty while a Chance event is pending. */
  readonly lines: readonly Line<Move>[];
  /**
   * The expected Score of the Position, set while a Chance event is pending
   * (there are no Lines then), from the perspective of `seat`. Absent
   * otherwise: the Lines carry the Scores.
   */
  readonly score?: Score;
  /**
   * The Seat whose perspective `score` takes (no Seat is to move while a
   * Chance event is pending, so it is explicit). Present exactly when
   * `score` is; one of the Game's Seats.
   */
  readonly seat?: Seat;
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
   * - Yielded depths are integers >= 1 and strictly increasing.
   * - Every Analysis of a `position` with a Seat to move has between 1 and
   *   `limits.lines` (default 1) Lines. Every Line has at least one Move, its
   *   Moves are legal in sequence from `position`, and Lines start with
   *   distinct Moves, best first. No Move in a Line follows a pending
   *   Chance event.
   * - A Position with a pending Chance event (Games with chance only) has
   *   no Lines: every Analysis is `{ depth, lines: [], score, seat }` with
   *   the expected Score from `seat`'s perspective (same depth rules as
   *   above); `win-in`/`loss-in` only when forced whatever the dice. Other
   *   Analyses have neither `score` nor `seat`.
   * - A terminal `position` yields exactly one `{ depth: 0, lines: [] }`.
   * - Once `signal` aborts, the stream ends promptly (no bound on buffered
   *   Analyses already completed).
   * - Invalid `limits` throw a `RangeError` synchronously from `analyze`.
   * - `maxTimeMs` counts from the start of iteration (first `next()`).
   */
  analyze(
    position: Position,
    limits: SearchLimits,
    signal?: AbortSignal,
  ): AsyncIterable<Analysis<Move>>;
}
