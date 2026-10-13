import type {
  GameRules,
  Notation,
  RulesOutcome,
  Seat,
} from "@boardwright/core";
import {
  BK,
  Board,
  BQ,
  FLAG_EN_PASSANT,
  type IMove,
  KING,
  moveFlag,
  moveFrom,
  movePromotion,
  moveTo,
  PAWN,
  WK,
  WQ,
} from "./board.ts";

export type ChessSeat = "white" | "black";

/** FEN piece letters: upper case white, lower case black. */
export type Piece =
  | "P"
  | "N"
  | "B"
  | "R"
  | "Q"
  | "K"
  | "p"
  | "n"
  | "b"
  | "r"
  | "q"
  | "k";
/** A board square's content; `.` is empty. */
export type Cell = Piece | ".";

/** Square index 0..63: a1 = 0, b1 = 1, ..., h1 = 7, a2 = 8, ..., h8 = 63. */
export type Square = number;

export type PromotionPiece = "q" | "r" | "b" | "n";

/** One chess Move. Castling is the king's Move (`e1` to `g1`). */
export interface ChessMove {
  readonly from: Square;
  readonly to: Square;
  /** Required exactly when a pawn reaches the last rank. */
  readonly promotion?: PromotionPiece;
}

export interface ChessPosition {
  /** 64 cells indexed by `Square` (a1 = 0, h8 = 63). */
  readonly board: readonly Cell[];
  /** Seat that moves next. Kept after the Match ends; `toMove` hides it. */
  readonly turn: ChessSeat;
  /** Castling rights: a subset of `KQkq` in that order, `""` for none. */
  readonly castling: string;
  /** FEN en passant target square, set after every double pawn push. */
  readonly enPassant: Square | null;
  /** Plies since the last capture or pawn Move (fifty-move rule). */
  readonly halfmoveClock: number;
  /** FEN fullmove number: starts at 1, incremented after black's Move. */
  readonly fullmoveNumber: number;
  /**
   * Repetition keys of the earlier Positions since the last capture, pawn
   * Move or loss of castling rights (oldest first). See `README.md`.
   */
  readonly history: readonly string[];
}

/** Plies without capture or pawn Move after which the Match is drawn. */
export const FIFTY_MOVE_PLIES = 100;
/** Occurrences of one Position after which the Match is drawn. */
export const REPETITIONS = 3;

export const INITIAL_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const FILES = "abcdefgh";
const PIECES = ".PNBRQK..pnbrqk";
const PROMOTIONS = ".." + "nbrq"; // index = piece type

/** `e4` for square 28. */
export function squareName(square: Square): string {
  return FILES[square & 7]! + ((square >> 3) + 1);
}

/** Square of a name like `e4`; throws on anything else. */
export function parseSquare(name: string): Square {
  if (!/^[a-h][1-8]$/.test(name)) {
    throw new Error(`Invalid square: ${JSON.stringify(name)}`);
  }
  return FILES.indexOf(name[0]!) + 8 * (Number(name[1]) - 1);
}

const other = (s: ChessSeat): ChessSeat => s === "white" ? "black" : "white";

// ---------------------------------------------------------------------------
// Board conversion and per-Position cache

function toBoard(p: ChessPosition): Board {
  const b = new Board();
  // Positions come from `decodePosition`/`play` (frozen, validated), so every
  // cell is a FEN letter or "." (PIECES.indexOf(".") is 0, empty).
  p.board.forEach((c, i) => {
    b.sq[i] = PIECES.indexOf(c) & 15;
  });
  b.black = p.turn === "black";
  b.castling = (p.castling.includes("K") ? WK : 0) |
    (p.castling.includes("Q") ? WQ : 0) |
    (p.castling.includes("k") ? BK : 0) |
    (p.castling.includes("q") ? BQ : 0);
  b.ep = p.enPassant ?? -1;
  b.locateKings();
  return b;
}

function cellsOf(b: Board): Cell[] {
  return Array.from(b.sq, (code) => PIECES[code] as Cell);
}

