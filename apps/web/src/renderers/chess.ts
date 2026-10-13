import {
  type ChessMove,
  type ChessPosition,
  type Piece,
  type PromotionPiece,
  squareName,
} from "@boardwright/game-chess";
import { composeMove } from "./compose.ts";
import type { BoardRenderer, MoveTargets, Shape, Target } from "./board.ts";

const CELL = 100;
const SIZE = 8 * CELL;
/** Below the board: the promotion picker, one row of four pieces. */
const HEIGHT = SIZE + CELL;

// Input design:
// - A Move is `from` then `to`, each a square named like "e2". Castling is
//   the king's Move of two squares ("e1" then "g1"); en passant is the pawn's
//   diagonal Move; neither needs extra clicks.
// - Promotion is a third click ("effect" in seam terms) on one of four
//   picker targets ("=q", "=r", "=b", "=n") drawn below the board in the
//   pieces of the Seat to move. They are always present (a scene depends on
//   the Position only) but only advance a Move once a promoting pawn's
//   Move has been selected; the destination highlight marks them then.

const PROMOTIONS: readonly PromotionPiece[] = ["q", "r", "b", "n"];

const pickerId = (piece: PromotionPiece) => `=${piece}`;

const moveTargets = (move: ChessMove): MoveTargets => ({
  path: [squareName(move.from), squareName(move.to)],
  ...(move.promotion ? { effects: [pickerId(move.promotion)] } : {}),
});

/** Filled glyphs for both Seats (the style colours them); U+FE0E forces text presentation. */
const GLYPHS: Readonly<Record<string, string>> = {
  k: "♚",
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
  p: "♟︎",
};

const NAMES: Readonly<Record<string, string>> = {
  k: "king",
  q: "queen",
  r: "rook",
  b: "bishop",
  n: "knight",
  p: "pawn",
};

const seatOf = (piece: Piece) => piece < "a" ? "white" : "black";

function glyph(piece: Piece, x: number, y: number): Shape {
  return {
    kind: "text",
    at: { x: x + CELL / 2, y: y + CELL / 2 },
    text: GLYPHS[piece.toLowerCase()]!,
    className: `glyph glyph-${seatOf(piece)}`,
  };
}

export const chessRenderer: BoardRenderer<ChessPosition, ChessMove> = {
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
    for (let square = 0; square < 64; square++) {
      const file = square & 7;
      const rank = square >> 3;
      // White at the bottom: rank 1 is the last row.
      const [x, y] = [file * CELL, (7 - rank) * CELL];
      if ((file + rank) % 2 === 0) {
        board.push({
          kind: "rect",
          x,
          y,
          width: CELL,
          height: CELL,
          className: "square-dark",
        });
      }
      if (file === 0 || rank === 0) {
        board.push({
          kind: "text",
          at: file === 0 ? { x: x + 4, y: y + 18 } : {
            x: x + CELL - 14,
            y: y + CELL - 6,
          },
          text: file === 0 ? String(rank + 1) : "abcdefgh"[file]!,
          className: "coord",
        });
      }
      const cell = position.board[square]!;
      if (cell !== ".") pieces.push(glyph(cell, x, y));
      const name = squareName(square);
      targets.push({
        id: name,
        label: `${name}: ${
          cell === "."
            ? "empty"
            : `${seatOf(cell)} ${NAMES[cell.toLowerCase()]}`
        }`,
        x,
        y,
        width: CELL,
        height: CELL,
      });
    }
    // Promotion picker, in the pieces of the Seat to move.
    board.push({
      kind: "text",
      at: { x: 8, y: SIZE + CELL / 2 + 8 },
      text: "Promote to:",
      className: "caption",
    });
    PROMOTIONS.forEach((piece, i) => {
      const [x, y] = [(4 + i) * CELL, SIZE];
      const owned =
        (position.turn === "white" ? piece.toUpperCase() : piece) as Piece;
      board.push({
        kind: "rect",
        x,
        y,
        width: CELL,
        height: CELL,
        className: "square-dark",
      });
      pieces.push(glyph(owned, x, y));
      targets.push({
        id: pickerId(piece),
        label: `promote to ${NAMES[piece]} (after selecting a promoting Move)`,
        x,
        y,
        width: CELL,
        height: CELL,
      });
    });
    return { width: SIZE, height: HEIGHT, board, pieces, targets };
  },
  moveTargets,
  input: (_position, legalMoves, selection, target) =>
    composeMove(moveTargets, legalMoves, selection, target),
};
