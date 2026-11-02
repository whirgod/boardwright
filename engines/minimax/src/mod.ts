/**
 * Generic alpha-beta (negamax) search over any two-Seat, zero-sum
 * `GameRules`. A Game-specific Engine composes this library with an
 * evaluation function, e.g.
 *
 * ```ts
 * const engine = createMinimaxEngine({ rules, evaluate, name: "minimax" });
 * ```
 *
 * Iterative deepening searches the same Positions again at every depth, and
 * different Move orders often reach the same Position (a transposition). A
 * transposition table (`table.ts`), keyed by `Notation.encodePosition`,
 * remembers for each Position below the root the best Move found and the
 * score:
 * - Move ordering: alpha-beta prunes the most when the best Move is searched
 *   first, and the best Move found one depth shallower (the hash Move) is a
 *   good guess, so it is tried first. At the root, the previous depth's
 *   scores order all Moves.
 * - Score reuse: a stored score answers a later visit without a search if it
 *   was searched at least as deep and its bound settles the window (see
 *   `negamax`). Forced wins and losses are stored counted from the Position,
 *   as it may recur at another ply. A stored search that hit the horizon
 *   counts as hitting it again, so a depth is `solved` only if it is; one
 *   that ended in Outcomes everywhere holds at any depth.
 *
 * Below the hash Move, an optional Engine-supplied `movePriority` orders the
 * Moves (`ordering.ts` has the convention: tactical Moves first), then the
 * killer Moves: per ply, the last two quiet Moves that caused a beta cutoff
 * often refute their siblings too, also in Positions the table has not seen.
 * Moves are opaque, so a killer is remembered as `Notation.encodeMove` text,
 * which is computed on a cutoff and, at a node, for quiet Moves only until the
 * killers are found. Killers only reorder: values never change.
 *
 * Principal variations stay complete: a score inside the window is never
 * taken from the table. A stored score may come from a deeper search, so a
 * depth can see further than a plain search to that depth would. Each
 * `analyze` call has its own table, bounded by a memory budget, `tableBytes`
 * (Engines run in a Worker per search, which would drop a longer-lived table
 * anyway).
 *
 * The key must determine everything the search sees: Positions with equal
 * `encodePosition` text must have the same legal Moves in the same order,
 * the same Seat to move and Outcome, and the same future (including draws by
 * repetition or by a move clock). A Notation that leaves out part of the
 * Position, e.g. its repetition history, makes stored scores wrong.
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
import { Killers, type MovePriority, orderMoves } from "./ordering.ts";
import {
  type Bound,
  checkTableBytes,
  createTranspositionTable,
  fromTableScore,
  toTableScore,
} from "./table.ts";

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
  /**
   * The Game. Its `notation.encodePosition` is the transposition table's key,
   * so it must encode everything that matters for the rest of the Match:
   * equal texts must mean the same legal Moves in the same order, the same
   * Seat to move and Outcome, and the same future (e.g. repetition history
   * and move clocks).
   */
  readonly rules: GameRulesWithoutChance<Position, Move>;
  /**
   * Heuristic value of a non-terminal Position from the perspective of the
   * Seat to move (higher is better for that Seat). Called only at the depth
   * horizon. Must not return NaN; magnitudes above {@link MAX_EVALUATION}
   * are clamped so they never outrank a forced win.
   */
  readonly evaluate: (position: Position) => number;
  readonly name: string;
  /**
   * Memory budget of the transposition table in bytes, an integer from 0 (no
   * table) to 2^32 (default {@link DEFAULT_TABLE_BYTES}). Each `analyze`
   * call gets its own table, which grows up to this budget as estimated by
   * `table.ts`: an entry counts as about 160 bytes plus its key (the encoded
   * Position), which ranges from a few dozen characters to a few thousand
   * with a long repetition history.
   */
  readonly tableBytes?: number;
  /**
   * Optional Move ordering, Engine knowledge like `evaluate`: how promising
   * `move` looks in `position`, as a finite number (a RangeError otherwise).
   * Alpha-beta prunes the most when the best Move is searched first. At a
   * node the hash Move goes first, then the rest by priority, highest first;
   * the Game's order breaks ties. The root at depth 1 is ordered the same
   * way. The convention: a priority above 0 marks a tactical Move (capture,
   * promotion) that goes before killer Moves and the history heuristic, 0
   * or below a quiet one. Called once per Move at every interior node, so
   * keep it cheap. Ordering never changes a result, only the node count.
   * Without it the Game's order is used.
   */
  readonly movePriority?: MovePriority<Position, Move>;
}

/**
 * Default memory budget of the transposition table: 256 MiB per search. The
 * table grows with the search, so short searches use little. The server runs
 * up to 4 searches at once (Worker memory is not capped), so the worst case
 * is about 1 GiB.
 */
export const DEFAULT_TABLE_BYTES = 256 * 2 ** 20;

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
 * - Invalid limits throw a RangeError from `analyze` itself; an invalid
 *   `tableBytes` throws one from `createMinimaxEngine`.
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
  const {
    rules,
    evaluate,
    name,
    tableBytes = DEFAULT_TABLE_BYTES,
    movePriority,
  } = options;
  // Callers that bypass the type (e.g. `any`, or rules widened to GameRules).
  if (hasChance(rules as GameRules<Position, Move>)) {
    throw new TypeError(
      `minimax cannot search ${rules.id}: it has Chance events (ADR 0005)`,
    );
  }
  checkTableBytes(tableBytes);

  return {
    name,
    gameId: rules.id,
    analyze(position, limits, signal) {
      validateLimits(limits);
      return analyze(
        rules,
        evaluate,
        tableBytes,
        movePriority,
        position,
        limits,
        signal,
      );
    },
  };
}

