import type {
  ChanceGameRules,
  ChanceResult,
  RulesOutcome,
} from "@boardwright/core";

/** The two Seats; white moves its checkers from its 24-point towards its 1-point. */
export type BackgammonSeat = "white" | "black";

/** Checkers per Seat. */
export const CHECKERS = 15;
/** Point number of the bar in a Seat's own numbering (a Step from the bar enters). */
export const BAR = 25;
/** Point number of "off the board" in a Seat's own numbering (a Step there bears off). */
export const OFF = 0;

/**
 * A backgammon Position. Points are stored in white's numbering: `points[i]`
 * is white's point `i + 1`, which is black's point `24 - i`. A positive count
 * is white checkers, a negative one black checkers.
 */
export interface BackgammonPosition {
  /** 24 entries, white's 1-point first; > 0 white checkers, < 0 black. */
  readonly points: readonly number[];
  readonly bar: Readonly<Record<BackgammonSeat, number>>;
  readonly off: Readonly<Record<BackgammonSeat, number>>;
  /**
   * The Seat to move (dice rolled) or to roll next (dice pending); `null`
   * before the opening roll.
   */
  readonly turn: BackgammonSeat | null;
  /** The roll to play, larger die first; `null` while the roll is pending. */
  readonly dice: readonly [number, number] | null;
}

/**
 * One checker moved by one die, in the mover's own numbering: `from` 1-24
 * or {@link BAR}, `to` 1-24 or {@link OFF}.
 */
export interface Step {
  readonly from: number;
  readonly to: number;
}

/**
 * The full play of one roll: its Steps in the order played; empty when no
 * checker can move ("pass").
 */
export interface BackgammonMove {
  readonly steps: readonly Step[];
}

/**
 * A Chance event's result: the opening roll (one die per Seat, never equal;
 * the higher die's Seat moves first and plays both dice) or a regular roll
 * of the Seat to move (larger die first).
 */
export type BackgammonRoll =
  | {
    readonly kind: "opening";
    readonly white: number;
    readonly black: number;
  }
  | { readonly kind: "roll"; readonly dice: readonly [number, number] };

export const opponent = (seat: BackgammonSeat): BackgammonSeat =>
  seat === "white" ? "black" : "white";

/** Absolute index into `points` of `seat`'s own point `p` (1-24). */
const index = (seat: BackgammonSeat, p: number) =>
  seat === "white" ? p - 1 : 24 - p;

/** White's 1-point first. */
const INITIAL_POINTS: readonly number[] = (() => {
  const points = new Array<number>(24).fill(0);
  for (const [p, n] of [[24, 2], [13, 5], [8, 3], [6, 5]] as const) {
    points[index("white", p)] = n;
    points[index("black", p)] = -n;
  }
  return points;
})();

/**
 * The board from the mover's point of view, as mutable arrays for move
 * generation: `mine[p]` own checkers on own point p (0 = off, 25 = bar),
 * `theirs[p]` Opponent checkers on own point p (1-24), `theirBar`.
 */
interface Board {
  readonly mine: number[];
  readonly theirs: number[];
  theirBar: number;
}

function boardOf(position: BackgammonPosition, seat: BackgammonSeat): Board {
  const sign = seat === "white" ? 1 : -1;
  const mine = new Array<number>(26).fill(0);
  const theirs = new Array<number>(26).fill(0);
  for (let p = 1; p <= 24; p++) {
    const v = sign * position.points[index(seat, p)]!;
    if (v > 0) mine[p] = v;
    else theirs[p] = -v;
  }
  mine[OFF] = position.off[seat];
  mine[BAR] = position.bar[seat];
  return { mine, theirs, theirBar: position.bar[opponent(seat)] };
}

const copyBoard = (b: Board): Board => ({
  mine: [...b.mine],
  theirs: [...b.theirs],
  theirBar: b.theirBar,
});

const boardKey = (b: Board) =>
  `${b.mine.join(",")}|${b.theirs.join(",")}|${b.theirBar}`;

/**
 * Where a checker on own point `from` lands with die `die`, or `undefined`
 * if that Step is not allowed: checkers on the bar enter first; the target
 * must not hold two or more Opponent checkers; bearing off needs all
 * checkers in the home board (points 1-6), and a die larger than needed may
 * bear off only the checker on the highest occupied point.
 */
