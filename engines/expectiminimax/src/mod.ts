/**
 * Generic expectiminimax search over any two-Seat, zero-sum Game with chance
 * (`ChanceGameRules`, ADR 0005), e.g. backgammon. A Game-specific Engine
 * composes this library with an evaluation function:
 *
 * ```ts
 * const engine = createExpectiminimaxEngine({ rules, evaluate, name: "expectiminimax" });
 * ```
 *
 * ## The algorithm
 *
 * Minimax assumes both Seats pick the Move that is best for them. A Game with
 * chance adds a third kind of node, the pending **Chance event** (a roll of
 * the dice), where nobody chooses: each result happens with its probability.
 * Expectiminimax values the tree bottom-up with three rules:
 *
 * - **Decision node** (a Seat is to move): the value of the best Move for the
 *   Seat to move — as in minimax. Written in negamax form: every value is from
 *   one Seat's perspective and flips sign when the Seat to move changes.
 * - **Chance node** (a Chance event is pending): the **expected value**, the
 *   probability-weighted average of the values after each result:
 *   `Σ probability(r) · value(resolveChance(position, r))`.
 * - **Leaf**: a terminal Position scores its Outcome; at the depth horizon,
 *   the heuristic `evaluate`.
 *
 * Alpha-beta pruning still works between decision nodes, but an average needs
 * every result's exact value, so the window is reset to (-∞, ∞) below a
 * Chance event (smarter chance pruning, such as Ballard's Star1, is not
 * implemented). Depth counts Moves only: resolving a Chance event is free, so
 * depth 2 in backgammon means "my Move, every roll, the Opponent's Move".
 *
 * Forced results: a chance node is a `win-in` (`loss-in`) only when *every*
 * result is a forced win (loss), and then counts the slowest one — the
 * number of plies within which the win is certain whatever the dice. When
 * results are mixed, a forced win counts as `+winValue` (a loss as
 * `-winValue`) in the average, so the result is an ordinary value.
 *
 * The evaluation's scale matters here, unlike in minimax: minimax only
 * compares values, so any order-preserving rescaling of the evaluation gives
 * the same Moves, but an average mixes magnitudes. Evaluations must be
 * *cardinal* (twice the value means twice as good, e.g. expected points or
 * win probability), with a certain win worth `winValue`. Horizon evaluations
 * are clamped to ±`winValue`, so a forced win is always at least as good as
 * any evaluation.
 *
 * The plumbing (iterative deepening, limits, time and abort handling,
 * multi-PV bookkeeping, the score scale) lives in the shared search harness
 * `@boardwright/engine-search`; this module is the algorithm.
 */
import {
  type Analysis,
  type ChanceGameRules,
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
  MATE_BOUND,
  MAX_EVALUATION,
  NO_MOVES,
  rankRootMoves,
  type Result,
  type Search,
  terminalScore,
  toLines,
  toScore,
  validateLimits,
} from "@boardwright/engine-search";

/** Largest magnitude an evaluation keeps; larger values are clamped. */
export { MAX_EVALUATION } from "@boardwright/engine-search";

export interface ExpectiminimaxOptions<Position, Move, Chance> {
  readonly rules: ChanceGameRules<Position, Move, Chance>;
  /**
   * Heuristic value of a non-terminal Position from the perspective of
   * `seat` (higher is better for `seat`). Called only at the depth horizon,
   * which may be a Position with a pending Chance event — that is why the
   * perspective is explicit (nobody is to move there). A cardinal value on
   * the scale of `winValue` (see the module doc); must not return NaN, and
   * magnitudes above `winValue` are clamped.
   */
  readonly evaluate: (position: Position, seat: Seat) => number;
  readonly name: string;
  /**
   * The value of a certain win on the evaluation's scale (a loss is its
   * negation), e.g. 1 when `evaluate` returns expected points in [-1, 1].
   * A forced win counts as this much when averaged over a Chance event's
   * results together with results that are not forced, and evaluations are
   * clamped to ±`winValue`. Required, because no default can know the
   * evaluation's scale: too large a value makes the search chase long shots.
   * In (0, {@link MAX_EVALUATION}].
   */
  readonly winValue: number;
}

