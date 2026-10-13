import type { GameRules, Notation, Outcome, Seat } from "@boardwright/core";

export type MorrisSeat = "white" | "black";
/** Content of a point: `w` white piece, `b` black piece, `.` empty. */
export type Cell = "w" | "b" | ".";

/** A point name such as `d1` or `g7`. */
export type Point = string;

export interface MorrisPosition {
  /** One entry per point, in `POINTS` order. */
  readonly board: readonly Cell[];
  /** Seat that moves next. Kept after the Match ends; `toMove` hides it. */
  readonly turn: MorrisSeat;
  /** Pieces each Seat still has to place. */
  readonly inHand: { readonly white: number; readonly black: number };
  /** Plies in the moving phase since the last removal (or since it began). */
  readonly quietPlies: number;
  /**
   * Repetition keys (`board` + turn letter) of every Position since the last
   * irreversible event (placement or removal), including the current one.
   * Empty during the placing phase.
   */
  readonly history: readonly string[];
}

/**
 * One Move: a placement (`to` only) or a move/fly (`from` and `to`), plus an
 * optional removal of an opponent piece when it forms a mill.
 */
export interface MorrisMove {
  readonly from?: Point;
  readonly to: Point;
  readonly remove?: Point;
}

export const POINTS: readonly Point[] = [
  "a1",
  "a4",
  "a7",
  "b2",
  "b4",
  "b6",
  "c3",
  "c4",
  "c5",
  "d1",
  "d2",
  "d3",
  "d5",
  "d6",
  "d7",
  "e3",
  "e4",
  "e5",
  "f2",
  "f4",
  "f6",
  "g1",
  "g4",
  "g7",
];

/** The 16 mills; consecutive points on a line are adjacent. */
const LINE_NAMES: readonly (readonly [Point, Point, Point])[] = [
  ["a1", "d1", "g1"],
  ["b2", "d2", "f2"],
  ["c3", "d3", "e3"],
  ["a4", "b4", "c4"],
  ["e4", "f4", "g4"],
  ["c5", "d5", "e5"],
  ["b6", "d6", "f6"],
  ["a7", "d7", "g7"],
  ["a1", "a4", "a7"],
  ["b2", "b4", "b6"],
  ["c3", "c4", "c5"],
  ["d1", "d2", "d3"],
  ["d5", "d6", "d7"],
  ["e3", "e4", "e5"],
  ["f2", "f4", "f6"],
  ["g1", "g4", "g7"],
];

const INDEX = new Map(POINTS.map((p, i) => [p, i]));

function idx(point: Point): number {
  const i = INDEX.get(point);
  if (i === undefined) {
    throw new Error(`Unknown point ${JSON.stringify(point)}`);
  }
  return i;
}

const LINES: readonly (readonly number[])[] = LINE_NAMES.map((l) => l.map(idx));

const NEIGHBORS: readonly (readonly number[])[] = (() => {
  const adj: number[][] = POINTS.map(() => []);
  for (const [a, b, c] of LINES) {
    adj[a!]!.push(b!);
    adj[b!]!.push(a!, c!);
    adj[c!]!.push(b!);
  }
  return adj;
})();

const PIECES = 9;
export const QUIET_PLY_LIMIT = 50;
export const REPETITION_LIMIT = 3;

const LETTER: Record<MorrisSeat, "w" | "b"> = { white: "w", black: "b" };
const other = (
  s: MorrisSeat,
): MorrisSeat => (s === "white" ? "black" : "white");

function count(board: readonly Cell[], seat: MorrisSeat): number {
  return board.filter((c) => c === LETTER[seat]).length;
}

/** Pieces on the board plus in hand. */
function total(p: MorrisPosition, seat: MorrisSeat): number {
  return count(p.board, seat) + p.inHand[seat];
}

function inMill(board: readonly Cell[], point: number): boolean {
  const c = board[point]!;
  return LINES.some((l) => l.includes(point) && l.every((i) => board[i] === c));
}