function target(b: Board, from: number, die: number): number | undefined {
  const { mine, theirs } = b;
  if (mine[from]! === 0) return undefined;
  if (mine[BAR]! > 0 && from !== BAR) return undefined;
  const to = from - die;
  if (to >= 1) return theirs[to]! <= 1 ? to : undefined;
  for (let p = 7; p <= BAR; p++) if (mine[p]! > 0) return undefined;
  if (to < 0) {
    for (let p = from + 1; p <= 6; p++) if (mine[p]! > 0) return undefined;
  }
  return OFF;
}

/** Applies a Step already checked by {@link target}; hits a single Opponent checker. */
function apply(b: Board, from: number, to: number): void {
  b.mine[from]!--;
  b.mine[to]!++;
  if (to !== OFF && b.theirs[to] === 1) {
    b.theirs[to] = 0;
    b.theirBar++;
  }
}

/** A legal play with the Board it leads to. */
interface Play {
  readonly move: BackgammonMove;
  readonly board: Board;
  readonly key: string;
}

/**
 * Every legal play of `dice` on `start`, one per distinct resulting
 * Position (the first found is the canonical Move): as many dice as possible
 * must be used; if only one die of a non-double can be used, the larger one
 * if possible. A single empty play when nothing can move.
 */
function generatePlays(
  start: Board,
  dice: readonly [number, number],
): Play[] {
  const [high, low] = dice;
  const double = high === low;
  interface Node {
    readonly steps: Step[];
    readonly dice: number[];
    readonly board: Board;
  }
  const found: Node[] = [];
  let most = 0;
  const visit = (node: Node, left: readonly number[], maxFrom: number) => {
    found.push(node);
    most = Math.max(most, node.steps.length);
    const tried = new Set<number>();
    for (const [i, die] of left.entries()) {
      if (tried.has(die)) continue;
      tried.add(die);
      const rest = left.filter((_, j) => j !== i);
      // With equal dice, playing higher checkers first loses no result.
      for (let from = double ? maxFrom : BAR; from >= 1; from--) {
        const to = target(node.board, from, die);
        if (to === undefined) continue;
        const board = copyBoard(node.board);
        apply(board, from, to);
        visit(
          {
            steps: [...node.steps, { from, to }],
            dice: [...node.dice, die],
            board,
          },
          rest,
          from,
        );
      }
    }
  };
  visit(
    { steps: [], dice: [], board: start },
    double ? [high, high, high, high] : [high, low],
    BAR,
  );
  let best = found.filter((n) => n.steps.length === most);
  if (most === 1 && !double && best.some((n) => n.dice[0] === high)) {
    best = best.filter((n) => n.dice[0] === high);
  }
  const plays = new Map<string, Play>();
  for (const n of best) {
    const key = boardKey(n.board);
    if (plays.has(key)) continue;
    // Conventional order: higher points first (stable), when that order
    // plays to the same Position (moving higher checkers first only relaxes
    // the bar and bearing-off conditions, so it always does).
    const sorted = [...n.steps].sort((a, b) => b.from - a.from);
    const same = playSteps(start, dice, sorted);
    const steps = same && boardKey(same) === key ? sorted : n.steps;
    plays.set(key, { move: { steps }, board: n.board, key });
  }
  return [...plays.values()];
}

/**
 * The Board after `steps` with some assignment of `dice` to them (in the
 * order given), or `undefined` if no assignment allows them. Does not check
 * that the play uses as many dice as it must.
 */
function playSteps(
  start: Board,
  dice: readonly [number, number],
  steps: readonly Step[],
): Board | undefined {
  const [high, low] = dice;
  const all = high === low ? [high, high, high, high] : [high, low];
  const go = (
    b: Board,
    i: number,
    left: readonly number[],
  ): Board | undefined => {
    const step = steps[i];
    if (step === undefined) return b;
    for (const [j, die] of left.entries()) {
      if (target(b, step.from, die) !== step.to) continue;
      const next = copyBoard(b);
      apply(next, step.from, step.to);
      const done: Board | undefined = go(
        next,
        i + 1,
        left.filter((_, k) => k !== j),
      );
      if (done) return done;
    }
    return undefined;
  };
  return steps.length > all.length ? undefined : go(start, 0, all);
}

