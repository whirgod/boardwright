import type {
  GameRules,
  Notation,
  RulesOutcome,
  Seat,
} from "@boardwright/core";

export type CheckersSeat = "black" | "white";

/** `b`/`w` = man, `B`/`W` = king, `.` = empty. */
export type Cell = "." | "b" | "B" | "w" | "W";

/**
 * Position of an English draughts Match. `board` is indexed 0..31, i.e. the
 * standard square number 1..32 minus one (square 1 is top-left from Black's
 * side; Black starts on 1-12 and moves towards 32, White starts on 21-32).
 */
export interface CheckersPosition {
  readonly board: readonly Cell[];
  /** Seat that moves next. Kept after the Match ends; `toMove` hides it. */
  readonly turn: CheckersSeat;
  /** Plies since the last capture or man move (draw rule: 80). */
  readonly clock: number;
  /**
   * Keys of the earlier Positions since the last capture or man move
   * (oldest first), used for threefold repetition. May contain the current
   * Position again (that is a repetition).
   */
  readonly history: readonly string[];
}

/** Squares visited by one Move, in standard numbering 1..32; length >= 2. */
export type CheckersMove = readonly number[];

/** Plies without a capture or man move after which the Match is drawn. */
export const DRAW_CLOCK = 80;
/** Occurrences of one Position after which the Match is drawn. */
export const REPETITIONS = 3;

const SQUARES = 32;

function row(i: number): number {
  return Math.floor(i / 4);
}
function col(i: number): number {
  return row(i) % 2 === 0 ? 2 * (i % 4) + 1 : 2 * (i % 4);
}
/** Square index at (r, c), or -1 if off the board or a light square. */
function at(r: number, c: number): number {
  if (r < 0 || r > 7 || c < 0 || c > 7 || (r + c) % 2 === 0) return -1;
  return r * 4 + (c >> 1);
}

const DIRS: readonly (readonly [number, number])[] = [
  [1, -1],
  [1, 1],
  [-1, -1],
  [-1, 1],
];
/** NEIGHBORS[square][dir] is the adjacent square in `DIRS[dir]` or -1. */
const NEIGHBORS: readonly (readonly number[])[] = Array.from(
  { length: SQUARES },
  (_, i) => DIRS.map(([dr, dc]) => at(row(i) + dr, col(i) + dc)),
);

const other = (s: CheckersSeat): CheckersSeat =>
  s === "black" ? "white" : "black";
const ownerOf = (c: Cell): CheckersSeat | undefined =>
  c === "." ? undefined : c === "b" || c === "B" ? "black" : "white";
const isKing = (c: Cell): boolean => c === "B" || c === "W";
/** Row on which a man of `seat` is crowned. */
const crownRow = (seat: CheckersSeat): number => seat === "black" ? 7 : 0;

function pieceList(board: readonly Cell[], seat: CheckersSeat): string {
  const parts: string[] = [];
  board.forEach((c, i) => {
    if (ownerOf(c) === seat) parts.push((isKing(c) ? "K" : "") + (i + 1));
  });
  return parts.join(",");
}

function key(position: Pick<CheckersPosition, "board" | "turn">): string {
  return `${position.turn === "black" ? "B" : "W"}/${
    pieceList(position.board, "white")
  }/${pieceList(position.board, "black")}`;
}

/** Parses `21,22,K30` for `seat` into `board`; throws on any problem. */
function parsePieces(
  text: string,
  seat: CheckersSeat,
  board: Cell[],
  what: string,
): void {
  if (text === "") return;
  const items = text.split(",");
  if (items.length > 12) {
    throw new Error(`Invalid checkers position (too many pieces): ${what}`);
  }
  for (const item of items) {
    const m = /^(K?)([1-9]\d?)$/.exec(item);
    const sq = m ? Number(m[2]) : 0;
    if (!m || sq < 1 || sq > SQUARES) {
      throw new Error(`Invalid checkers position (piece ${item}): ${what}`);
    }
    const i = sq - 1;
    if (board[i] !== ".") {
      throw new Error(`Invalid checkers position (duplicate ${sq}): ${what}`);
    }
    const king = m[1] === "K";
    if (!king && row(i) === crownRow(seat)) {
      throw new Error(
        `Invalid checkers position (uncrowned man on ${sq}): ${what}`,
      );
    }
    board[i] = seat === "black" ? (king ? "B" : "b") : (king ? "W" : "w");
  }
}