function castlingText(bits: number): string {
  return (bits & WK ? "K" : "") + (bits & WQ ? "Q" : "") +
    (bits & BK ? "k" : "") + (bits & BQ ? "q" : "");
}

function placement(board: readonly Cell[]): string {
  const ranks: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let text = "", empty = 0;
    for (let f = 0; f < 8; f++) {
      const c = board[r * 8 + f]!;
      if (c === ".") empty++;
      else {
        if (empty) text += empty;
        text += c;
        empty = 0;
      }
    }
    ranks.push(empty ? text + empty : text);
  }
  return ranks.join("/");
}

interface Info {
  readonly moves: readonly IMove[];
  readonly inCheck: boolean;
  /** Repetition key: placement, turn, castling, en passant if capturable. */
  readonly key: string;
}

const cache = new WeakMap<ChessPosition, Info>();

/** Legal Moves, check status and repetition key of `p` (memoized). */
function info(p: ChessPosition): Info {
  let i = cache.get(p);
  if (!i) {
    const b = toBoard(p);
    const moves = b.legalMoves();
    // FIDE 9.2.3: the en passant square only matters if the capture is legal.
    const ep = moves.some((m) => moveFlag(m) === FLAG_EN_PASSANT)
      ? squareName(p.enPassant!)
      : "-";
    i = {
      moves,
      inCheck: b.inCheck(),
      key: `${placement(p.board)}:${p.turn[0]}:${p.castling || "-"}:${ep}`,
    };
    cache.set(p, i);
  }
  return i;
}

const toPublic = (m: IMove): ChessMove => {
  const promo = movePromotion(m);
  return promo
    ? {
      from: moveFrom(m),
      to: moveTo(m),
      promotion: PROMOTIONS[promo] as PromotionPiece,
    }
    : { from: moveFrom(m), to: moveTo(m) };
};

/** The internal Move matching `move`, or undefined if it is not legal. */
function findLegal(p: ChessPosition, move: ChessMove): IMove | undefined {
  const promo = move.promotion ? PROMOTIONS.indexOf(move.promotion) : 0;
  return info(p).moves.find((m) =>
    moveFrom(m) === move.from && moveTo(m) === move.to &&
    movePromotion(m) === promo
  );
}

/**
 * True when neither Seat can possibly checkmate (dead position by material):
 * no pawns, rooks or queens, and either at most one knight and no bishops,
 * or only bishops that all stand on squares of one colour.
 */
export function isInsufficientMaterial(board: readonly Cell[]): boolean {
  let knights = 0;
  const bishopColours = new Set<number>();
  for (let s = 0; s < 64; s++) {
    const c = board[s]!.toLowerCase();
    if (c === "." || c === "k") continue;
    if (c === "n") knights++;
    else if (c === "b") bishopColours.add(((s >> 3) + (s & 7)) % 2);
    else return false;
  }
  if (knights === 0) return bishopColours.size <= 1;
  return knights === 1 && bishopColours.size === 0;
}

// ---------------------------------------------------------------------------
// Notation

function fail(what: string, text: string): never {
  throw new Error(`Invalid chess position (${what}): ${JSON.stringify(text)}`);
}

/** Parses a FEN piece placement strictly (canonical, plausible material). */
function parsePlacement(text: string, fen: string): Cell[] {
  const ranks = text.split("/");
  if (ranks.length !== 8) fail("rank count", fen);
  const board = Array<Cell>(64).fill(".");
  ranks.forEach((rank, i) => {
    // Canonical: no two digits in a row, no zero, no 9.
    if (!/^(?:[1-8]?[PNBRQKpnbrqk])*[1-8]?$/.test(rank) || rank === "") {
      fail("rank", fen);
    }
    let f = 0;
    for (const ch of rank) {
      if (ch >= "1" && ch <= "8") f += Number(ch);
      else {
        if (f > 7) fail("rank length", fen);
        board[(7 - i) * 8 + f] = ch as Cell;
        f++;
      }
    }
    if (f !== 8) fail("rank length", fen);
  });
  for (const side of ["w", "b"] as const) {
    const ps = board.filter((c) =>
      c !== "." && (c === c.toUpperCase()) === (side === "w")
    );
    const kings = ps.filter((c) => c.toLowerCase() === "k").length;
    const pawns = ps.filter((c) => c.toLowerCase() === "p").length;
    if (kings !== 1) fail("king count", fen);
    if (pawns > 8 || ps.length > 16) fail("too many pieces", fen);
  }
  for (let f = 0; f < 8; f++) {
    if ("Pp".includes(board[f]!) || "Pp".includes(board[56 + f]!)) {
      fail("pawn on first or last rank", fen);
    }
  }
  return board;
}