const playsCache = new WeakMap<BackgammonPosition, Play[]>();

/** The legal plays in `position`; empty unless a Seat is to move. */
function plays(position: BackgammonPosition): Play[] {
  let cached = playsCache.get(position);
  if (cached === undefined) {
    const { turn, dice } = position;
    cached = turn === null || dice === null || outcomeOf(position)
      ? []
      : generatePlays(boardOf(position, turn), dice);
    playsCache.set(position, cached);
  }
  return cached;
}

/** The Position after `seat` played to `board`; the Opponent rolls next. */
function positionAfter(
  position: BackgammonPosition,
  seat: BackgammonSeat,
  board: Board,
): BackgammonPosition {
  const sign = seat === "white" ? 1 : -1;
  const points = new Array<number>(24).fill(0);
  for (let p = 1; p <= 24; p++) {
    points[index(seat, p)] = sign * (board.mine[p]! - board.theirs[p]!);
  }
  const other = opponent(seat);
  return {
    points,
    bar: { [seat]: board.mine[BAR]!, [other]: board.theirBar } as Record<
      BackgammonSeat,
      number
    >,
    off: { ...position.off, [seat]: board.mine[OFF]! },
    turn: other,
    dice: null,
  };
}

function outcomeOf(position: BackgammonPosition): RulesOutcome | undefined {
  const winner: BackgammonSeat | undefined = position.off.white === CHECKERS
    ? "white"
    : position.off.black === CHECKERS
    ? "black"
    : undefined;
  if (winner === undefined) return undefined;
  const loser = opponent(winner);
  if (position.off[loser] > 0) return { winner, reason: "single" };
  // The loser's checkers in the winner's home board (winner's points 1-6).
  let inHome = position.bar[loser] > 0;
  for (let p = 1; p <= 6; p++) {
    const v = position.points[index(winner, p)]!;
    if (winner === "white" ? v < 0 : v > 0) inHome = true;
  }
  return { winner, reason: inHome ? "backgammon" : "gammon" };
}

const OPENING_ROLLS: readonly ChanceResult<BackgammonRoll>[] = (() => {
  const rolls: ChanceResult<BackgammonRoll>[] = [];
  for (let white = 1; white <= 6; white++) {
    for (let black = 1; black <= 6; black++) {
      if (white !== black) {
        rolls.push({
          chance: { kind: "opening", white, black },
          probability: 1 / 30,
        });
      }
    }
  }
  return rolls;
})();

const ROLLS: readonly ChanceResult<BackgammonRoll>[] = (() => {
  const rolls: ChanceResult<BackgammonRoll>[] = [];
  for (let high = 6; high >= 1; high--) {
    for (let low = high; low >= 1; low--) {
      rolls.push({
        chance: { kind: "roll", dice: [high, low] },
        probability: high === low ? 1 / 36 : 2 / 36,
      });
    }
  }
  return rolls;
})();

const isDie = (n: unknown) =>
  Number.isInteger(n) && 1 <= Number(n) && Number(n) <= 6;

/** Validates a Position decoded from Notation (or built by hand). */
export function checkPosition(position: BackgammonPosition): void {
  const { points, bar, off, turn, dice } = position;
  if (points.length !== 24 || !points.every(Number.isInteger)) {
    throw new Error("a Position has 24 points with whole checker counts");
  }
  for (const seat of ["white", "black"] as const) {
    const sign = seat === "white" ? 1 : -1;
    const onBoard = points.reduce((s, v) => s + Math.max(0, sign * v), 0);
    if (
      !Number.isInteger(bar[seat]) || bar[seat] < 0 ||
      !Number.isInteger(off[seat]) || off[seat] < 0 ||
      onBoard + bar[seat] + off[seat] !== CHECKERS
    ) {
      throw new Error(`${seat} must have ${CHECKERS} checkers`);
    }
  }
  if (off.white === CHECKERS && off.black === CHECKERS) {
    throw new Error("both Seats cannot have borne off every checker");
  }
  if (dice !== null) {
    if (turn === null) throw new Error("dice need a Seat to play them");
    if (!isDie(dice[0]) || !isDie(dice[1]) || dice[0] < dice[1]) {
      throw new Error("dice are two values 1-6, larger first");
    }
  }
}

