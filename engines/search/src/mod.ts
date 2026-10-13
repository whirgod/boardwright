/**
 * The search harness shared by the Engine libraries (`engines/minimax`,
 * `engines/expectiminimax`): the plumbing every game-tree search needs but
 * that is not the algorithm itself (ADR 0005).
 *
 * - {@link validateLimits}: the `SearchLimits` contract.
 * - {@link iterativeDeepening}: runs depth 1, 2, 3, ... and streams one
 *   Analysis per completed depth, honouring `maxDepth`, `maxTimeMs` and the
 *   `AbortSignal`, and pausing for the event loop while a depth runs.
 * - {@link rankRootMoves} / {@link toLines}: multi-PV bookkeeping at the root.
 * - The numeric score scale ({@link MATE}, {@link terminalScore},
 *   {@link horizonScore}, {@link toScore}) that turns forced wins and
 *   evaluations into one comparable number, and back into a `Score`.
 *
 * An algorithm is written as a synchronous generator ({@link Search}) that
 * `yield`s every few nodes ({@link createNodeCounter}); the harness drives it
 * and decides at every yield whether to pause or stop. Game-agnostic and
 * chance-agnostic: it depends only on the plain `GameRules` vocabulary.
 */
import type {
  Analysis,
  Line,
  RulesOutcome,
  Score,
  SearchLimits,
  Seat,
} from "@boardwright/core";

/** Largest magnitude an evaluation keeps; larger values are clamped. */
export const MAX_EVALUATION = 1e8;

/**
 * Internal numeric scores are relative to the root and to one Seat's
 * perspective: a win `p` plies after the root is `MATE - p`, a loss
 * `-(MATE - p)`, a draw 0, and evaluations lie within ±{@link MAX_EVALUATION}.
 * Everything with |score| > {@link MATE_BOUND} is a forced win/loss.
 */
export const MATE = 1e9;
/** Scores beyond ±MATE_BOUND are forced wins / losses (see {@link MATE}). */
export const MATE_BOUND = MATE - 1e6;

/** Nodes between cooperative yields to the driver (time/abort checks). */
export const NODES_PER_TICK = 256;
/** Longest the search runs before giving the event loop a turn. */
const SLICE_MS = 10;

/**
 * A search step: `yield`s `undefined` every few nodes so the driver can pause
 * or stop it, and returns its result when done.
 */
export type Search<T> = Generator<undefined, T, undefined>;

/**
 * A numeric score (see {@link MATE}) and its principal variation: the Moves
 * the search expects from there. Whose perspective and where the PV starts
 * is up to the algorithm.
 */
export interface Result<Move> {
  readonly score: number;
  readonly pv: readonly Move[];
}

/** The empty PV, shared so leaves allocate nothing. */
export const NO_MOVES: readonly never[] = Object.freeze([]);