/** Pawn squares plus the sorted other pieces: unchanged by reversible Moves. */
function materialOf(board: readonly Cell[]): string {
  const pawns = board.map((c) => c === "P" || c === "p" ? c : ".").join("");
  return pawns + board.filter((c) => !".Pp".includes(c)).sort().join("");
}

/**
 * Freezes a Position deeply: the legal-Move cache is keyed by identity, so
 * Positions must not change after creation.
 */
function freeze(p: ChessPosition): ChessPosition {
  Object.freeze(p.board);
  Object.freeze(p.history);
  return Object.freeze(p);
}

const CASTLING_RE = /^(?:-|K?Q?k?q?)$/;
const COUNT_RE = /^(?:0|[1-9]\d{0,3})$/;

const notation: Notation<ChessPosition, ChessMove> = {
  /**
   * FEN (`<placement> <w|b> <castling> <ep> <halfmove> <fullmove>`),
   * followed by ` <history>` when the repetition history is not empty.
   */
  encodePosition(p) {
    const fen = `${placement(p.board)} ${p.turn[0]} ${p.castling || "-"} ${
      p.enPassant === null ? "-" : squareName(p.enPassant)
    } ${p.halfmoveClock} ${p.fullmoveNumber}`;
    return p.history.length > 0 ? `${fen} ${p.history.join("|")}` : fen;
  },
  decodePosition(text) {
    const fields = text.split(" ");
    if (fields.length !== 6 && fields.length !== 7) fail("field count", text);
    const [placed, turnText, castling, epText, half, full, hist] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
      string | undefined,
    ];
    const board = parsePlacement(placed, text);
    if (turnText !== "w" && turnText !== "b") fail("side to move", text);
    const turn: ChessSeat = turnText === "w" ? "white" : "black";
    if (!CASTLING_RE.test(castling) || castling === "") fail("castling", text);
    const rights = castling === "-" ? "" : castling;
    const needs: Record<string, [number, Cell, number, Cell]> = {
      K: [4, "K", 7, "R"],
      Q: [4, "K", 0, "R"],
      k: [60, "k", 63, "r"],
      q: [60, "k", 56, "r"],
    };
    for (const r of rights) {
      const [ks, k, rs, rook] = needs[r]!;
      if (board[ks] !== k || board[rs] !== rook) {
        fail("castling right without king and rook at home", text);
      }
    }
    if (!COUNT_RE.test(half) || !COUNT_RE.test(full) || full === "0") {
      fail("move counters", text);
    }
    const halfmoveClock = Number(half);
    // At most every ply so far was reversible.
    if (halfmoveClock > 2 * (Number(full) - 1) + (turn === "black" ? 1 : 0)) {
      fail("halfmove clock exceeds plies played", text);
    }
    let enPassant: Square | null = null;
    if (epText !== "-") {
      if (!/^[a-h][36]$/.test(epText)) fail("en passant square", text);
      enPassant = parseSquare(epText);
      // The pawn that just pushed two squares stands in front of the target.
      const [rank, pawn, dir] = turn === "white" ? [5, "p", -8] : [2, "P", 8];
      if (
        enPassant >> 3 !== rank || board[enPassant + dir] !== pawn ||
        board[enPassant] !== "." || board[enPassant - dir] !== "." ||
        halfmoveClock !== 0
      ) fail("impossible en passant square", text);
    }
    const position: ChessPosition = freeze({
      board,
      turn,
      castling: rights,
      enPassant,
      halfmoveClock,
      fullmoveNumber: Number(full),
      history: hist === undefined ? [] : hist.split("|"),
    });
    const b = toBoard(position);
    if (b.attacked(b.kings[b.black ? 0 : 1]!, b.black)) {
      fail("side not to move is in check", text);
    }
    const n = position.history.length;
    // No capture or pawn Move happened in the chain: same pawns, same pieces.
    const material = materialOf(board);
    if (n > halfmoveClock) fail("history longer than halfmove clock", text);
    position.history.forEach((key, i) => {
      const m = /^([^:]+):([wb]):([^:]+):(-|[a-h][36])$/.exec(key);
      if (!m) return fail("history entry", text);
      const earlier = parsePlacement(m[1]!, text);
      if (placement(earlier) !== m[1]) fail("history entry", text);
      if (materialOf(earlier) !== material) fail("history material", text);
      // Losing castling rights clears the history.
      if (m[3] !== castling) fail("history castling rights", text);
      // Plies alternate, so entry i (of n) was `n - i` plies ago.
      if ((m[2] === turnText) !== ((n - i) % 2 === 0)) {
        fail("history turn order", text);
      }
      // Only a double push (irreversible) creates an en passant square, so
      // only the oldest entry can have one.
      if (m[4] !== "-" && (i > 0 || (m[4]![1] === "6") !== (m[2] === "w"))) {
        fail("history en passant square", text);
      }
    });
    return position;
  },
  /** UCI long algebraic: `e2e4`, `e1g1` (castling), `e7e8q`. */
  encodeMove(move) {
    return squareName(move.from) + squareName(move.to) +
      (move.promotion ?? "");
  },
  decodeMove(text) {
    const m = /^([a-h][1-8])([a-h][1-8])([qrbn]?)$/.exec(text);
    if (!m || m[1] === m[2]) {
      throw new Error(`Invalid chess move: ${JSON.stringify(text)}`);
    }
    const from = parseSquare(m[1]!), to = parseSquare(m[2]!);
    return m[3]
      ? { from, to, promotion: m[3] as PromotionPiece }
      : { from, to };
  },
};