/**
 * Creates an Engine that searches with expectiminimax (negamax + alpha-beta
 * at decision nodes, expected values at Chance events) and iterative
 * deepening.
 *
 * `analyze` yields one Analysis per completed depth, starting at 1, with the
 * same limits as the minimax library (`maxDepth`, `maxTimeMs` never
 * interrupting depth 1, `lines`, `signal`; a terminal Position yields one
 * `{ depth: 0, lines: [] }`; invalid limits throw a RangeError). Besides:
 * - Lines end at the next Chance event: the search cannot know the roll, so
 *   it predicts no Move after one.
 * - While a Chance event is pending, every Analysis is
 *   `{ depth, lines: [], score, seat }`: the expected Score from `seat`'s
 *   perspective, where `seat` is the Seat that moves after the roll if every
 *   result agrees on it, otherwise the Game's first Seat.
 *
 * Throws a TypeError for rules without chance (use the minimax library).
 * Assumes two Seats with zero-sum Outcomes; a Seat may move several times in
 * a row.
 */
export function createExpectiminimaxEngine<Position, Move, Chance>(
  options: ExpectiminimaxOptions<Position, Move, Chance>,
): Engine<Position, Move> {
  const { rules, evaluate, name, winValue } = options;
  // Callers that bypass the type; a plain Game belongs to minimax (ADR 0005).
  if (!hasChance(rules as GameRules<Position, Move>)) {
    throw new TypeError(
      `expectiminimax needs a Game with chance; ${rules.id} has none (use minimax)`,
    );
  }
  if (!(winValue > 0 && winValue <= MAX_EVALUATION)) {
    throw new RangeError(
      `winValue must be in (0, ${MAX_EVALUATION}], got ${winValue}`,
    );
  }

  return {
    name,
    gameId: rules.id,
    analyze(position, limits, signal) {
      validateLimits(limits);
      return analyze(
        { rules, evaluate, winValue },
        position,
        limits,
        signal,
      );
    },
  };
}

interface Setup<Position, Move, Chance> {
  readonly rules: ChanceGameRules<Position, Move, Chance>;
  readonly evaluate: (position: Position, seat: Seat) => number;
  readonly winValue: number;
}

