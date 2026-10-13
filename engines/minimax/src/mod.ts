/**
 * Generic alpha-beta (negamax) search over any two-Seat, zero-sum
 * `GameRules`. A Game-specific Engine composes this library with an
 * evaluation function, e.g.
 *
 * ```ts
 * const engine = createMinimaxEngine({ rules, evaluate, name: "minimax" });
 * ```
 */
import type {
  Analysis,
  Engine,
  GameRules,
  Line,
  Outcome,
  Score,
  SearchLimits,
  Seat,
} from "@boardwright/core";

export interface MinimaxOptions<Position, Move> {
  readonly rules: GameRules<Position, Move>;
  /**
   * Heuristic value of a non-terminal Position from the perspective of the
   * Seat to move (higher is better for that Seat). Called only at the depth
   * horizon. Must not return NaN; magnitudes above {@link MAX_EVALUATION}
   * are clamped so they never outrank a forced win.
   */
  readonly evaluate: (position: Position) => number;
  readonly name: string;
}

/** Largest magnitude an evaluation keeps; larger values are clamped. */
export const MAX_EVALUATION = 1e8;

// Internal numeric scores are relative to the root: a win `p` plies after
// the root is MATE - p, a loss -(MATE - p), a draw 0. Everything with
// |score| > MATE_BOUND is a forced win/loss.
const MATE = 1e9;
const MATE_BOUND = MATE - 1e6;

/** Nodes between cooperative yields to the driver (time/abort checks). */
const NODES_PER_TICK = 256;
/** Longest the search runs before giving the event loop a turn. */
const SLICE_MS = 10;

interface Result<Move> {
  readonly score: number;
  readonly pv: readonly Move[];
}

/** Yields `undefined` every few nodes so the driver can pause or stop. */
type Search<T> = Generator<undefined, T, undefined>;

class Stopped extends Error {}