function repetitionKey(board: readonly Cell[], turn: MorrisSeat): string {
  return board.join("") + LETTER[turn];
}

function removalChoices(board: readonly Cell[], victim: MorrisSeat): number[] {
  const mine: number[] = [];
  board.forEach((c, i) => {
    if (c === LETTER[victim]) mine.push(i);
  });
  const free = mine.filter((i) => !inMill(board, i));
  return free.length > 0 ? free : mine;
}

interface Step {
  readonly from?: number;
  readonly to: number;
}

function steps(p: MorrisPosition): Step[] {
  const seat = p.turn;
  const letter = LETTER[seat];
  const empties: number[] = [];
  p.board.forEach((c, i) => {
    if (c === ".") empties.push(i);
  });
  if (p.inHand[seat] > 0) return empties.map((to) => ({ to }));
  const flying = count(p.board, seat) === 3;
  const result: Step[] = [];
  p.board.forEach((c, from) => {
    if (c !== letter) return;
    const targets = flying
      ? empties
      : NEIGHBORS[from]!.filter((t) => p.board[t] === ".");
    for (const to of targets) result.push({ from, to });
  });
  return result;
}

function movesOf(p: MorrisPosition): MorrisMove[] {
  const moves: MorrisMove[] = [];
  for (const s of steps(p)) {
    const board = p.board.slice();
    board[s.to] = LETTER[p.turn];
    if (s.from !== undefined) board[s.from] = ".";
    const base = {
      ...(s.from === undefined ? {} : { from: POINTS[s.from]! }),
      to: POINTS[s.to]!,
    };
    if (inMill(board, s.to)) {
      const choices = removalChoices(board, other(p.turn));
      // Opponent may have nothing on the board yet (all pieces in hand).
      if (choices.length === 0) moves.push(base);
      for (const r of choices) moves.push({ ...base, remove: POINTS[r]! });
    } else {
      moves.push(base);
    }
  }
  return moves;
}

function encodeMove(move: MorrisMove): string {
  return (move.from ? `${move.from}-` : "") + move.to +
    (move.remove ? `x${move.remove}` : "");
}

function encodePosition(p: MorrisPosition): string {
  return [
    p.board.join(""),
    LETTER[p.turn],
    p.inHand.white,
    p.inHand.black,
    p.quietPlies,
    p.history.join(","),
  ].join(":");
}

function decodePosition(text: string): MorrisPosition {
  const bad = (why: string): never => {
    throw new Error(
      `Invalid nine-men's-morris position (${why}): ${JSON.stringify(text)}`,
    );
  };
  const m =
    /^([wb.]{24}):([wb]):(\d):(\d):(\d{1,2}):((?:[wb.]{24}[wb](?:,[wb.]{24}[wb])*)?)$/
      .exec(text);
  if (!m) return bad("syntax");
  const board = [...m[1]!] as Cell[];
  const turn: MorrisSeat = m[2] === "w" ? "white" : "black";
  const inHand = { white: Number(m[3]), black: Number(m[4]) };
  const quietPlies = Number(m[5]);
  const history = m[6] === "" ? [] : m[6]!.split(",");
  const position: MorrisPosition = { board, turn, inHand, quietPlies, history };
  for (const s of ["white", "black"] as const) {
    if (total(position, s) > PIECES) return bad("too many pieces");
  }
  const placing = inHand.white > 0 || inHand.black > 0;
  const handsOk = turn === "white"
    ? inHand.white === inHand.black
    : inHand.black === inHand.white + 1 || !placing;
  if (!handsOk) return bad("hands do not match side to move");
  if (quietPlies > QUIET_PLY_LIMIT) return bad("quiet plies");
  if (placing) {
    if (quietPlies !== 0 || history.length !== 0) {
      return bad("counters during placing phase");
    }
  } else {
    if (history.at(-1) !== repetitionKey(board, turn)) {
      return bad("history must end with the current position");
    }
    if (quietPlies !== history.length - 1) return bad("quiet plies vs history");
  }
  return position;
}

