// Internal, mutable move generator (make/unmake on a 64-square mailbox).
// Not part of the package API: `chess.ts` wraps it in immutable Positions.
// Squares are 0..63 with a1 = 0, b1 = 1, ..., h8 = 63 (index = rank * 8 + file).

export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;
/** Colour bit of a piece code; white pieces are 1..6, black 9..14. */
export const BLACK = 8;

export const FLAG_DOUBLE = 1;
export const FLAG_EN_PASSANT = 2;
export const FLAG_CASTLE = 3;

/** Castling right bits. */
export const WK = 1;
export const WQ = 2;
export const BK = 4;
export const BQ = 8;

/**
 * Internal Move: `from | to << 6 | promotionType << 12 | flag << 15`, where
 * `promotionType` is 0 or KNIGHT..QUEEN and `flag` one of the FLAG_* values.
 */
export type IMove = number;

export const moveFrom = (m: IMove): number => m & 63;
export const moveTo = (m: IMove): number => (m >> 6) & 63;
export const movePromotion = (m: IMove): number => (m >> 12) & 7;
export const moveFlag = (m: IMove): number => (m >> 15) & 3;
const mk = (from: number, to: number, promo = 0, flag = 0): IMove =>
  from | (to << 6) | (promo << 12) | (flag << 15);

function targets(deltas: readonly (readonly [number, number])[]): number[][] {
  return Array.from({ length: 64 }, (_, s) => {
    const out: number[] = [];
    for (const [df, dr] of deltas) {
      const f = (s & 7) + df, r = (s >> 3) + dr;
      if (f >= 0 && f < 8 && r >= 0 && r < 8) out.push(r * 8 + f);
    }
    return out;
  });
}

const KNIGHT_TARGETS = targets([
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
]);
const KING_TARGETS = targets([
  [0, 1],
  [1, 1],
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1],
]);
/** PAWN_ATTACKS[0][s]: squares a white pawn on `s` attacks; [1] for black. */
const PAWN_ATTACKS = [
  targets([[-1, 1], [1, 1]]),
  targets([[-1, -1], [1, -1]]),
] as const;
/** Ray directions: 0..3 orthogonal (rook), 4..7 diagonal (bishop). */
const DIRS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
/** RAYS[d][s]: squares from `s` outward in direction `d`, nearest first. */
const RAYS: readonly (readonly (readonly number[])[])[] = DIRS.map((
  [df, dr],
) =>
  Array.from({ length: 64 }, (_, s) => {
    const out: number[] = [];
    let f = (s & 7) + df, r = (s >> 3) + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      out.push(r * 8 + f);
      f += df;
      r += dr;
    }
    return out;
  })
);

/** Castling rights kept when a Move touches a square (from or to). */
const CASTLE_MASK = new Int8Array(64).fill(15);
CASTLE_MASK[4] = 15 & ~(WK | WQ);
CASTLE_MASK[7] = 15 & ~WK;
CASTLE_MASK[0] = 15 & ~WQ;
CASTLE_MASK[60] = 15 & ~(BK | BQ);
CASTLE_MASK[63] = 15 & ~BK;
CASTLE_MASK[56] = 15 & ~BQ;

export class Board {
  /** Piece codes per square, 0 = empty. */
  readonly sq = new Int8Array(64);
  /** True when black is to move. */
  black = false;
  /** WK | WQ | BK | BQ bits. */
  castling = 0;
  /** En passant target square or -1. */
  ep = -1;
  /** King squares: [white, black]. */
  readonly kings = [-1, -1];
  readonly #undo: number[] = [];

  /** Call after filling `sq` directly. */
  locateKings(): void {
    for (let s = 0; s < 64; s++) {
      if (this.sq[s] === KING) this.kings[0] = s;
      else if (this.sq[s] === (KING | BLACK)) this.kings[1] = s;
    }
  }

  /** Whether `s` is attacked by a piece of the given colour. */
  attacked(s: number, byBlack: boolean): boolean {
    const sq = this.sq;
    const c = byBlack ? BLACK : 0;
    // A white pawn attacks `s` from where a black pawn on `s` would attack.
    for (const a of PAWN_ATTACKS[byBlack ? 0 : 1][s]!) {
      if (sq[a] === (PAWN | c)) return true;
    }
    for (const a of KNIGHT_TARGETS[s]!) if (sq[a] === (KNIGHT | c)) return true;
    for (const a of KING_TARGETS[s]!) if (sq[a] === (KING | c)) return true;
    for (let d = 0; d < 8; d++) {
      const slider = d < 4 ? ROOK : BISHOP;
      for (const a of RAYS[d]![s]!) {
        const p = sq[a]!;
        if (p === 0) continue;
        if (p === (slider | c) || p === (QUEEN | c)) return true;
        break;
      }
    }
    return false;
  }

  inCheck(): boolean {
    return this.attacked(this.kings[this.black ? 1 : 0]!, !this.black);
  }