// ---------------------------------------------------------------------------
// Rules

function isRepetition(p: ChessPosition): boolean {
  const k = info(p).key;
  return 1 + p.history.filter((h) => h === k).length >= REPETITIONS;
}

export const chess: GameRules<ChessPosition, ChessMove> = {
  id: "chess",
  name: "Chess",
  seats: ["white", "black"],
  initialPosition: () => notation.decodePosition(INITIAL_FEN),
  toMove(position): Seat | undefined {
    return chess.outcome(position) ? undefined : position.turn;
  },
  legalMoves(position) {
    if (chess.outcome(position)) return [];
    return info(position).moves.map(toPublic);
  },
  /** Throws if `move` is not legal in `position`. */
  play(position, move) {
    const m = chess.outcome(position) ? undefined : findLegal(position, move);
    if (m === undefined) {
      throw new Error(
        `Illegal move ${notation.encodeMove(move)} in ${
          notation.encodePosition(position)
        }`,
      );
    }
    const b = toBoard(position);
    const moved = b.sq[moveFrom(m)]!;
    const irreversible = (moved & 7) === PAWN || b.sq[moveTo(m)] !== 0;
    b.make(m);
    const castling = castlingText(b.castling);
    const keep = !irreversible && castling === position.castling;
    return freeze({
      board: cellsOf(b),
      turn: other(position.turn),
      castling,
      enPassant: b.ep < 0 ? null : b.ep,
      halfmoveClock: irreversible ? 0 : position.halfmoveClock + 1,
      fullmoveNumber: position.fullmoveNumber +
        (position.turn === "black" ? 1 : 0),
      history: keep ? [...position.history, info(position).key] : [],
    });
  },
  outcome(position): RulesOutcome | undefined {
    const i = info(position);
    if (i.moves.length === 0) {
      return i.inCheck
        ? { winner: other(position.turn), reason: "checkmate" }
        : { reason: "stalemate" };
    }
    if (isInsufficientMaterial(position.board)) {
      return { reason: "insufficient-material" };
    }
    if (position.halfmoveClock >= FIFTY_MOVE_PLIES) {
      return { reason: "fifty-move-rule" };
    }
    if (isRepetition(position)) return { reason: "threefold-repetition" };
    return undefined;
  },
  notation,
};