/**
 * Creates an Engine that searches with negamax + alpha-beta and iterative
 * deepening.
 *
 * `analyze` yields one Analysis per completed depth, starting at 1:
 * - `maxDepth` caps the depth; without it the search deepens until the tree
 *   is solved (no horizon was hit), `maxTimeMs` elapses or `signal` aborts.
 * - `maxTimeMs` never interrupts depth 1, so a time-limited search always
 *   yields at least one Analysis. Aborting `signal` stops immediately.
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

  return {
    name,
    gameId: rules.id,
    analyze(position, limits, signal) {
      validateLimits(limits);
      return analyze(rules, evaluate, position, limits, signal);
    },
  };
}

function validateLimits(limits: SearchLimits): void {
  const { maxDepth, maxTimeMs, lines } = limits;
  if (
    maxDepth !== undefined && !(Number.isInteger(maxDepth) && maxDepth >= 1)
  ) {
    throw new RangeError(`maxDepth must be an integer >= 1, got ${maxDepth}`);
  }
  if (maxTimeMs !== undefined && !(maxTimeMs >= 0)) {
    throw new RangeError(`maxTimeMs must be >= 0, got ${maxTimeMs}`);
  }
  if (lines !== undefined && !(Number.isInteger(lines) && lines >= 1)) {
    throw new RangeError(`lines must be an integer >= 1, got ${lines}`);
  }
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
  const start = performance.now();
  const deadline = limits.maxTimeMs === undefined
    ? Infinity
    : start + limits.maxTimeMs;
  const maxDepth = limits.maxDepth ?? Infinity;
  const wanted = limits.lines ?? 1;

  // Root Moves, re-ordered after each depth by the previous depth's scores.
  let order: readonly Move[] = rules.legalMoves(root);
  let nodes = 0;
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
    const value = evaluate(child);
    if (Number.isNaN(value)) {
      throw new TypeError(
        `evaluate returned NaN for ${rules.notation.encodePosition(child)}`,
      );
    }
    const clamped = Math.max(-MAX_EVALUATION, Math.min(MAX_EVALUATION, value));
    return rules.toMove(child) === seat ? clamped : -clamped;
  }

  /**
   * Scores Move `move` in `position` (where `seat` is to move) from `seat`'s
   * perspective, searching `depthLeft` more plies below the child.
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
    if (++nodes % NODES_PER_TICK === 0) yield;
    const next = rules.play(position, move);
    const leaf = leafScore(next, seat, depthLeft, ply + 1);
    if (leaf !== undefined) return { score: leaf, pv: [move] };
    const nextSeat = rules.toMove(next)!;
    if (nextSeat === seat) {
      const r = yield* negamax(next, nextSeat, depthLeft, ply + 1, alpha, beta);
      return { score: r.score, pv: [move, ...r.pv] };
    }
    const r = yield* negamax(next, nextSeat, depthLeft, ply + 1, -beta, -alpha);
    return { score: -r.score, pv: [move, ...r.pv] };
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
    let best: Result<Move> = { score: -Infinity, pv: [] };
    for (const move of rules.legalMoves(position)) {
      const r = yield* child(position, seat, move, depth - 1, ply, alpha, beta);
      if (r.score > best.score) {
        best = r;
        if (r.score > alpha) {
          alpha = r.score;
          if (alpha >= beta) break;
        }
      }
    }
    return best;
  }

  /**
   * Searches every root Move to `depth`. Returns exact results for the best
   * `wanted` Moves (best first), followed by upper bounds for the rest.
   */
  function* searchRoot(depth: number): Search<Result<Move>[]> {
    const top: Result<Move>[] = [];
    const rest: Result<Move>[] = [];
    for (const move of order) {
      // Only Moves that beat the current n-th best need an exact score.
      const alpha = top.length < wanted ? -Infinity : top[wanted - 1]!.score;
      const r = yield* child(
        root,
        rootSeat!,
        move,
        depth - 1,
        0,
        alpha,
        Infinity,
      );
      if (r.score > alpha) {
        // Insert after equal scores so earlier (better-ordered) Moves win ties.
        let i = top.length;
        while (i > 0 && top[i - 1]!.score < r.score) i--;
        top.splice(i, 0, r);
        if (top.length > wanted) rest.push(top.pop()!);
      } else {
        rest.push(r);
      }
    }
    rest.sort((a, b) => b.score - a.score);
    return [...top, ...rest];
  }

  let lastBreath = performance.now();
  const shouldStop = (depth: number) =>
    signal?.aborted === true ||
    (depth > 1 && performance.now() >= deadline);

  /** Runs one depth to completion, pausing for the event loop; throws Stopped. */
  async function runDepth(depth: number): Promise<Result<Move>[]> {
    const search = searchRoot(depth);
    for (;;) {
      const step = search.next();
      if (step.done) return step.value;
      if (shouldStop(depth)) throw new Stopped();
      if (performance.now() - lastBreath >= SLICE_MS) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastBreath = performance.now();
        if (shouldStop(depth)) throw new Stopped();
      }
    }
  }

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (signal?.aborted) return;
    if (depth > 1 && performance.now() >= deadline) return;
    hitHorizon = false;
    let results: Result<Move>[];
    try {
      results = await runDepth(depth);
    } catch (e) {
      if (e instanceof Stopped) return;
      throw e;
    }
    order = results.map((r) => r.pv[0]!);
    const lines: Line<Move>[] = results.slice(0, wanted).map((r) => ({
      moves: r.pv,
      score: toScore(r.score),
    }));
    yield { depth, lines };
    if (!hitHorizon) return; // solved: deeper search cannot change anything
  }
}

/** Score of a terminal Position reached at `ply`, for the Seat that moved into it. */
function terminalScore(outcome: Outcome, seat: Seat, ply: number): number {
  if (outcome.winner === undefined) return 0;
  return outcome.winner === seat ? MATE - ply : -(MATE - ply);
}

function toScore(score: number): Score {
  if (score > MATE_BOUND) return { kind: "win-in", plies: MATE - score };
  if (score < -MATE_BOUND) return { kind: "loss-in", plies: MATE + score };
  return { kind: "value", value: score };
}
