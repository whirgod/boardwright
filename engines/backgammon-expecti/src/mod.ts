/**
 * Backgammon Engine: the generic expectiminimax library with a simple,
 * hand-written evaluation. No neural network and no bear-off database: a few
 * features a beginner learns first, weighed in pips.
 *
 * ## Evaluation
 *
 * `raw` is the difference between the two Seats (`seat` minus Opponent) of:
 *
 * - **Pip count** (weight {@link WEIGHTS}.pip per pip, counted for the
 *   Opponent minus `seat`, as fewer pips is better): the total distance a
 *   Seat's checkers still have to travel, a checker on the bar counting 25.
 *   The core of the evaluation, and all that matters in a pure race.
 * - **Borne off**: each checker already off. Pips already reward it; the bonus
 *   makes bearing off preferred over shuffling checkers inside the home board.
 * - **Bar**: each checker on the bar, on top of its 25 pips, as it must enter
 *   before anything else moves.
 * - **Blots**: single checkers the Opponent could still hit (an Opponent
 *   checker behind it, or on the bar). Blots out of reach (e.g. in a race)
 *   cost nothing.
 * - **Made points**: points holding two or more checkers, which the Opponent
 *   cannot land on; points in the home board count extra, as they also block
 *   checkers entering from the bar.
 *
 * `raw` is in pips; the expectiminimax library averages values over dice
 * rolls, so the evaluation must be cardinal (see `engines/README.md`). It is
 * squashed into (-1, 1), a rough expected result, by
 * `tanh(raw / SCALE)`, and a certain win is worth 1 (`winValue`). The
 * squashing keeps a huge lead from outweighing a real chance to lose.
 * Gammons are not valued: a win is a win.
 *
 * ## Search
 *
 * Backgammon branches wildly: ~20 plays per roll (hundreds for some doubles)
 * times 21 rolls. Depth 1 (pick the play with the best evaluation) takes a
 * millisecond; depth 2 (every roll, the Opponent's best reply) a few hundred;
 * depth 3 about half a minute in the opening. So {@link DEFAULT_MAX_DEPTH}
 * caps searches that set no `maxDepth`, keeping Engine Matches responsive.
 *
 * Exports `rules` and `engine` so a host can load it by URL in a Worker.
 */
import type { Engine, Seat } from "@boardwright/core";
import { createExpectiminimaxEngine } from "@boardwright/engine-expectiminimax";
import {
  backgammon,
  type BackgammonMove,
  type BackgammonPosition,
  type BackgammonSeat,
  BAR,
} from "@boardwright/game-backgammon";

export const rules = backgammon;

/** Feature weights, in pips. */
export const WEIGHTS = {
  pip: 1,
  off: 2,
  bar: 4,
  blot: 5,
  point: 2,
  homePoint: 3,
} as const;

/** `raw` pips that squash to tanh(1) ≈ 0.76, i.e. a strong but not certain lead. */
export const SCALE = 40;

/** Depth used when a search sets no `maxDepth` (see the module doc). */
export const DEFAULT_MAX_DEPTH = 2;

/** One Seat's checkers per own point (index 1-24; 0 = off, 25 = bar). */
function checkersOf(
  position: BackgammonPosition,
  seat: BackgammonSeat,
): number[] {
  const own = new Array<number>(26).fill(0);
  for (let p = 1; p <= 24; p++) {
    const v = seat === "white"
      ? position.points[p - 1]!
      : -position.points[24 - p]!;
    if (v > 0) own[p] = v;
  }
  own[0] = position.off[seat];
  own[BAR] = position.bar[seat];
  return own;
}

/** The features of one Seat (see the module doc). */
export interface Features {
  readonly pips: number;
  readonly off: number;
  readonly bar: number;
  readonly blots: number;
  readonly points: number;
  readonly homePoints: number;
}

/** The features of `seat` in `position`. */
export function features(
  position: BackgammonPosition,
  seat: BackgammonSeat,
): Features {
  const mine = checkersOf(position, seat);
  const theirs = checkersOf(position, seat === "white" ? "black" : "white");
  // The Opponent's furthest-back checker in `seat`'s numbering: their own
  // point q is `seat`'s point 25 - q, and they move towards `seat`'s 24.
  // A checker on their bar enters at `seat`'s points 1-6, so counts as 0.
  let rearmost = 25;
  if (theirs[BAR]! > 0) rearmost = 0;
  else {
    for (let q = 24; q >= 1; q--) {
      if (theirs[q]! > 0) {
        rearmost = 25 - q;
        break;
      }
    }
  }
  let pips = 25 * mine[BAR]!;
  let blots = 0;
  let points = 0;
  let homePoints = 0;
  for (let p = 1; p <= 24; p++) {
    const n = mine[p]!;
    pips += p * n;
    // Only an Opponent checker behind the blot (a lower point here) can hit it.
    if (n === 1 && rearmost < p) blots++;
    if (n >= 2) {
      points++;
      if (p <= 6) homePoints++;
    }
  }
  return { pips, off: mine[0]!, bar: mine[BAR]!, blots, points, homePoints };
}

/** The evaluation before squashing, in pips, from `seat`'s perspective. */
export function rawEvaluation(
  position: BackgammonPosition,
  seat: BackgammonSeat,
): number {
  const a = features(position, seat);
  const b = features(position, seat === "white" ? "black" : "white");
  return WEIGHTS.pip * (b.pips - a.pips) +
    WEIGHTS.off * (a.off - b.off) +
    WEIGHTS.bar * (b.bar - a.bar) +
    WEIGHTS.blot * (b.blots - a.blots) +
    WEIGHTS.point * (a.points - b.points) +
    WEIGHTS.homePoint * (a.homePoints - b.homePoints);
}

/**
 * Heuristic value of a non-terminal `position` for `seat`, in (-1, 1): a
 * rough expected result (+1 a certain win). Symmetric: the Opponent's value
 * is the negation.
 */
export function evaluate(position: BackgammonPosition, seat: Seat): number {
  return Math.tanh(rawEvaluation(position, seat as BackgammonSeat) / SCALE);
}

const search = createExpectiminimaxEngine({
  rules,
  evaluate,
  name: "Expectiminimax",
  winValue: 1,
});

export const engine: Engine<BackgammonPosition, BackgammonMove> = {
  name: search.name,
  gameId: search.gameId,
  analyze: (position, limits, signal) =>
    search.analyze(
      position,
      { ...limits, maxDepth: limits.maxDepth ?? DEFAULT_MAX_DEPTH },
      signal,
    ),
};