async function* analyze<Position, Move, Chance>(
  { rules, evaluate, winValue }: Setup<Position, Move, Chance>,
  root: Position,
  limits: SearchLimits,
  signal: AbortSignal | undefined,
): AsyncGenerator<Analysis<Move>> {
  if (rules.outcome(root) !== undefined) {
    yield { depth: 0, lines: [] };
    return;
  }
  const rootSeat = rules.toMove(root);
  const wanted = limits.lines ?? 1;

  // Root Moves, re-ordered after each depth by the previous depth's scores.
  let order: readonly Move[] = rules.legalMoves(root);
  const counter = createNodeCounter();
  // Set when a depth evaluated a horizon Position; if not, it was exact.
  let hitHorizon = false;

  /**
   * The value of `position` from `seat`'s perspective, searching `depthLeft`
   * more Moves; `ply` Moves were played since the root. The PV is the Moves
   * expected from `position` on, up to the next Chance event.
   */
  function* value(
    position: Position,
    seat: Seat,
    depthLeft: number,
    ply: number,
    alpha: number,
    beta: number,
  ): Search<Result<Move>> {
    if (counter.visit()) yield;
    const outcome = rules.outcome(position);
    if (outcome) {
      return { score: terminalScore(outcome, seat, ply), pv: NO_MOVES };
    }
    if (depthLeft === 0) {
      hitHorizon = true;
      const score = horizonScore(
        evaluate(position, seat),
        () => rules.notation.encodePosition(position),
      );
      // A forced win (+winValue in an average) must beat every evaluation.
      const clamped = Math.max(-winValue, Math.min(winValue, score));
      return { score: clamped, pv: NO_MOVES };
    }
    const mover = rules.toMove(position);
    if (mover === undefined) {
      // A pending Chance event: the Line ends here.
      const score = yield* expectation(position, seat, depthLeft, ply);
      return { score, pv: NO_MOVES };
    }
    if (mover === seat) {
      return yield* decision(position, seat, depthLeft, ply, alpha, beta);
    }
    const r = yield* decision(position, mover, depthLeft, ply, -beta, -alpha);
    return { score: -r.score, pv: r.pv };
  }

  /**
   * Decision node: fail-soft negamax over the Moves of `seat`, who is to
   * move in `position`; `depth` >= 1.
   */
  function* decision(
    position: Position,
    seat: Seat,
    depth: number,
    ply: number,
    alpha: number,
    beta: number,
  ): Search<Result<Move>> {
    let best: Result<Move> = { score: -Infinity, pv: NO_MOVES };
    for (const move of rules.legalMoves(position)) {
      const next = rules.play(position, move);
      const r = yield* value(next, seat, depth - 1, ply + 1, alpha, beta);
      if (r.score > best.score) {
        best = { score: r.score, pv: [move, ...r.pv] };
        if (r.score > alpha) {
          alpha = r.score;
          if (alpha >= beta) break; // the Opponent will not allow this line
        }
      }
    }
    return best;
  }

  /**
   * Chance node: the expected value of the Chance event pending in
   * `position`, from `seat`'s perspective. Every result is searched with a
   * full window, because each one contributes to the average.
   */
  function* expectation(
    position: Position,
    seat: Seat,
    depthLeft: number,
    ply: number,
  ): Search<number> {
    let expected = 0;
    let slowestWin = Infinity; // smallest score among forced wins
    let slowestLoss = -Infinity; // largest score among forced losses
    let wins = 0;
    let losses = 0;
    const results = rules.chanceEvents(position);
    if (results.length === 0) {
      // No Seat to move and no Outcome, yet nothing to roll: a bug in the Game.
      throw new TypeError(
        `${rules.id}: no Seat to move, no Outcome and no chanceEvents in ${
          rules.notation.encodePosition(position)
        }`,
      );
    }
    for (const { chance, probability } of results) {
      const next = rules.resolveChance(position, chance);
      const { score } = yield* value(
        next,
        seat,
        depthLeft,
        ply,
        -Infinity,
        Infinity,
      );
      if (score > MATE_BOUND) {
        wins++;
        slowestWin = Math.min(slowestWin, score);
        expected += probability * winValue;
      } else if (score < -MATE_BOUND) {
        losses++;
        slowestLoss = Math.max(slowestLoss, score);
        expected -= probability * winValue;
      } else {
        expected += probability * score;
      }
    }
    // Forced whatever the dice: keep the win-in / loss-in, counting the slowest.
    if (wins === results.length) return slowestWin;
    if (losses === results.length) return slowestLoss;
    return expected;
  }

  /** One depth from a Position where `seat` is to move: multi-PV over its Moves. */
  function* searchMoves(
    seat: Seat,
    depth: number,
  ): Search<Iteration<Move>> {
    hitHorizon = false;
    const results = yield* rankRootMoves(
      order,
      wanted,
      (move, alpha) =>
        value(rules.play(root, move), seat, depth - 1, 1, alpha, Infinity),
    );
    order = results.map((r) => r.pv[0]!);
    return {
      analysis: { depth, lines: toLines(results, wanted) },
      solved: !hitHorizon,
    };
  }

  /** One depth from a Position with a pending Chance event: its expected Score. */
  function* searchChance(
    seat: Seat,
    depth: number,
  ): Search<Iteration<Move>> {
    hitHorizon = false;
    const score = yield* expectation(root, seat, depth, 0);
    return {
      analysis: { depth, lines: [], score: toScore(score), seat },
      solved: !hitHorizon,
    };
  }

  if (rootSeat !== undefined) {
    yield* iterativeDeepening(
      limits,
      signal,
      (depth) => searchMoves(rootSeat, depth),
    );
  } else {
    const seat = perspective(rules, root);
    yield* iterativeDeepening(
      limits,
      signal,
      (depth) => searchChance(seat, depth),
    );
  }
}

/**
 * The Seat whose perspective a pending Chance event's Score takes: the Seat
 * that moves after the roll when every result agrees on it (it is usually
 * that Seat's roll), otherwise (e.g. backgammon's opening roll, which
 * decides who starts) the Game's first Seat.
 */
function perspective<Position, Move, Chance>(
  rules: ChanceGameRules<Position, Move, Chance>,
  position: Position,
): Seat {
  const movers = new Set(
    rules.chanceEvents(position).map(({ chance }) =>
      rules.toMove(rules.resolveChance(position, chance))
    ),
  );
  const [only] = movers;
  return movers.size === 1 && only !== undefined ? only : rules.seats[0]!;
}