function checkRoll(roll: BackgammonRoll): void {
  if (roll.kind === "opening") {
    if (!isDie(roll.white) || !isDie(roll.black) || roll.white === roll.black) {
      throw new Error("an opening roll is two different dice 1-6");
    }
  } else if (
    !isDie(roll.dice[0]) || !isDie(roll.dice[1]) || roll.dice[0] < roll.dice[1]
  ) {
    throw new Error("a roll is two dice 1-6, larger first");
  }
}

const pointName = (p: number) =>
  p === BAR ? "bar" : p === OFF ? "off" : String(p);

/** Notation of a Move: `pass`, or its Steps in order, e.g. `bar/22 13/11` or `6/off 5/off`. */
export function encodeMove(move: BackgammonMove): string {
  if (move.steps.length === 0) return "pass";
  return move.steps.map((s) => `${pointName(s.from)}/${pointName(s.to)}`)
    .join(" ");
}

/**
 * Parses Move Notation into Steps without checking them against a Position:
 * Steps separated by spaces; chains such as `24/18/13`; an optional `*` after
 * a point (hits are implied); `(n)` repeats a Step or chain n times.
 */
export function parseMove(text: string): BackgammonMove {
  const bad = () => new Error(`bad backgammon Move ${JSON.stringify(text)}`);
  if (text === "pass") return { steps: [] };
  const tokens = text.split(" ");
  const steps: Step[] = [];
  for (const token of tokens) {
    const m = /^((?:bar|\d{1,2})\*?(?:\/(?:off|\d{1,2})\*?)+)(?:\(([1-4])\))?$/
      .exec(token);
    if (!m) throw bad();
    const names = m[1]!.replaceAll("*", "").split("/");
    const chain: Step[] = [];
    for (let i = 1; i < names.length; i++) {
      const from = names[i - 1] === "bar" ? BAR : Number(names[i - 1]);
      const to = names[i] === "off" ? OFF : Number(names[i]);
      if (
        (names[i - 1] === "off") ||
        (names[i - 1] !== "bar" && (from < 1 || from > 24)) ||
        (to !== OFF && (to < 1 || to > 24)) || to >= from ||
        (from === BAR && i > 1) || (names[i] === "off" && i < names.length - 1)
      ) {
        throw bad();
      }
      chain.push({ from, to });
    }
    for (let k = 0; k < Number(m[2] ?? 1); k++) steps.push(...chain);
  }
  if (steps.length > 4) throw bad();
  return { steps };
}

/** Text of the dice, e.g. `62`, `33`; `-` while pending. */
const diceText = (dice: BackgammonPosition["dice"]) =>
  dice === null ? "-" : `${dice[0]}${dice[1]}`;

/**
 * Notation of a Position: `<points> <bar> <turn> <dice>`, e.g. the initial
 * `b2,0,0,0,0,w5,0,w3,0,0,0,b5,w5,0,0,0,b3,0,b5,0,0,0,0,w2 0/0 - -`.
 */
export function encodePosition(position: BackgammonPosition): string {
  const points = position.points.map((v) =>
    v > 0 ? `w${v}` : v < 0 ? `b${-v}` : "0"
  ).join(",");
  return `${points} ${position.bar.white}/${position.bar.black} ${
    position.turn ?? "-"
  } ${diceText(position.dice)}`;
}

export function decodePosition(text: string): BackgammonPosition {
  const m =
    /^((?:0|[wb](?:[1-9]|1[0-5]))(?:,(?:0|[wb](?:[1-9]|1[0-5]))){23}) (\d|1[0-5])\/(\d|1[0-5]) (white|black|-) (-|[1-6][1-6])$/
      .exec(text);
  if (!m) throw new Error(`bad backgammon Position ${JSON.stringify(text)}`);
  const points = m[1]!.split(",").map((s) =>
    s === "0" ? 0 : (s[0] === "w" ? 1 : -1) * Number(s.slice(1))
  );
  const bar = { white: Number(m[2]), black: Number(m[3]) };
  const count = (sign: number) =>
    points.reduce((s, v) => s + Math.max(0, sign * v), 0);
  const position: BackgammonPosition = {
    points,
    bar,
    off: {
      white: CHECKERS - count(1) - bar.white,
      black: CHECKERS - count(-1) - bar.black,
    },
    turn: m[4] === "-" ? null : m[4] as BackgammonSeat,
    dice: m[5] === "-" ? null : [Number(m[5]![0]), Number(m[5]![1])],
  };
  try {
    checkPosition(position);
  } catch (e) {
    throw new Error(
      `bad backgammon Position ${JSON.stringify(text)}: ${
        (e as Error).message
      }`,
    );
  }
  return position;
}

