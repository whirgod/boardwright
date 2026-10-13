import type {
  TicTacToeMove,
  TicTacToePosition,
} from "@boardwright/game-tic-tac-toe";
import type { BoardRenderer, Shape, Target } from "./board.ts";

const CELL = 100;
const SIZE = 3 * CELL;
const PAD = 22;

/** Cell name (`a1`..`c3`) of a row-major index from a1, as in the Game's Position. */
function cellName(index: number): string {
  return "abc"[index % 3]! + String(Math.floor(index / 3) + 1);
}

/** Top-left corner of a cell; rank 3 is drawn at the top. */
function corner(index: number): { x: number; y: number } {
  return { x: (index % 3) * CELL, y: (2 - Math.floor(index / 3)) * CELL };
}

function grid(): Shape[] {
  const lines: Shape[] = [];
  for (const at of [CELL, 2 * CELL]) {
    lines.push({
      kind: "line",
      from: { x: at, y: 0 },
      to: { x: at, y: SIZE },
      className: "grid",
    });
    lines.push({
      kind: "line",
      from: { x: 0, y: at },
      to: { x: SIZE, y: at },
      className: "grid",
    });
  }
  return lines;
}

function piece(index: number, seat: "x" | "o"): Shape[] {
  const { x, y } = corner(index);
  if (seat === "o") {
    return [{
      kind: "circle",
      center: { x: x + CELL / 2, y: y + CELL / 2 },
      r: CELL / 2 - PAD,
      className: "piece piece-o",
    }];
  }
  const [a, b] = [PAD, CELL - PAD];
  return [
    {
      kind: "line",
      from: { x: x + a, y: y + a },
      to: { x: x + b, y: y + b },
      className: "piece piece-x",
    },
    {
      kind: "line",
      from: { x: x + b, y: y + a },
      to: { x: x + a, y: y + b },
      className: "piece piece-x",
    },
  ];
}

export const ticTacToeRenderer: BoardRenderer<
  TicTacToePosition,
  TicTacToeMove
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
      ...grid(),
    ];
    const pieces: Shape[] = [];
    const targets: Target[] = [];
    position.cells.forEach((cell, index) => {
      const name = cellName(index);
      if (cell !== ".") pieces.push(...piece(index, cell));
      targets.push({
        id: name,
        label: cell === "." ? `${name}: empty` : `${name}: ${cell}`,
        ...corner(index),
        width: CELL,
        height: CELL,
      });
    });
    return { width: SIZE, height: SIZE, board, pieces, targets };
  },
  moveTargets: (move) => ({ path: [move] }),
  input(_position, legalMoves, _selection, target) {
    const move = legalMoves.find((m) => m === target);
    return move === undefined ? { kind: "ignore" } : { kind: "move", move };
  },
};
