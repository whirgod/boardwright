/**
 * Quiescence search: what minimax does at the depth horizon instead of
 * evaluating a Position as it stands.
 *
 * A search to a fixed depth evaluates the Positions at its horizon as they
 * stand. If the last Move was a capture, the evaluation does not see the
 * recapture: a depth-4 search may win a pawn with its queen on ply 4 because
 * the reply that wins the queen lies past the horizon (the horizon effect).
 * Quiescence search goes on past the horizon with the tactical Moves only,
 * until the Position is quiet, and evaluates only quiet Positions:
 *
 * - **Stand pat**: the Seat to move may decline every tactical Move and play
 *   a quiet one, which it is assumed not to lose by, so the evaluation is a
 *   lower bound on its score. It fails high if it reaches beta, and raises
 *   alpha otherwise.
 * - Then the tactical Moves are searched, recursively and with alpha-beta.
 * - Some Positions are not quiet whatever the Seat to move does: in chess a
 *   Seat in check must answer the check, in checkers a Seat that can capture
 *   must capture. There the Engine refuses stand pat, and every legal Move
 *   is searched.
 * - Tactical sequences end (captures use up material), but may be long, so
 *   a cap ({@link Quiescence.maxPlies}) bounds them: a Position that many
 *   plies past the horizon is evaluated as it stands.
 *
 * The search itself lives in `mod.ts` (`quiesce`); this module has the
 * Engine-supplied option and picks the Moves a quiescence node searches.
 */
import { NO_MOVES } from "@boardwright/engine-search";
import { type MovePriority, orderMoves } from "./ordering.ts";

/** Engine-supplied quiescence search; see `MinimaxOptions.quiescence`. */
export interface Quiescence<Position, Move> {
  /**
   * Whether the Seat to move in `position` may stand pat: decline every
   * tactical Move and take `evaluate(position)` as a lower bound on its
   * score. Return false where the Position is not quiet whatever that Seat
   * does (in chess when it is in check, in checkers when a capture is
   * compulsory): then every legal Move is searched and the evaluation is not
   * used. Called once per quiescence node (a non-terminal Position at or
   * past the horizon, below the cap), so keep it cheap.
   */
  readonly standPat: (position: Position) => boolean;
  /**
   * Whether `move` is tactical in `position`: searched where standing pat is
   * allowed. Default: the Moves that `movePriority` ranks above 0 (the
   * convention in `ordering.ts`: captures, promotions), or none without a
   * `movePriority` (then quiescence searches only the Positions where
   * standing pat is refused).
   */
  readonly tactical?: (position: Position, move: Move) => boolean;
  /**
   * The cap: most plies searched past the horizon, an integer >= 0 (default
   * {@link DEFAULT_QUIESCENCE_PLIES}). A Position this many plies past it is
   * evaluated as it stands, even where standing pat is refused. 0 evaluates
   * at the horizon, as a search without quiescence does.
   */
  readonly maxPlies?: number;
}

/**
 * Default cap on quiescence plies. Chess capture sequences rarely run
 * longer; the cap is there for cost, and for Games whose tactical Moves do
 * not use anything up.
 */
export const DEFAULT_QUIESCENCE_PLIES = 16;

/** Checks the options of a quiescence search; a RangeError if invalid. */
export function checkQuiescence<Position, Move>(
  quiescence: Quiescence<Position, Move>,
): void {
  const { maxPlies } = quiescence;
  if (
    maxPlies !== undefined && !(Number.isInteger(maxPlies) && maxPlies >= 0)
  ) {
    throw new RangeError(
      `quiescence.maxPlies must be an integer >= 0, got ${maxPlies}`,
    );
  }
}

/**
 * The Moves a quiescence node searches, in the order to try them: every
 * Move of `moves` (the legal Moves) if `all` (standing pat is refused),
 * otherwise the tactical ones (`tactical`, or those `priority` ranks above
 * 0). Ordered by `priority`, highest first, the Game's order breaking ties;
 * in the Game's order without it. Reuses `scratch` for the priorities.
 */
export function quiescenceMoves<Position, Move>(
  position: Position,
  moves: readonly Move[],
  all: boolean,
  tactical: ((position: Position, move: Move) => boolean) | undefined,
  priority: MovePriority<Position, Move> | undefined,
  scratch: number[],
): readonly Move[] {
  const searched = all || tactical === undefined
    ? moves
    : moves.filter((move) => tactical(position, move));
  if (priority === undefined) {
    return all || tactical !== undefined ? searched : NO_MOVES;
  }
  const order = orderMoves(position, searched, -1, priority, scratch);
  // Without an explicit test, the tactical Moves are those ranked above 0:
  // they come first in the order.
  const byPriority = !all && tactical === undefined;
  const picked: Move[] = [];
  for (const i of order) {
    if (byPriority && scratch[i]! <= 0) break;
    picked.push(searched[i]!);
  }
  return picked;
}
