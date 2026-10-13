import type {
  CheckersMove,
  CheckersPosition,
} from "@boardwright/game-checkers";
import { composeMove } from "./compose.ts";
import type { BoardRenderer, Shape, Target } from "./board.ts";

const CELL = 100;
const SIZE = 8 * CELL;

/** Row (0 at top, White's side at the bottom) and column of square 1..32. */
function cell(square: number): { row: number; col: number } {
  const i = square - 1;
  const row = Math.floor(i / 4);
  return { row, col: row % 2 === 0 ? 2 * (i % 4) + 1 : 2 * (i % 4) };
}

/** Algebraic name of a square (1 = b8, 32 = g1). */
export function squareName(square: number): string {
  const { row, col } = cell(square);
  return "abcdefgh"[col]! + String(8 - row);
}

const clicks = (move: CheckersMove) => move.map(String);

const SEATS = { b: "black", B: "black", w: "white", W: "white" } as const;

export const checkersRenderer: BoardRenderer<
  CheckersPosition,
  CheckersMove
> = {
  scene(position) {
    const board: Shape[] = [
      {
        kind: "rect",
        x: 0,
        y: 0,
        width: SIZE,
        height: SIZE,
        className: "board",
      },
    ];
    const pieces: Shape[] = [];
    const targets: Target[] = [];
    position.board.forEach((piece, i) => {
      const square = i + 1;
      const { row, col } = cell(square);
      const [x, y] = [col * CELL, row * CELL];
      board.push({
        kind: "rect",
        x,
        y,
        width: CELL,
        height: CELL,
        className: "square-dark",
      });
      const center = { x: x + CELL / 2, y: y + CELL / 2 };
      const king = piece === "B" || piece === "W";
      if (piece !== ".") {
        pieces.push({
          kind: "circle",
          center,
          r: CELL / 2 - 12,
          className: `disc disc-${SEATS[piece]}`,
        });
        if (king) {
          pieces.push({
            kind: "circle",
            center,
            r: CELL / 4,
            className: "king-mark",
          });
        }
      }
      const what = piece === "."
        ? "empty"
        : `${SEATS[piece]} ${king ? "king" : "man"}`;
      targets.push({
        id: String(square),
        label: `${squareName(square)} (${square}): ${what}`,
        x,
        y,
        width: CELL,
        height: CELL,
      });
    });
    return { width: SIZE, height: SIZE, board, pieces, targets };
  },
  /** Every visited square is on the path, so a multi-jump is clicked square by square. */
  moveTargets: (move) => ({ path: clicks(move) }),
  input: (_position, legalMoves, selection, target) =>
    composeMove(clicks, legalMoves, selection, target),
};
