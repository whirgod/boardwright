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
 * no king-safety, mobility, pawn-structure or bishop-pair terms beyond the
 * tables.
 *
 * Quiescence search (`quiescence`): at the depth horizon the search goes on
 * with captures and promotions until the Position is quiet, so it does not
 * stop mid-exchange and misjudge captures (the horizon effect). A Seat in
 * check may not stand pat (`isInCheck` from the Game), so every legal Move is
 * searched there. Where it may stand pat, only queen promotions and captures
 * that do not lose material by static exchange evaluation (`see`) are
 * searched, and delta pruning skips a capture whose victim's value plus a
 * margin cannot raise alpha (`gain`); that cuts the nodes in tactical
 * Positions by 3-5x. Checks are not searched past the horizon.
 *
 * Check extension (`extend`): a Move that gives check is searched a ply deeper
 * (the library bounds it to 4 extra plies per path), so a forced mate by
 * checks just past the depth is found; it costs few nodes (+0-25% at depth 4
 * and 5) and wins most games against the same Engine without it at equal time
 * per Move.
 *
 * Checkmate and draws are scored exactly by the search library through the
 * rules; this function only sees non-terminal Positions. Move ordering: the
 * best Move of the previous depth first, from the library's transposition
 * table, then captures and promotions (`movePriority`: captures by MVV-LVA,
 * most valuable victim and least valuable attacker first; a queen promotion
 * ahead of them), then the library's killer Moves, then the other quiet
 * Moves by history score (the squares, `moveKey`), then in the Game's order. Quiescence searches the captures and promotions
 * in the same order (all legal Moves, in check). The table's key
 * is the whole Position, and a chess Position includes the move clocks and
 * the repetition history, so different Move orders (1. Nf3 Nf6 2. Nc3 and
 * 1. Nc3 Nf6 2. Nf3) rarely share a key: the table mostly helps by ordering
 * Moves.
 *
 * Exports `rules` and `engine` so a host can load it by URL in a Worker, and
 * its parts (`evaluate`, `movePriority`, `quiescence`, `extend`) to compose variants.
 */
import type { Engine } from "@boardwright/core";
import {
  createMinimaxEngine,
  type Quiescence,
} from "@boardwright/engine-minimax";
import {
  type Cell,
  chess,
  type ChessMove,
  type ChessPosition,
  isInCheck,
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

/** Rank of a piece for MVV-LVA: pawn 1 ... queen 5, king 6. */
const RANK: Readonly<Record<string, number>> = {
  p: 1,
  n: 2,
  b: 3,
  r: 4,
  q: 5,
  k: 6,
};

/**
 * Move priority for the search: above 0 for captures (en passant included)
 * and promotions, 0 for quiet Moves. A capture scores 16 * victim rank + 6 -
 * attacker rank (most valuable victim, least valuable attacker); a queen
 * promotion adds 150, any other promotion 1.
 */
export function movePriority(
  position: ChessPosition,
  move: ChessMove,
): number {
  const attacker = position.board[move.from]!.toLowerCase();
  let victim = position.board[move.to]!;
  if (victim === "." && attacker === "p" && move.to === position.enPassant) {
    victim = "p";
  }
  let priority = 0;
  if (victim !== ".") {
    priority = 16 * RANK[victim.toLowerCase()]! + 6 - RANK[attacker]!;
  }
  if (move.promotion) priority += move.promotion === "q" ? 150 : 1;
  return priority;
}

/** Value of a piece in the exchange (static exchange evaluation): a king is "worth" more than any exchange. */
const EXCHANGE: Readonly<Record<string, number>> = {
  ...MATERIAL,
  k: 10_000,
};

const KNIGHT_JUMPS = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
] as const;
// Direction (file, rank) and whether it is a diagonal.
const RAYS = [
  [1, 0, false],
  [-1, 0, false],
  [0, 1, false],
  [0, -1, false],
  [1, 1, true],
  [1, -1, true],
  [-1, 1, true],
  [-1, -1, true],
] as const;

/**
 * The square of the least valuable piece of the given colour that attacks
 * `to` on `board`, or -1. Ignores pins; sliders see through emptied squares,
 * which is how x-ray attackers join an exchange.
 */
function leastAttacker(
  board: readonly Cell[],
  to: number,
  white: boolean,
): number {
  const file = to & 7, rank = to >> 3;
  const at = (f: number, r: number): Cell =>
    f < 0 || f > 7 || r < 0 || r > 7 ? "." : board[r * 8 + f]!;
  // Pawns attack forwards: a white pawn attacker stands one rank below.
  const pawn = white ? "P" : "p";
  const pr = white ? rank - 1 : rank + 1;
  for (const f of [file - 1, file + 1]) {
    if (at(f, pr) === pawn) return pr * 8 + f;
  }
  const knight = white ? "N" : "n";
  for (const [df, dr] of KNIGHT_JUMPS) {
    if (at(file + df, rank + dr) === knight) return (rank + dr) * 8 + file + df;
  }
  // Sliders and the king, the least valuable first: bishop, rook, queen.
  let bishop = -1, rook = -1, queen = -1, king = -1;
  for (const [df, dr, diagonal] of RAYS) {
    for (
      let f = file + df, r = rank + dr, step = 1;;
      f += df, r += dr, step++
    ) {
      const cell = at(f, r);
      if (cell === ".") {
        if (f < 0 || f > 7 || r < 0 || r > 7) break;
        continue;
      }
      if (cell < "a" !== white) break;
      const kind = cell.toLowerCase();
      const square = r * 8 + f;
      if (kind === "q") queen = square;
      else if (kind === "b" && diagonal) bishop = square;
      else if (kind === "r" && !diagonal) rook = square;
      else if (kind === "k" && step === 1) king = square;
      break;
    }
  }
  return bishop >= 0 ? bishop : rook >= 0 ? rook : queen >= 0 ? queen : king;
}