function decodeMove(text: string): MorrisMove {
  const m = /^([a-g][1-7])(?:-([a-g][1-7]))?(?:x([a-g][1-7]))?$/.exec(text);
  if (
    !m || !INDEX.has(m[1]!) || (m[2] && !INDEX.has(m[2])) ||
    (m[3] && !INDEX.has(m[3]))
  ) {
    throw new Error(`Invalid nine-men's-morris move: ${JSON.stringify(text)}`);
  }
  return {
    ...(m[2] ? { from: m[1]! } : {}),
    to: m[2] ?? m[1]!,
    ...(m[3] ? { remove: m[3] } : {}),
  };
}

const notation: Notation<MorrisPosition, MorrisMove> = {
  encodePosition,
  decodePosition,
  encodeMove,
  decodeMove,
};

export const nineMensMorris: GameRules<MorrisPosition, MorrisMove> = {
  id: "nine-mens-morris",
  name: "Nine men's morris",
  seats: ["white", "black"],
  initialPosition: () => ({
    board: Array<Cell>(POINTS.length).fill("."),
    turn: "white",
    inHand: { white: PIECES, black: PIECES },
    quietPlies: 0,
    history: [],
  }),
  toMove(position): Seat | undefined {
    return nineMensMorris.outcome(position) ? undefined : position.turn;
  },
  legalMoves(position) {
    return nineMensMorris.outcome(position) ? [] : movesOf(position);
  },
  /** Throws if `move` is not legal in `position`. */
  play(position, move) {
    const fail = (): never => {
      throw new Error(
        `Illegal move ${JSON.stringify(encodeMove(move))} in ${
          encodePosition(position)
        }`,
      );
    };
    if (nineMensMorris.outcome(position)) return fail();
    const to = INDEX.get(move.to);
    const from = move.from === undefined ? undefined : INDEX.get(move.from);
    const remove = move.remove === undefined
      ? undefined
      : INDEX.get(move.remove);
    if (
      to === undefined || (move.from !== undefined && from === undefined) ||
      (move.remove !== undefined && remove === undefined) ||
      !steps(position).some((s) => s.from === from && s.to === to)
    ) return fail();
    const seat = position.turn;
    const board = position.board.slice();
    board[to] = LETTER[seat];
    if (from !== undefined) board[from] = ".";
    const choices = inMill(board, to) ? removalChoices(board, other(seat)) : [];
    // A mill requires a removal whenever the opponent has a piece to remove.
    if (
      choices.length === 0 ? remove !== undefined : !choices.includes(remove!)
    ) {
      return fail();
    }
    if (remove !== undefined) board[remove] = ".";
    const placing = position.inHand[seat] > 0;
    const inHand = placing
      ? { ...position.inHand, [seat]: position.inHand[seat] - 1 }
      : position.inHand;
    const turn = other(seat);
    const movingNext = inHand.white === 0 && inHand.black === 0;
    const irreversible = placing || remove !== undefined;
    const key = repetitionKey(board, turn);
    return {
      board,
      turn,
      inHand,
      quietPlies: irreversible ? 0 : position.quietPlies + 1,
      history: !movingNext
        ? []
        : irreversible
        ? [key]
        : [...position.history, key],
    };
  },
  outcome(position): Outcome | undefined {
    for (const s of ["white", "black"] as const) {
      if (total(position, s) < 3) {
        return { winner: other(s), reason: "fewer-than-three-pieces" };
      }
    }
    if (steps(position).length === 0) {
      return { winner: other(position.turn), reason: "no-legal-moves" };
    }
    if (position.inHand.white === 0 && position.inHand.black === 0) {
      const last = position.history.at(-1);
      const seen = position.history.filter((k) => k === last).length;
      if (seen >= REPETITION_LIMIT) return { reason: "threefold-repetition" };
      if (position.quietPlies >= QUIET_PLY_LIMIT) {
        return { reason: "fifty-moves-without-removal" };
      }
    }
    return undefined;
  },
  notation,
};