/**
 * Leaf count of the legal Move tree `depth` plies deep from `position`,
 * ignoring draw rules (the standard perft definition). For testing and
 * benchmarking move generation.
 */
export function perft(position: ChessPosition, depth: number): number {
  if (!Number.isInteger(depth) || depth < 0) {
    throw new RangeError(`Invalid perft depth: ${depth}`);
  }
  return toBoard(position).perft(depth);
}

// ---------------------------------------------------------------------------
// SAN (Standard Algebraic Notation) helpers for display

const SAN_LETTERS = "..NBRQK";

/**
 * Formats a legal Move in SAN, e.g. `Nbd7`, `exd6`, `e8=Q+`, `O-O`, `Qh4#`.
 * Throws if `move` is not legal in `position`.
 */
export function formatSan(position: ChessPosition, move: ChessMove): string {
  const m = findLegal(position, move);
  if (m === undefined || chess.outcome(position)) {
    throw new Error(
      `Illegal move ${notation.encodeMove(move)} in ${
        notation.encodePosition(position)
      }`,
    );
  }
  return sanOf(toBoard(position), m, info(position).moves);
}

function sanOf(b: Board, m: IMove, legal: readonly IMove[]): string {
  const from = moveFrom(m), to = moveTo(m), type = b.sq[from]! & 7;
  const capture = b.sq[to] !== 0 || moveFlag(m) === FLAG_EN_PASSANT;
  let san: string;
  if (type === KING && Math.abs(to - from) === 2) {
    san = to > from ? "O-O" : "O-O-O";
  } else if (type === PAWN) {
    san = (capture ? FILES[from & 7] + "x" : "") + squareName(to);
    const promo = movePromotion(m);
    if (promo) san += "=" + SAN_LETTERS[promo];
  } else {
    const rivals = legal.filter((o) =>
      moveTo(o) === to && moveFrom(o) !== from &&
      (b.sq[moveFrom(o)]! & 7) === type
    ).map(moveFrom);
    let which = "";
    if (rivals.length > 0) {
      const name = squareName(from);
      if (rivals.every((s) => (s & 7) !== (from & 7))) which = name[0]!;
      else if (rivals.every((s) => s >> 3 !== from >> 3)) which = name[1]!;
      else which = name;
    }
    san = SAN_LETTERS[type] + which + (capture ? "x" : "") + squareName(to);
  }
  b.make(m);
  if (b.inCheck()) san += b.legalMoves().length === 0 ? "#" : "+";
  b.unmake(m);
  return san;
}

/**
 * Parses SAN for a legal Move in `position`. Trailing annotations (`!`,
 * `?`) and the check suffix (`+`/`#`) are optional, but a suffix that is
 * given must be right; everything else must be exactly as `formatSan` writes
 * it. Throws if no legal Move matches.
 */
export function parseSan(position: ChessPosition, san: string): ChessMove {
  const core = san.replace(/[!?]{1,2}$/, "");
  const suffixed = /[+#]$/.test(core);
  if (!chess.outcome(position)) {
    const b = toBoard(position);
    const legal = info(position).moves;
    for (const m of legal) {
      const text = sanOf(b, m, legal);
      if ((suffixed ? text : text.replace(/[+#]$/, "")) === core) {
        return toPublic(m);
      }
    }
  }
  throw new Error(
    `Illegal or invalid SAN ${JSON.stringify(san)} in ${
      notation.encodePosition(position)
    }`,
  );
}