/** Checks the typed `SearchLimits` contract (see docs/ARCHITECTURE.md on why it is not shared with the server). */
export function validateLimits(limits: SearchLimits): void {
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

/**
 * Counts visited nodes. `visit()` returns true every {@link NODES_PER_TICK}
 * nodes: that is when a {@link Search} should `yield`.
 */
export function createNodeCounter(): { visit(): boolean } {
  let nodes = 0;
  return { visit: () => ++nodes % NODES_PER_TICK === 0 };
}

/** Score of a terminal Position reached `ply` plies after the root, for `seat`. */
export function terminalScore(
  outcome: RulesOutcome,
  seat: Seat,
  ply: number,
): number {
  if (outcome.winner === undefined) return 0;
  return outcome.winner === seat ? MATE - ply : -(MATE - ply);
}

/**
 * An evaluation as a numeric score: clamped to ±{@link MAX_EVALUATION} so it
 * never outranks a forced win. NaN is a bug in the evaluation and throws a
 * TypeError naming `where` (e.g. the encoded Position).
 */
export function horizonScore(value: number, where: () => string): number {
  if (Number.isNaN(value)) {
    throw new TypeError(`evaluate returned NaN for ${where()}`);
  }
  return Math.max(-MAX_EVALUATION, Math.min(MAX_EVALUATION, value));
}

/** A numeric score as a `Score`: forced wins/losses become `win-in`/`loss-in` plies. */
export function toScore(score: number): Score {
  if (score > MATE_BOUND) return { kind: "win-in", plies: MATE - score };
  if (score < -MATE_BOUND) return { kind: "loss-in", plies: MATE + score };
  return { kind: "value", value: score || 0 }; // normalise -0
}

/**
 * Multi-PV at the root: scores every Move of `moves` (in that order) and
 * returns exact results for the best `wanted` Moves (best first), followed by
 * the rest, sorted by their (possibly only upper-bound) scores so the next
 * depth can search the most promising Moves first.
 *
 * `scoreMove(move, alpha)` scores one root Move from the root Seat's
 * perspective, with a PV that starts *after* `move`. A Move only needs an
 * exact score if it beats `alpha`, the current `wanted`-th best score, so an
 * alpha-beta search may stop early and return an upper bound <= `alpha`.
 * Ties keep the earlier (better-ordered) Move first.
 */
export function* rankRootMoves<Move>(
  moves: readonly Move[],
  wanted: number,
  scoreMove: (move: Move, alpha: number) => Search<Result<Move>>,
): Search<Result<Move>[]> {
  const top: Result<Move>[] = [];
  const rest: Result<Move>[] = [];
  for (const move of moves) {
    const alpha = top.length < wanted ? -Infinity : top[wanted - 1]!.score;
    const r = yield* scoreMove(move, alpha);
    if (r.score > alpha) {
      // Insert after equal scores so earlier (better-ordered) Moves win ties.
      let i = top.length;
      while (i > 0 && top[i - 1]!.score < r.score) i--;
      top.splice(i, 0, { score: r.score, pv: [move, ...r.pv] });
      if (top.length > wanted) rest.push(top.pop()!);
    } else {
      // An upper bound; only kept to order the next depth.
      rest.push({ score: r.score, pv: [move] });
    }
  }
  rest.sort((a, b) => b.score - a.score);
  return [...top, ...rest];
}

/** The first `wanted` results of {@link rankRootMoves} as Lines. */
export function toLines<Move>(
  results: readonly Result<Move>[],
  wanted: number,
): Line<Move>[] {
  return results.slice(0, wanted).map((r) => ({
    moves: r.pv,
    score: toScore(r.score),
  }));
}

/** What one depth of an iterative-deepening search found. */
export interface Iteration<Move> {
  readonly analysis: Analysis<Move>;
  /**
   * True when the depth reached no horizon (every branch ended in an
   * Outcome): the result is exact and deeper search cannot change it.
   */
  readonly solved: boolean;
}

class Stopped extends Error {}

/**
 * Iterative deepening: runs `searchDepth(1)`, `searchDepth(2)`, ... and
 * yields each completed depth's Analysis.
 *
 * - `maxDepth` caps the depth; without it the search deepens until a depth
 *   is `solved`, `maxTimeMs` elapses or `signal` aborts.
 * - `maxTimeMs` counts from the start of iteration (the first `next()`, as
 *   async generators are lazy). It never interrupts depth 1, so a
 *   time-limited search always yields at least one Analysis. Aborting
 *   `signal` stops immediately.
 * - A depth interrupted by time or abort is discarded, never yielded.
 *
 * The search runs on the calling thread but gives the event loop a turn
 * every few milliseconds, so timers and abort requests are observed while it
 * runs. `limits` must already be valid ({@link validateLimits}).
 */
export async function* iterativeDeepening<Move>(
  limits: SearchLimits,
  signal: AbortSignal | undefined,
  searchDepth: (depth: number) => Search<Iteration<Move>>,
): AsyncGenerator<Analysis<Move>> {
  const start = performance.now();
  const deadline = limits.maxTimeMs === undefined
    ? Infinity
    : start + limits.maxTimeMs;
  const maxDepth = limits.maxDepth ?? Infinity;

  let lastBreath = performance.now();
  const shouldStop = (depth: number) =>
    signal?.aborted === true ||
    (depth > 1 && performance.now() >= deadline);

  /** Runs one depth to completion, pausing for the event loop; throws Stopped. */
  async function runDepth(depth: number): Promise<Iteration<Move>> {
    const search = searchDepth(depth);
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
    let iteration: Iteration<Move>;
    try {
      iteration = await runDepth(depth);
    } catch (e) {
      if (e instanceof Stopped) return;
      throw e;
    }
    yield iteration.analysis;
    if (iteration.solved) return; // deeper search cannot change anything
  }
}