function decodeBoard(white: string, black: string, what: string): Cell[] {
  const board = Array<Cell>(SQUARES).fill(".");
  parsePieces(white, "white", board, what);
  parsePieces(black, "black", board, what);
  return board;
}

const notation: Notation<CheckersPosition, CheckersMove> = {
  /**
   * `<B|W>:W<pieces>:B<pieces>` (PDN-style FEN, e.g. `B:W21,22,K30:B1,2,3`),
   * optionally followed by `:<clock>` and `:<history>`, where history is the
   * `|`-separated keys of earlier Positions (`B/<white>/<black>`). Omitted
   * extras mean clock 0 and no history; the encoder omits them when empty.
   */
  encodePosition(p) {
    let text = `${p.turn === "black" ? "B" : "W"}:W${
      pieceList(p.board, "white")
    }:B${pieceList(p.board, "black")}`;
    if (p.clock > 0) {
      text += `:${p.clock}`;
      if (p.history.length > 0) text += `:${p.history.join("|")}`;
    }
    return text;
  },
  decodePosition(text) {
    const bad = (why: string): never => {
      throw new Error(
        `Invalid checkers position (${why}): ${JSON.stringify(text)}`,
      );
    };
    const parts = text.split(":");
    if (parts.length < 3 || parts.length > 5) bad("field count");
    const [turnText, w, b, clockText, historyText] = parts;
    if (turnText !== "B" && turnText !== "W") bad("side to move");
    if (!w!.startsWith("W") || !b!.startsWith("B")) bad("piece sections");
    const board = decodeBoard(w!.slice(1), b!.slice(1), text);
    let clock = 0;
    if (clockText !== undefined) {
      // Canonical: the encoder omits a zero clock.
      if (!/^[1-9]\d{0,2}$/.test(clockText)) bad("clock");
      clock = Number(clockText);
    }
    const history = historyText === undefined ? [] : historyText.split("|");
    if (history.length > clock) bad("history longer than clock");
    history.forEach((k, i) => {
      const m = /^([BW])\/([^/]*)\/([^/]*)$/.exec(k);
      if (!m) bad("history entry");
      const earlier = decodeBoard(m![2]!, m![3]!, text);
      // Entries must be canonical, or they could never match `key()`.
      if (
        key({ board: earlier, turn: m![1] === "B" ? "black" : "white" }) !== k
      ) {
        bad("non-canonical history entry");
      }
      // Plies alternate, so entry i (of n) was `n - i` plies ago.
      const sameTurn = (history.length - i) % 2 === 0;
      if ((m![1] === turnText) !== sameTurn) bad("history turn order");
    });
    return {
      board,
      turn: turnText === "B" ? "black" : "white",
      clock,
      history,
    };
  },
  /** `11-15` for a step, `22x15x8` for a capture (any number of jumps). */
  encodeMove(move) {
    // A step moves to an adjacent square; every jump spans two rows.
    const jump = Math.abs(row(move[0]! - 1) - row(move[1]! - 1)) === 2;
    return move.join(jump ? "x" : "-");
  },
  decodeMove(text) {
    if (!/^[1-9]\d?(?:-[1-9]\d?|(?:x[1-9]\d?)+)$/.test(text)) {
      throw new Error(`Invalid checkers move: ${JSON.stringify(text)}`);
    }
    const squares = text.split(/[-x]/).map(Number);
    // Canonical text only: the separator must match the geometry.
    if (
      squares.some((s) => s > SQUARES) || notation.encodeMove(squares) !== text
    ) {
      throw new Error(`Invalid checkers move: ${JSON.stringify(text)}`);
    }
    return squares;
  },
};

/** Directions (indices into DIRS) a piece may move/jump in. */
function dirsFor(cell: Cell): readonly number[] {
  if (isKing(cell)) return [0, 1, 2, 3];
  return cell === "b" ? [0, 1] : [2, 3];
}

/**
 * Collects every maximal jump sequence of `piece` from `from`. Captured
 * pieces stay on the board until the Move ends, so they block squares and
 * cannot be jumped twice.
 */
