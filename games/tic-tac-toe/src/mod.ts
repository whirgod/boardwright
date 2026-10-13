import type { GameRules, Notation, Outcome, Seat } from "@boardwright/core";

export type TicTacToeSeat = "x" | "o";
export type Cell = TicTacToeSeat | ".";

/** Cells row-major from a1: a1 b1 c1 a2 b2 c2 a3 b3 c3. */
export interface TicTacToePosition {
  readonly cells: readonly Cell[];
  /** Seat that moves next. Kept after the Match ends; `toMove` hides it. */
  readonly turn: TicTacToeSeat;
}

/** A cell name `a1`..`c3` (file a-c, rank 1-3). */
export type TicTacToeMove = string;

const LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

const SIZE = 9;

function cellName(index: number): string {
  return "abc"[index % 3]! + String(Math.floor(index / 3) + 1);
}

function winner(cells: readonly Cell[]): TicTacToeSeat | undefined {
  for (const [a, b, c] of LINES) {
    const v = cells[a];
    if (v !== "." && v !== undefined && v === cells[b] && v === cells[c]) {
      return v;
    }
  }
  return undefined;
}

const notation: Notation<TicTacToePosition, TicTacToeMove> = {
  encodePosition: (p) => `${p.cells.join("")}:${p.turn}`,
  decodePosition(text) {
    const m = /^([xo.]{9}):([xo])$/.exec(text);
    if (!m) {
      throw new Error(`Invalid tic-tac-toe position: ${JSON.stringify(text)}`);
    }
    const cells = [...m[1]!] as Cell[];
    const turn = m[2] as TicTacToeSeat;
    const xs = cells.filter((c) => c === "x").length;
    const os = cells.filter((c) => c === "o").length;
    if (xs !== os && xs !== os + 1) {
      throw new Error(`Invalid tic-tac-toe position (piece counts): ${text}`);
    }
    if (turn !== (xs === os ? "x" : "o")) {
      throw new Error(`Invalid tic-tac-toe position (side to move): ${text}`);
    }
    return { cells, turn };
  },
  encodeMove: (move) => move,
  decodeMove(text) {
    if (!/^[a-c][1-3]$/.test(text)) {
      throw new Error(`Invalid tic-tac-toe move: ${JSON.stringify(text)}`);
    }
    return text;
  },
};

export const ticTacToe: GameRules<TicTacToePosition, TicTacToeMove> = {
  id: "tic-tac-toe",
  name: "Tic-tac-toe",
  seats: ["x", "o"],
  initialPosition: () => ({ cells: Array<Cell>(SIZE).fill("."), turn: "x" }),
  toMove(position): Seat | undefined {
    return ticTacToe.outcome(position) ? undefined : position.turn;
  },
  legalMoves(position) {
    if (ticTacToe.outcome(position)) return [];
    const moves: string[] = [];
    position.cells.forEach((c, i) => {
      if (c === ".") moves.push(cellName(i));
    });
    return moves;
  },
  /** Throws if `move` is not legal in `position`. */
  play(position, move) {
    if (!ticTacToe.legalMoves(position).includes(move)) {
      throw new Error(
        `Illegal move ${JSON.stringify(move)} in ${
          notation.encodePosition(position)
        }`,
      );
    }
    const index = (move.charCodeAt(0) - 97) + (Number(move[1]) - 1) * 3;
    const cells = position.cells.slice();
    cells[index] = position.turn;
    return { cells, turn: position.turn === "x" ? "o" : "x" };
  },
  outcome(position): Outcome | undefined {
    const w = winner(position.cells);
    if (w) return { winner: w, reason: "three-in-a-row" };
    if (position.cells.every((c) => c !== ".")) return { reason: "board-full" };
    return undefined;
  },
  notation,
};