/** The piece `move` captures (en passant included), or "." for none. */
function victimOf(position: ChessPosition, move: ChessMove): Cell {
  const victim = position.board[move.to]!;
  if (
    victim === "." && move.to === position.enPassant &&
    position.board[move.from]!.toLowerCase() === "p"
  ) {
    return position.turn === "white" ? "p" : "P";
  }
  return victim;
}

/**
 * Static exchange evaluation of a capture: the material (centipawns) the
 * Seat to move wins or loses in the best sequence of captures on the target
 * square, where either Seat may stop recapturing at any time, the least
 * valuable attacker goes first and x-ray attackers join once a piece in
 * front has gone. Ignores pins and checks, and promotions on the way. For a
 * Move that captures nothing: 0.
 */
export function see(position: ChessPosition, move: ChessMove): number {
  const victim = victimOf(position, move);
  if (victim === ".") return 0;
  const board = position.board.slice();
  const gain: number[] = [EXCHANGE[victim.toLowerCase()]!];
  let onSquare = EXCHANGE[board[move.from]!.toLowerCase()]!;
  board[move.from] = ".";
  if (board[move.to] === ".") {
    board[move.to + (position.turn === "white" ? -8 : 8)] = ".";
  }
  let white = position.turn !== "white"; // the Seat that recaptures
  let d = 0;
  for (;;) {
    const from = leastAttacker(board, move.to, white);
    if (from < 0) break;
    d++;
    gain[d] = onSquare - gain[d - 1]!;
    onSquare = EXCHANGE[board[from]!.toLowerCase()]!;
    board[from] = ".";
    white = !white;
  }
  // Each Seat may stop: the last capture is only made if it pays.
  for (; d > 0; d--) gain[d - 1] = -Math.max(-gain[d - 1]!, gain[d]!);
  return gain[0]!;
}

/**
 * Whether a quiescence node searches `move` where standing pat is allowed:
 * queen promotions (underpromotions rarely matter and add three branches per
 * promotion), and captures that do not lose material by `see`. A capture of
 * a piece at least as valuable as the capturer cannot lose: no exchange is
 * computed for it.
 */
export function tactical(position: ChessPosition, move: ChessMove): boolean {
  if (move.promotion) return move.promotion === "q";
  const victim = victimOf(position, move);
  if (victim === ".") return false;
  const attacker = EXCHANGE[position.board[move.from]!.toLowerCase()]!;
  return EXCHANGE[victim.toLowerCase()]! >= attacker ||
    see(position, move) >= 0;
}

/** Margin (centipawns) of `gain`: what piece-square values can add to material. */
export const DELTA_MARGIN = 200;

/**
 * Upper bound of what a quiescence Move can win beyond standing pat, for
 * delta pruning: the victim's material, a queen promotion's 800 more, and
 * `DELTA_MARGIN` for placement changes in the evaluation. It does not cover
 * a mate (a capture that mates is pruned if far behind alpha).
 */
export function gain(position: ChessPosition, move: ChessMove): number {
  const victim = victimOf(position, move);
  return (victim === "." ? 0 : MATERIAL[victim.toLowerCase()]!) +
    (move.promotion ? MATERIAL.q! - MATERIAL.p! : 0) + DELTA_MARGIN;
}

/**
 * Quiescence search at the horizon: queen promotions and the captures that
 * `tactical` keeps (en passant included; not those that lose material by
 * static exchange evaluation), until the Position is quiet, with delta
 * pruning (`gain`). A Seat in check must answer the check, so it may not
 * stand pat: every legal Move is searched, none pruned. Default cap
 * (`DEFAULT_QUIESCENCE_PLIES`).
 */
export const quiescence: Quiescence<ChessPosition, ChessMove> = {
  standPat: (position) => !isInCheck(position),
  tactical,
  gain,
};
/**
 * Identity of a Move for the history heuristic: its squares (cheaper than its
 * text). Promotions (tactical, so never history-sorted) share a key per squares.
 */
export function moveKey(move: ChessMove): number {
  return move.from * 64 + move.to;
}

/**
 * Check extension: a Move that gives check is searched one ply deeper (at
 * most `DEFAULT_MAX_EXTENSIONS` per path), so a forced sequence of checks
 * just past the depth is not cut off. The Seat to move is in check.
 */
export const extend = isInCheck;

export const engine: Engine<ChessPosition, ChessMove> = createMinimaxEngine<
  ChessPosition,
  ChessMove
>({
  rules,
  evaluate,
  movePriority,
  quiescence,
  moveKey,
  extend,
  name: "Minimax",
});
