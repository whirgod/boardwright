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
 * killers are found. Then the history heuristic orders the other quiet Moves
 * (after the priority): a score per Seat and quiet Move, raised by every beta
 * cutoff the Move causes (by depth squared) anywhere in the search, lowered
 * for the quiet Moves tried in vain before it, halved at every depth and
 * whenever it grows too large or too many (`HistoryScores`). Its key defaults to
 * `encodeMove` text, computed for every quiet Move at a node, which can cost
 * more than the nodes it saves: an Engine supplies a cheaper `moveKey`
 * (chess: the squares). Killers and history only reorder: values never change.
 *
 * At the depth horizon, an optional Engine-supplied `quiescence` searches on
 * with the tactical Moves until the Position is quiet (`quiescence.ts`), so
 * a capture at the horizon is not scored without its recapture. The Seat to
 * move may stand pat (take the evaluation) where the Engine allows it, so
 * standing pat counts as a horizon; a quiescence subtree that ends only in
 * Outcomes does not. Quiescence results are not stored in the table, and
 * the Lines include the quiescence Moves.
 *
 * An optional Engine-supplied `extend` adds a ply below a child that deserves
 * it (in chess, a check), up to `maxExtensions` per path, so a forced
 * sequence just past the depth is seen. Extensions apply in the main search
 * only, and the table stores the depth searched, extensions included.
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
import {
  HistoryScores,
  Killers,
  type MovePriority,
  orderMoves,
} from "./ordering.ts";
import {
  checkQuiescence,
  DEFAULT_QUIESCENCE_PLIES,
  type Quiescence,
  quiescenceMoves,
} from "./quiescence.ts";
import {
  type Bound,
  checkTableBytes,
  createTranspositionTable,
  fromTableScore,
  toTableScore,
} from "./table.ts";

/** Largest magnitude an evaluation keeps; larger values are clamped. */
export { MAX_EVALUATION } from "@boardwright/engine-search";
export { DEFAULT_QUIESCENCE_PLIES, type Quiescence } from "./quiescence.ts";

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
   * Seat to move (higher is better for that Seat). Called at the depth
   * horizon, or with `quiescence` past it: wherever the Seat to move stands
   * pat, and at the cap. Must not return NaN; magnitudes above
   * {@link MAX_EVALUATION} are clamped so they never outrank a forced win.
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
   * or below a quiet one. Called once per Move at every interior node (and
   * once more for the Move that causes a cutoff, to tell if it is quiet),
   * and with `quiescence` once per legal Move at every quiescence node (to
   * pick and order the tactical Moves), so keep it cheap. Ordering never
   * changes a result, only the node count. Without it the Game's order is
   * used.
   */
  readonly movePriority?: MovePriority<Position, Move>;
  /**
   * Optional quiescence search (`quiescence.ts`), Engine knowledge like
   * `evaluate`: at the depth horizon, the search goes on with the tactical
   * Moves until the Position is quiet, so a capture at the horizon is not
   * scored without the recapture. `standPat(position)` says where the Seat
   * to move may decline them all (false in chess when in check, in checkers
   * when a capture is compulsory: every legal Move is searched there);
   * `tactical` picks the Moves (default: `movePriority` > 0); `maxPlies`
   * caps the plies past the horizon (default
   * {@link DEFAULT_QUIESCENCE_PLIES}; a RangeError from
   * `createMinimaxEngine` unless an integer >= 0). Without it, every
   * Position at the horizon is evaluated as it stands.
   *
   * Every quiescence Move counts as a node (time limits and aborts
   * interrupt it); quiescence results are not stored in the table; Lines
   * include the quiescence Moves, so they may be longer than the reported
   * (nominal) depth.
   */
  readonly quiescence?: Quiescence<Position, Move>;
  /**
   * Optional identity of a Move for the history heuristic, which scores quiet
   * Moves across Positions: Moves are opaque, so by default a Move is
   * identified by its `Notation.encodeMove` text, which the search computes
   * for every quiet Move at a node once the history is not empty. A cheaper
   * key makes that cheaper: it must be equal for Moves that mean the same in
   * different Positions of one Seat, e.g. the squares of a chess Move
   * (`from * 64 + to`; chess promotions are tactical, priority > 0, so never
   * history-sorted and their missing piece cannot collide). Two Moves, even
   * of one Position, that share a key only share (blur) their history
   * scores: ordering stays a permutation and values never change. Killers
   * keep using `encodeMove` text whatever the key.
   */
  readonly moveKey?: (move: Move) => string | number;
  /**
   * Optional search extension, Engine knowledge like `evaluate`: whether the
   * non-terminal Position `next`, just reached by a Move, deserves one more
   * ply (in chess: the Seat to move is in check, so a forced sequence of
   * checks is not cut off at the horizon). The child is then searched one
   * ply deeper than the nominal depth, in the same iteration. Called once
   * per Move at every interior node and at the horizon (not inside
   * quiescence), so keep it cheap. At most `maxExtensions` plies are added
   * on any path from the root, which bounds the tree in Games with endless
   * checks. The table stores the depth actually searched, so an extended
   * entry only answers a probe it covers; as the extra plies depend on the
   * path, a stored value may differ slightly from a fresh search of the same
   * depth. Without it, the search is exactly as before.
   */
  readonly extend?: (position: Position) => boolean;
  /**
   * The bound on extensions per path from the root, an integer >= 0 (a
   * RangeError from `createMinimaxEngine` otherwise); default
   * {@link DEFAULT_MAX_EXTENSIONS}.
   */
  readonly maxExtensions?: number;
}