async function* analyze<Position, Move>(
  rules: GameRules<Position, Move>,
  evaluate: (position: Position) => number,
  tableBytes: number,
  movePriority: MovePriority<Position, Move> | undefined,
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
  // Priorities of one node's Moves, reused by every node: `orderMoves` is done
  // with it before it returns, i.e. before any child is searched, so plies
  // never share live data (killers/history, #84/#85, keep their own state).
  const scratch: number[] = [];
  if (movePriority) {
    const listed = order;
    order = orderMoves(root, listed, -1, movePriority, scratch).map((i) =>
      listed[i]!
    );
  }
  // What the search found per Position below the root (see `negamax`).
  const table = createTranspositionTable(tableBytes);
  // Quiet Moves that caused a beta cutoff, per ply, of the current depth.
  const killers = new Killers();
  const encodeMove = (move: Move) => rules.notation.encodeMove(move);
  const priority: MovePriority<Position, Move> = movePriority ?? noPriority;
  const counter = createNodeCounter();
  // Horizon Positions evaluated in the current depth, counting a stored
  // result that came from a search that hit the horizon as one. While none
  // is found, the depth is exact.
  let horizons = 0;

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
    horizons++;
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

  /**
   * Fail-soft negamax over a non-terminal `position`; `depth` >= 1.
   *
   * A result stored in the table answers without a search if it was searched
   * at least as deep and settles the window: a lower bound >= `beta` fails
   * high, an upper bound <= `alpha` fails low (an exact score is both
   * bounds). A score inside the window is searched again (its hash Move
   * first), as the caller needs its principal variation, which the table
   * does not keep.
   */
  function* negamax(
    position: Position,
    seat: Seat,
    depth: number,
    ply: number,
    alpha: number,
    beta: number,
  ): Search<Result<Move>> {
    const probe = table.probe(rules.notation.encodePosition(position));
    const entry = probe.entry;
    if (entry !== undefined && entry.depth >= depth) {
      const score = fromTableScore(entry.score, ply);
      if (
        (entry.bound !== "upper" && score >= beta) ||
        (entry.bound !== "lower" && score <= alpha)
      ) {
        // Its horizon is ours: a depth is not solved by skipping a search.
        if (entry.depth < Infinity) horizons++;
        return { score, pv: NO_MOVES };
      }
    }

    // The window as given (`alpha` rises while searching), and the horizons
    // so far, to tell afterwards what the result is and if it is solved.
    const alpha0 = alpha;
    const horizons0 = horizons;
    const moves = rules.legalMoves(position);
    // An index out of range (only if equal keys list different Moves, see
    // `MinimaxOptions.rules`) counts as no hash Move.
    const hashMove = entry !== undefined && entry.move < moves.length
      ? entry.move
      : -1;
    let best: Result<Move> = { score: -Infinity, pv: NO_MOVES };
    let bestIndex = -1;
    const ordered = orderMoves(
      position,
      moves,
      hashMove,
      priority,
      scratch,
      killers,
      ply,
      encodeMove,
    );
    for (let k = 0; k < moves.length; k++) {
      const i = ordered[k]!;
      const move = moves[i]!;
      const r = yield* child(position, seat, move, depth - 1, ply, alpha, beta);
      if (r.score > best.score) {
        best = { score: r.score, pv: [move, ...r.pv] };
        bestIndex = i;
        if (r.score > alpha) {
          alpha = r.score;
          if (alpha >= beta) {
            // A quiet Move that refutes this Position may refute its siblings.
            if (!movePriority || movePriority(position, move) <= 0) {
              killers.record(ply, encodeMove(move));
            }
            break;
          }
        }
      }
    }
    const bound: Bound = best.score <= alpha0
      ? "upper"
      : best.score >= beta
      ? "lower"
      : "exact";
    // Without a horizon below, the result holds at any depth.
    const solved = horizons === horizons0;
    probe.store({
      // After a fail-low every Move is only an upper bound, and the best of
      // them says little: keep an earlier depth's hash Move instead.
      move: bound === "upper" && hashMove >= 0 ? hashMove : bestIndex,
      depth: solved ? Infinity : depth,
      score: toTableScore(best.score, ply),
      bound,
    });
    return best;
  }

  /** One depth: every root Move searched to `depth`, best `wanted` exact. */
  function* searchDepth(depth: number): Search<Iteration<Move>> {
    horizons = 0;
    table.nextIteration();
    killers.clear(); // see `Killers`
    const results = yield* rankRootMoves(
      order,
      wanted,
      (move, alpha) =>
        child(root, rootSeat!, move, depth - 1, 0, alpha, Infinity),
    );
    order = results.map((r) => r.pv[0]!);
    return {
      analysis: { depth, lines: toLines(results, wanted) },
      solved: horizons === 0,
    };
  }

  yield* iterativeDeepening(limits, signal, searchDepth);
}

/** The priority of every Move when there is no hook: all are quiet. */
function noPriority(): number {
  return 0;
}