function jumpsFrom(
  board: Cell[],
  from: number,
  piece: Cell,
  captured: number[],
  path: number[],
  out: number[][],
): void {
  const seat = ownerOf(piece)!;
  let extended = false;
  for (const d of dirsFor(piece)) {
    const over = NEIGHBORS[from]![d]!;
    if (over < 0 || captured.includes(over)) continue;
    if (ownerOf(board[over]!) !== other(seat)) continue;
    const land = NEIGHBORS[over]![d]!;
    if (land < 0 || board[land] !== ".") continue;
    extended = true;
    path.push(land);
    captured.push(over);
    if (!isKing(piece) && row(land) === crownRow(seat)) {
      out.push([...path]); // crowning ends the Move
    } else {
      jumpsFrom(board, land, piece, captured, path, out);
    }
    captured.pop();
    path.pop();
  }
  if (!extended && path.length > 1) out.push([...path]);
}

/** Legal Moves ignoring draw/loss termination (0-based square paths). */
function generate(position: CheckersPosition): number[][] {
  const jumps: number[][] = [];
  const steps: number[][] = [];
  for (let i = 0; i < SQUARES; i++) {
    const piece = position.board[i]!;
    if (ownerOf(piece) !== position.turn) continue;
    const work = position.board.slice() as Cell[];
    work[i] = "."; // the mover may pass over or land on its own origin
    jumpsFrom(work, i, piece, [], [i], jumps);
    for (const d of dirsFor(piece)) {
      const to = NEIGHBORS[i]![d]!;
      if (to >= 0 && position.board[to] === ".") steps.push([i, to]);
    }
  }
  return jumps.length > 0 ? jumps : steps; // captures are mandatory
}

function isRepetition(position: CheckersPosition): boolean {
  const k = key(position);
  return 1 + position.history.filter((h) => h === k).length >= REPETITIONS;
}

export const checkers: GameRules<CheckersPosition, CheckersMove> = {
  id: "checkers",
  name: "Checkers (English draughts)",
  seats: ["black", "white"],
  initialPosition: () => ({
    board: Array.from(
      { length: SQUARES },
      (_, i): Cell => i < 12 ? "b" : i >= 20 ? "w" : ".",
    ),
    turn: "black",
    clock: 0,
    history: [],
  }),
  toMove(position): Seat | undefined {
    return checkers.outcome(position) ? undefined : position.turn;
  },
  legalMoves(position) {
    if (checkers.outcome(position)) return [];
    return generate(position).map((path) => path.map((i) => i + 1));
  },
  /** Throws if `move` is not legal in `position`. */
  play(position, move) {
    const text = notation.encodeMove(move);
    if (
      !checkers.legalMoves(position).some((m) =>
        notation.encodeMove(m) === text
      )
    ) {
      throw new Error(
        `Illegal move ${text} in ${notation.encodePosition(position)}`,
      );
    }
    const path = move.map((s) => s - 1);
    const board = position.board.slice() as Cell[];
    const piece = board[path[0]!]!;
    board[path[0]!] = ".";
    let capture = false;
    for (let j = 1; j < path.length; j++) {
      const a = path[j - 1]!, b = path[j]!;
      if (Math.abs(row(a) - row(b)) === 2) {
        board[at((row(a) + row(b)) / 2, (col(a) + col(b)) / 2)] = ".";
        capture = true;
      }
    }
    const end = path[path.length - 1]!;
    const crowned = !isKing(piece) && row(end) === crownRow(position.turn);
    board[end] = crowned ? (piece === "b" ? "B" : "W") : piece;
    const irreversible = capture || !isKing(piece);
    return {
      board,
      turn: other(position.turn),
      clock: irreversible ? 0 : position.clock + 1,
      history: irreversible ? [] : [...position.history, key(position)],
    };
  },
  outcome(position): RulesOutcome | undefined {
    if (generate(position).length === 0) {
      return { winner: other(position.turn), reason: "no-legal-moves" };
    }
    if (position.clock >= DRAW_CLOCK) return { reason: "forty-move-rule" };
    if (isRepetition(position)) return { reason: "threefold-repetition" };
    return undefined;
  },
  notation,
};