/** Notation of a roll: `62` (larger die first), `33`; opening `3-6` (white's die, then black's). */
export function encodeRoll(roll: BackgammonRoll): string {
  return roll.kind === "opening"
    ? `${roll.white}-${roll.black}`
    : `${roll.dice[0]}${roll.dice[1]}`;
}

export function decodeRoll(text: string): BackgammonRoll {
  const opening = /^([1-6])-([1-6])$/.exec(text);
  const regular = /^([1-6])([1-6])$/.exec(text);
  const roll: BackgammonRoll | undefined = opening
    ? { kind: "opening", white: Number(opening[1]), black: Number(opening[2]) }
    : regular
    ? { kind: "roll", dice: [Number(regular[1]), Number(regular[2])] }
    : undefined;
  try {
    if (roll === undefined) throw new Error("syntax");
    checkRoll(roll);
  } catch {
    throw new Error(`bad backgammon roll ${JSON.stringify(text)}`);
  }
  return roll;
}

/** Backgammon without the doubling cube; see the package README for the rules. */
export const backgammon: ChanceGameRules<
  BackgammonPosition,
  BackgammonMove,
  BackgammonRoll
> = {
  id: "backgammon",
  name: "Backgammon",
  seats: ["white", "black"],
  initialPosition: () => ({
    points: INITIAL_POINTS,
    bar: { white: 0, black: 0 },
    off: { white: 0, black: 0 },
    turn: null,
    dice: null,
  }),
  toMove: (position) =>
    position.dice === null || outcomeOf(position)
      ? undefined
      : position.turn ?? undefined,
  legalMoves: (position) => plays(position).map((p) => p.move),
  play(position, move) {
    const seat = position.turn;
    const legal = plays(position);
    const board = seat === null || position.dice === null || legal.length === 0
      ? undefined
      : playSteps(boardOf(position, seat), position.dice, move.steps);
    const key = board && boardKey(board);
    const found = legal.find((p) => p.key === key);
    if (seat === null || found === undefined) {
      throw new Error(`illegal backgammon Move ${encodeMove(move)}`);
    }
    return positionAfter(position, seat, found.board);
  },
  outcome: outcomeOf,
  chanceEvents: (position) =>
    position.dice !== null || outcomeOf(position)
      ? []
      : position.turn === null
      ? OPENING_ROLLS
      : ROLLS,
  resolveChance(position, roll) {
    checkRoll(roll);
    const pending = position.dice === null && !outcomeOf(position);
    if (!pending || (position.turn === null) !== (roll.kind === "opening")) {
      throw new Error(
        `roll ${encodeRoll(roll)} is not pending in ${
          encodePosition(position)
        }`,
      );
    }
    if (roll.kind === "opening") {
      const high = Math.max(roll.white, roll.black);
      const low = Math.min(roll.white, roll.black);
      return {
        ...position,
        turn: roll.white > roll.black ? "white" : "black",
        dice: [high, low],
      };
    }
    return { ...position, dice: roll.dice };
  },
  notation: {
    encodePosition,
    decodePosition,
    encodeMove,
    /**
     * Matches by resulting Position: Steps in any playable order (and
     * grouping) that lead to the same Position as a legal play decode to
     * that play's canonical Move (as `legalMoves` lists it), so they encode
     * the same way. E.g. with 65 and checkers on the 6- and 1-points,
     * `6/off` stands for `6/1 1/off`. Other syntactically valid Moves decode
     * as written (and `play` rejects them).
     */
    decodeMove(text, position) {
      const move = parseMove(text);
      const seat = position.turn;
      if (seat === null || position.dice === null) return move;
      const board = playSteps(
        boardOf(position, seat),
        position.dice,
        move.steps,
      );
      if (board === undefined) return move;
      const key = boardKey(board);
      return plays(position).find((p) => p.key === key)?.move ?? move;
    },
    encodeChance: encodeRoll,
    decodeChance: (text) => decodeRoll(text),
  },
};
