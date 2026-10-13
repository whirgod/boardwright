/**
 * Chess Engine: the generic alpha-beta library with a classical hand-made
 * evaluation. The tree is far too large to solve, so callers should pass
 * `maxDepth` and/or `maxTimeMs`.
 *
 * Evaluation (centipawns, from the Seat to move): material plus a
 * piece-square bonus per piece, i.e. the "Simplified Evaluation Function" by
 * Tomasz Michniewski,
 * https://www.chessprogramming.org/Simplified_Evaluation_Function
 * (values and tables are taken from there, unchanged):
 *
 * - Material: pawn 100, knight 320, bishop 330, rook 500, queen 900. The king
 *   has no material value; it is never captured.
 * - Piece-square tables reward good placement: knights and bishops towards
 *   the centre, rooks on the 7th rank, pawns advancing in the centre, the
 *   king tucked away behind its pawns in the middlegame.
 * - Endgame: when every Seat has no queen, or at most one minor piece and no
 *   rook besides it, the king switches to a table that pulls it towards the
 *   centre.
 *
 * What it deliberately does not do (so it is easy to read, and to improve):
 * no quiescence search, so it can stop mid-exchange at the depth cut and
 * misjudge captures (horizon effect); no king-safety, mobility, pawn-structure
 * or bishop-pair terms beyond the tables; no move ordering or transposition
 * table, so it searches only a few plies per second budget.
 *
 * Checkmate and draws are scored exactly by the search library through the
 * rules; this function only sees non-terminal Positions. Move ordering is
 * whatever the library does (best Move of the previous depth first).
 *
 * Exports `rules` and `engine` so a host can load it by URL in a Worker.
 */
import type { Engine } from "@boardwright/core";
import { createMinimaxEngine } from "@boardwright/engine-minimax";
import {
  type Cell,
  chess,
  type ChessMove,
  type ChessPosition,
  type Piece,
} from "@boardwright/game-chess";

export const rules = chess;

/** Centipawn material values by lower-case piece letter. */
export const MATERIAL: Readonly<Record<string, number>> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
};

// Tables are written as in the source: from White's point of view, the
// first row is rank 8 and the first column the a-file.
// deno-fmt-ignore
const PAWN = [
    0,  0,  0,  0,  0,  0,  0,  0,
   50, 50, 50, 50, 50, 50, 50, 50,
   10, 10, 20, 30, 30, 20, 10, 10,
    5,  5, 10, 25, 25, 10,  5,  5,
    0,  0,  0, 20, 20,  0,  0,  0,
    5, -5,-10,  0,  0,-10, -5,  5,
    5, 10, 10,-20,-20, 10, 10,  5,
    0,  0,  0,  0,  0,  0,  0,  0,
];
// deno-fmt-ignore
const KNIGHT = [
  -50,-40,-30,-30,-30,-30,-40,-50,
  -40,-20,  0,  0,  0,  0,-20,-40,
  -30,  0, 10, 15, 15, 10,  0,-30,
  -30,  5, 15, 20, 20, 15,  5,-30,
  -30,  0, 15, 20, 20, 15,  0,-30,
  -30,  5, 10, 15, 15, 10,  5,-30,
  -40,-20,  0,  5,  5,  0,-20,-40,
  -50,-40,-30,-30,-30,-30,-40,-50,
];
// deno-fmt-ignore
const BISHOP = [
  -20,-10,-10,-10,-10,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5, 10, 10,  5,  0,-10,
  -10,  5,  5, 10, 10,  5,  5,-10,
  -10,  0, 10, 10, 10, 10,  0,-10,
  -10, 10, 10, 10, 10, 10, 10,-10,
  -10,  5,  0,  0,  0,  0,  5,-10,
  -20,-10,-10,-10,-10,-10,-10,-20,
];
// deno-fmt-ignore
const ROOK = [
    0,  0,  0,  0,  0,  0,  0,  0,
    5, 10, 10, 10, 10, 10, 10,  5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
   -5,  0,  0,  0,  0,  0,  0, -5,
    0,  0,  0,  5,  5,  0,  0,  0,
];
// deno-fmt-ignore
const QUEEN = [
  -20,-10,-10, -5, -5,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5,  5,  5,  5,  0,-10,
   -5,  0,  5,  5,  5,  5,  0, -5,
    0,  0,  5,  5,  5,  5,  0, -5,
  -10,  5,  5,  5,  5,  5,  0,-10,
  -10,  0,  5,  0,  0,  0,  0,-10,
  -20,-10,-10, -5, -5,-10,-10,-20,
];
// deno-fmt-ignore
const KING_MIDDLEGAME = [
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -20,-30,-30,-40,-40,-30,-30,-20,
  -10,-20,-20,-20,-20,-20,-20,-10,
   20, 20,  0,  0,  0,  0, 20, 20,
   20, 30, 10,  0,  0, 10, 30, 20,
];
// deno-fmt-ignore
const KING_ENDGAME = [
  -50,-40,-30,-20,-20,-30,-40,-50,
  -30,-20,-10,  0,  0,-10,-20,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-30,  0,  0,  0,  0,-30,-30,
  -50,-30,-30,-30,-30,-30,-30,-50,
];

const TABLES: Readonly<Record<string, readonly number[]>> = {
  p: PAWN,
  n: KNIGHT,
  b: BISHOP,
  r: ROOK,
  q: QUEEN,
};

const isWhite = (piece: Piece) => piece < "a";

/** Whether the Simplified Evaluation Function's endgame rule applies. */
function isEndgame(board: readonly Cell[]): boolean {
  // Per Seat: queens, rooks, minor pieces.
  const white = { q: 0, r: 0, minor: 0 };
  const black = { q: 0, r: 0, minor: 0 };
  for (const cell of board) {
    if (cell === ".") continue;
    const side = isWhite(cell) ? white : black;
    const kind = cell.toLowerCase();
    if (kind === "q") side.q++;
    else if (kind === "r") side.r++;
    else if (kind === "b" || kind === "n") side.minor++;
  }
  return [white, black].every((s) => s.q === 0 || (s.r === 0 && s.minor <= 1));
}

/** Material plus placement of one piece, for the Seat that owns it. */
function pieceValue(piece: Piece, square: number, endgame: boolean): number {
  const kind = piece.toLowerCase();
  // a1 = 0 is the table's last row; Black reads the table flipped.
  const rank = square >> 3;
  const row = isWhite(piece) ? 7 - rank : rank;
  const table = kind === "k"
    ? (endgame ? KING_ENDGAME : KING_MIDDLEGAME)
    : TABLES[kind]!;
  return MATERIAL[kind]! + table[row * 8 + (square & 7)]!;
}

/** Heuristic value of `position` for the Seat to move (non-terminal). */
export function evaluate(position: ChessPosition): number {
  const endgame = isEndgame(position.board);
  const white = position.turn === "white";
  let sum = 0;
  position.board.forEach((cell, square) => {
    if (cell === ".") return;
    const value = pieceValue(cell, square, endgame);
    sum += isWhite(cell) === white ? value : -value;
  });
  return sum;
}

export const engine: Engine<ChessPosition, ChessMove> = createMinimaxEngine<
  ChessPosition,
  ChessMove
>({
  rules,
  evaluate,
  name: "Minimax",
});