/** Default bound on extensions per path (see `MinimaxOptions.extend`). */
export const DEFAULT_MAX_EXTENSIONS = 4;

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
 *   `tableBytes` or `quiescence.maxPlies` throws one from
 *   `createMinimaxEngine`.
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
    quiescence,
    moveKey,
    extend,
    maxExtensions = DEFAULT_MAX_EXTENSIONS,
  } = options;
  // Callers that bypass the type (e.g. `any`, or rules widened to GameRules).
  if (hasChance(rules as GameRules<Position, Move>)) {
    throw new TypeError(
      `minimax cannot search ${rules.id}: it has Chance events (ADR 0005)`,
    );
  }
  checkTableBytes(tableBytes);
  if (quiescence) checkQuiescence(quiescence);
  if (!(Number.isInteger(maxExtensions) && maxExtensions >= 0)) {
    throw new RangeError(
      `maxExtensions must be an integer >= 0, got ${maxExtensions}`,
    );
  }

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
        quiescence,
        moveKey,
        extend,
        maxExtensions,
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
  quiescence: Quiescence<Position, Move> | undefined,
  moveKey: ((move: Move) => string | number) | undefined,
  extend: ((position: Position) => boolean) | undefined,
  maxExtensions: number,
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
  // Quiet Moves that caused a beta cutoff, per Seat, of the whole search.
  const history = new HistoryScores();
  const encodeMove = (move: Move) => rules.notation.encodeMove(move);
  const historyKey = moveKey ?? encodeMove;
  const priority: MovePriority<Position, Move> = movePriority ?? noPriority;
  const counter = createNodeCounter();
  // Horizon Positions evaluated in the current depth (in quiescence: every
  // stand pat), counting a stored result that came from a search that hit
  // the horizon as one. While none is found, the depth is exact.
  let horizons = 0;
  // Quiescence plies past the horizon before a Position is evaluated anyway.
  const maxPlies = quiescence?.maxPlies ?? DEFAULT_QUIESCENCE_PLIES;
  // Extensions on the path from the root to the node being searched.
  let extended = 0;

  /** The evaluation of non-terminal `position`, for its Seat to move. */
  function staticScore(position: Position): number {
    return horizonScore(
      evaluate(position),
      () => rules.notation.encodePosition(position),
    );
  }

  /**
   * Score of `child` (reached from a Position where `seat` moved) if it is a
   * leaf: terminal, or at the horizon without quiescence.
   */
  function leafScore(
    child: Position,
    seat: Seat,
    depthLeft: number,
    ply: number,
  ): number | undefined {
    const outcome = rules.outcome(child);
    if (outcome) return terminalScore(outcome, seat, ply);
    if (depthLeft > 0 || quiescence) return undefined;
    horizons++;
    const value = staticScore(child);
    return rules.toMove(child) === seat ? value : -value;
  }

  /**
   * Scores Move `move` in `position` (where `seat` is to move) from `seat`'s
   * perspective, searching `depthLeft` more plies below the child (0 or
   * less: quiescence). The PV is the child's continuation, without `move`;
   * callers prepend `move` only to results they keep, so discarded nodes
   * allocate nothing.
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
    // Never inside quiescence (`depthLeft` < 0); never past the bound.
    let bumped = false;
    if (
      extend && depthLeft >= 0 && extended < maxExtensions &&
      rules.toMove(next) !== undefined && extend(next)
    ) {
      depthLeft++;
      extended++;
      bumped = true;
    }
    const leaf = leafScore(next, seat, depthLeft, ply + 1);
    if (leaf !== undefined) {
      if (bumped) extended--;
      return { score: leaf, pv: NO_MOVES };
    }
    const nextSeat = rules.toMove(next)!;
    const search = depthLeft > 0 ? negamax : quiesce;
    let result: Result<Move>;
    if (nextSeat === seat) {
      result = yield* search(next, nextSeat, depthLeft, ply + 1, alpha, beta);
    } else {
      const r = yield* search(
        next,
        nextSeat,
        depthLeft,
        ply + 1,
        -beta,
        -alpha,
      );
      result = { score: -r.score, pv: r.pv };
    }
    if (bumped) extended--;
    return result;
  }

  /**
   * Fail-soft quiescence search of a non-terminal `position` at or past the
   * horizon, from `seat`'s perspective (see `quiescence.ts`); `depth` <= 0 is
   * minus the plies past the horizon.
   *
   * Standing pat skips the quiet Moves, so it counts as a horizon, whether
   * or not its evaluation decides the score: only a quiescence subtree that
   * refuses stand pat everywhere and ends in Outcomes is exact. A stand pat
   * is clamped like any evaluation, so it never makes a forced result; a
   * forced result found by the Moves is counted in plies from the root, like
   * any other. The PV includes the quiescence Moves. Results are not stored
   * in the table: they are many, cheap, and keyed by long texts.
   */
  function* quiesce(
    position: Position,
    seat: Seat,
    depth: number,
    ply: number,
    alpha: number,
    beta: number,
  ): Search<Result<Move>> {
    const capped = depth <= -maxPlies;
    const standPat = capped || quiescence!.standPat(position);
    let best: Result<Move> = { score: -Infinity, pv: NO_MOVES };
    if (standPat) {
      horizons++;
      const score = staticScore(position);
      if (capped || score >= beta) return { score, pv: NO_MOVES };
      best = { score, pv: NO_MOVES };
      if (score > alpha) alpha = score;
    }
    const moves = quiescenceMoves(
      position,
      rules.legalMoves(position),
      !standPat,
      quiescence!.tactical,
      movePriority,
      scratch,
    );
    for (const move of moves) {
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
      { history, seat, key: historyKey },
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
              // History heuristic: credit the Move, and discredit the quiet Moves tried
              // in vain before it (not the hash Move, tried for its own sake).
              history.record(seat, historyKey(move), depth);
              for (let q = 0; q < k; q++) {
                const j = ordered[q]!;
                const tried = moves[j]!;
                if (j === hashMove) continue;
                if (movePriority && movePriority(position, tried) > 0) continue;
                history.record(seat, historyKey(tried), depth, -1);
              }
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
    history.age();
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
