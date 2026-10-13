/**
 * Generic alpha-beta (negamax) search over any two-Seat, zero-sum
 * `GameRules`. A Game-specific Engine composes this library with an
 * evaluation function, e.g.
 *
 * ```ts
 * const engine = createMinimaxEngine({ rules, evaluate, name: "minimax" });
 * ```
 *
 * The plumbing (iterative deepening, limits, time and abort handling,
 * multi-PV bookkeeping, the score scale) lives in the shared search harness
 * `@boardwright/engine-search`; this module is the algorithm.
 */
import {
  type Analysis,
  type Engine,
  type GameRules,
  hasChance,
  type SearchLimits,
  type Seat,
} from "@boardwright/core";
import {
  createNodeCounter,
  horizonScore,
  type Iteration,
  iterativeDeepening,
  NO_MOVES,
  rankRootMoves,
  type Result,
  type Search,
  terminalScore,
  toLines,
  validateLimits,
} from "@boardwright/engine-search";

/** Largest magnitude an evaluation keeps; larger values are clamped. */
export { MAX_EVALUATION } from "@boardwright/engine-search";

/**
 * A Game without chance. Minimax cannot search Chance events (ADR 0005), so a
 * `ChanceGameRules` is refused at compile time (and at run time).
 */
export type GameRulesWithoutChance<Position, Move> =
  & GameRules<Position, Move>
  & { readonly chanceEvents?: never; readonly resolveChance?: never };

export interface MinimaxOptions<Position, Move> {
  readonly rules: GameRulesWithoutChance<Position, Move>;
  /**
   * Heuristic value of a non-terminal Position from the perspective of the
   * Seat to move (higher is better for that Seat). Called only at the depth
   * horizon. Must not return NaN; magnitudes above {@link MAX_EVALUATION}
   * are clamped so they never outrank a forced win.
   */
  readonly evaluate: (position: Position) => number;
  readonly name: string;
}

/**
 * Creates an Engine that searches with negamax + alpha-beta and iterative
 * deepening.
 *
 * `analyze` yields one Analysis per completed depth, starting at 1:
 * - `maxDepth` caps the depth; without it the search deepens until the tree
 *   is solved (no horizon was hit), `maxTimeMs` elapses or `signal` aborts.
 * - `maxTimeMs` counts from the start of iteration (the first `next()`, as
 *   async generators are lazy), not from the `analyze` call. It never
 *   interrupts depth 1, so a time-limited search always yields at least one
 *   Analysis. Aborting `signal` stops immediately.
 * - A depth interrupted by time or abort is discarded, never yielded.
 * - `lines` (multi-PV) reports the best n root Moves, best first, each with
 *   its own principal variation.
 * - A terminal Position yields a single Analysis with depth 0 and no Lines.
 * - Invalid limits throw a RangeError from `analyze` itself.
 *
 * The search runs on the calling thread but gives the event loop a turn
 * every few milliseconds, so timers and abort requests are observed while it
 * runs; host it in a Worker to keep a server responsive.
 *
 * Assumes two Seats with zero-sum Outcomes. A Seat may move several times in
 * a row; the search only flips perspective when the Seat to move changes.
 */
export function createMinimaxEngine<Position, Move>(
  options: MinimaxOptions<Position, Move>,
): Engine<Position, Move> {
  const { rules, evaluate, name } = options;
  // Callers that bypass the type (e.g. `any`, or rules widened to GameRules).
  if (hasChance(rules as GameRules<Position, Move>)) {
    throw new TypeError(
      `minimax cannot search ${rules.id}: it has Chance events (ADR 0005)`,
    );
  }

  return {
    name,
    gameId: rules.id,
    analyze(position, limits, signal) {
      validateLimits(limits);
      return analyze(rules, evaluate, position, limits, signal);
    },
  };
}

async function* analyze<Position, Move>(
  rules: GameRules<Position, Move>,
  evaluate: (position: Position) => number,
  root: Position,
  limits: SearchLimits,
  signal: AbortSignal | undefined,
): AsyncGenerator<Analysis<Move>> {
  const rootSeat = rules.toMove(root);
  if (rootSeat === undefined) {
    yield { depth: 0, lines: [] };
    return;
  }
  const wanted = limits.lines ?? 1;

  // Root Moves, re-ordered after each depth by the previous depth's scores.
  let order: readonly Move[] = rules.legalMoves(root);
  const counter = createNodeCounter();
  // Set when a depth evaluated a horizon Position; if not, it was exact.
  let hitHorizon = false;

  /** Score of `child` (reached from a Position where `seat` moved) if it is a leaf. */
  function leafScore(
    child: Position,
    seat: Seat,
    depthLeft: number,
    ply: number,
  ): number | undefined {
    const outcome = rules.outcome(child);
    if (outcome) return terminalScore(outcome, seat, ply);
    if (depthLeft > 0) return undefined;
    hitHorizon = true;
    const value = horizonScore(
      evaluate(child),
      () => rules.notation.encodePosition(child),
    );
    return rules.toMove(child) === seat ? value : -value;
  }

  /**
   * Scores Move `move` in `position` (where `seat` is to move) from `seat`'s
   * perspective, searching `depthLeft` more plies below the child. The PV is
   * the child's continuation, without `move`; callers prepend `move` only to
   * results they keep, so discarded nodes allocate nothing.
   */
  function* child(
    position: Position,
    seat: Seat,
    move: Move,
    depthLeft: number,
    ply: number,
    alpha: number,
    beta: number,
  ): Search<Result<Move>> {
    if (counter.visit()) yield;
    const next = rules.play(position, move);
    const leaf = leafScore(next, seat, depthLeft, ply + 1);
    if (leaf !== undefined) return { score: leaf, pv: NO_MOVES };
    const nextSeat = rules.toMove(next)!;
    if (nextSeat === seat) {
      return yield* negamax(next, nextSeat, depthLeft, ply + 1, alpha, beta);
    }
    const r = yield* negamax(next, nextSeat, depthLeft, ply + 1, -beta, -alpha);
    return { score: -r.score, pv: r.pv };
  }

  /** Fail-soft negamax over a non-terminal `position`; `depth` >= 1. */
  function* negamax(
    position: Position,
    seat: Seat,
    depth: number,
    ply: number,
    alpha: number,
    beta: number,
  ): Search<Result<Move>> {
    let best: Result<Move> = { score: -Infinity, pv: NO_MOVES };
    for (const move of rules.legalMoves(position)) {
      const r = yield* child(position, seat, move, depth - 1, ply, alpha, beta);
      if (r.score > best.score) {
        best = { score: r.score, pv: [move, ...r.pv] };
        if (r.score > alpha) {
          alpha = r.score;
          if (alpha >= beta) break;
        }
      }
    }
    return best;
  }

  /** One depth: every root Move searched to `depth`, best `wanted` exact. */
  function* searchDepth(depth: number): Search<Iteration<Move>> {
    hitHorizon = false;
    const results = yield* rankRootMoves(
      order,
      wanted,
      (move, alpha) =>
        child(root, rootSeat!, move, depth - 1, 0, alpha, Infinity),
    );
    order = results.map((r) => r.pv[0]!);
    return {
      analysis: { depth, lines: toLines(results, wanted) },
      solved: !hitHorizon,
    };
  }

  yield* iterativeDeepening(limits, signal, searchDepth);
}