  /** Pseudo-legal Moves (own king may be left in check). */
  pseudoMoves(out: IMove[]): void {
    const sq = this.sq;
    const c = this.black ? BLACK : 0;
    const enemy = (p: number) => p !== 0 && (p & BLACK) !== c;
    for (let s = 0; s < 64; s++) {
      const p = sq[s]!;
      if (p === 0 || (p & BLACK) !== c) continue;
      const t = p & 7;
      if (t === PAWN) {
        const dir = this.black ? -8 : 8;
        const one = s + dir;
        const promote = (one >> 3) === (this.black ? 0 : 7);
        const push = (to: number, flag = 0) => {
          if (promote) {
            for (let q = QUEEN; q >= KNIGHT; q--) out.push(mk(s, to, q));
          } else out.push(mk(s, to, 0, flag));
        };
        if (sq[one] === 0) {
          push(one);
          if ((s >> 3) === (this.black ? 6 : 1) && sq[one + dir] === 0) {
            push(one + dir, FLAG_DOUBLE);
          }
        }
        for (const a of PAWN_ATTACKS[this.black ? 1 : 0][s]!) {
          if (enemy(sq[a]!)) push(a);
          else if (a === this.ep) out.push(mk(s, a, 0, FLAG_EN_PASSANT));
        }
      } else if (t === KNIGHT || t === KING) {
        for (const a of (t === KNIGHT ? KNIGHT_TARGETS : KING_TARGETS)[s]!) {
          if (sq[a] === 0 || enemy(sq[a]!)) out.push(mk(s, a));
        }
      } else {
        const d0 = t === BISHOP ? 4 : 0, d1 = t === ROOK ? 4 : 8;
        for (let d = d0; d < d1; d++) {
          for (const a of RAYS[d]![s]!) {
            const q = sq[a]!;
            if (q === 0) out.push(mk(s, a));
            else {
              if (enemy(q)) out.push(mk(s, a));
              break;
            }
          }
        }
      }
    }
    // Castling; the rights imply king and rook are on their home squares.
    // The king's destination is checked by the legality filter.
    const k = this.black ? 60 : 4;
    const them = !this.black;
    const [kingside, queenside] = this.black ? [BK, BQ] : [WK, WQ];
    if (
      (this.castling & kingside) && sq[k + 1] === 0 && sq[k + 2] === 0 &&
      !this.attacked(k, them) && !this.attacked(k + 1, them)
    ) out.push(mk(k, k + 2, 0, FLAG_CASTLE));
    if (
      (this.castling & queenside) && sq[k - 1] === 0 && sq[k - 2] === 0 &&
      sq[k - 3] === 0 && !this.attacked(k, them) && !this.attacked(k - 1, them)
    ) out.push(mk(k, k - 2, 0, FLAG_CASTLE));
  }

  /** Legal Moves of the side to move. */
  legalMoves(): IMove[] {
    const pseudo: IMove[] = [];
    this.pseudoMoves(pseudo);
    const out: IMove[] = [];
    const me = this.black ? 1 : 0;
    for (const m of pseudo) {
      this.make(m);
      if (!this.attacked(this.kings[me]!, this.black)) out.push(m);
      this.unmake(m);
    }
    return out;
  }

  make(m: IMove): void {
    const sq = this.sq;
    const from = moveFrom(m), to = moveTo(m), promo = movePromotion(m);
    const flag = moveFlag(m);
    const p = sq[from]!;
    this.#undo.push(sq[to]! | (this.castling << 4) | ((this.ep + 1) << 8));
    sq[to] = promo ? promo | (p & BLACK) : p;
    sq[from] = 0;
    if (flag === FLAG_EN_PASSANT) sq[to + (this.black ? 8 : -8)] = 0;
    else if (flag === FLAG_CASTLE) {
      const [rf, rt] = to > from ? [from + 3, from + 1] : [from - 4, from - 1];
      sq[rt] = sq[rf]!;
      sq[rf] = 0;
    }
    if ((p & 7) === KING) this.kings[this.black ? 1 : 0] = to;
    this.castling &= CASTLE_MASK[from]! & CASTLE_MASK[to]!;
    this.ep = flag === FLAG_DOUBLE ? (from + to) >> 1 : -1;
    this.black = !this.black;
  }

  unmake(m: IMove): void {
    const sq = this.sq;
    const from = moveFrom(m), to = moveTo(m), flag = moveFlag(m);
    this.black = !this.black;
    const u = this.#undo.pop()!;
    this.castling = (u >> 4) & 15;
    this.ep = (u >> 8) - 1;
    const p = movePromotion(m) ? PAWN | (sq[to]! & BLACK) : sq[to]!;
    sq[from] = p;
    sq[to] = u & 15;
    if (flag === FLAG_EN_PASSANT) {
      sq[to + (this.black ? 8 : -8)] = PAWN | (this.black ? 0 : BLACK);
    } else if (flag === FLAG_CASTLE) {
      const [rf, rt] = to > from ? [from + 3, from + 1] : [from - 4, from - 1];
      sq[rf] = sq[rt]!;
      sq[rt] = 0;
    }
    if ((p & 7) === KING) this.kings[this.black ? 1 : 0] = from;
  }

  /** Number of leaf nodes of the legal Move tree `depth` plies deep. */
  perft(depth: number): number {
    if (depth === 0) return 1;
    const moves = this.legalMoves();
    if (depth === 1) return moves.length;
    let n = 0;
    for (const m of moves) {
      this.make(m);
      n += this.perft(depth - 1);
      this.unmake(m);
    }
    return n;
  }
}
