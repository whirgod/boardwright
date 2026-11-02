import type { Seat } from "@boardwright/core";

/**
 * Move ordering below the hash Move. The Game's Moves are listed by
 * `rules.legalMoves`; the table stores the hash Move as an index into that
 * list, so the search works on a permutation of indices and never reorders
 * the Moves themselves.
 *
 * Convention:
 * 1. the hash Move;
 * 2. tactical Moves, `movePriority > 0` (captures, promotions), by priority,
 *    highest first;
 * 3. killer Moves: the quiet Moves that last caused a beta cutoff at the same
 *    ply (`Killers`), the newer first, those legal here and not the hash Move;
 * 4. the other quiet Moves, `movePriority <= 0` (and every Move without a
 *    hook), by priority, highest first, equal priorities by history score
 *    (`HistoryScores`), highest first.
 * The Game's order breaks ties everywhere.
 *
 * A Move has no identity across Positions (the Game's Moves are opaque), so
 * killers are remembered as `encodeMove` text, and compared lazily; the
 * history heuristic keys its scores by the Engine's `moveKey` (default the
 * same text), and looks the key up for every quiet Move at a node (once the
 * history has a score).
 */

/**
 * The last two killer Moves per ply (distance from the root), as encoded
 * Moves. One instance per search, cleared at each depth of iterative
 * deepening: killers from a shallower depth are Moves of smaller subtrees, and
 * keeping them measured no better (checkers depth 11: 13% more nodes; chess
 * and morris: 1-2% fewer).
 */
export class Killers {
  readonly #newer: (string | undefined)[] = [];
  readonly #older: (string | undefined)[] = [];

  clear(): void {
    this.#newer.length = 0;
    this.#older.length = 0;
  }

  newer(ply: number): string | undefined {
    return this.#newer[ply];
  }

  older(ply: number): string | undefined {
    return this.#older[ply];
  }

  /** Remembers `key` as the newest killer at `ply` (the previous one ages). */
  record(ply: number, key: string): void {
    const newer = this.#newer[ply];
    if (newer === key) return;
    this.#older[ply] = newer;
    this.#newer[ply] = key;
  }
}

/** What identifies a Move for `HistoryScores`: see `MinimaxOptions.moveKey`. */
export type HistoryKey = string | number;

/** What `orderMoves` needs to apply the history heuristic. */
export interface HistoryUse<Move> {
  readonly history: HistoryScores;
  readonly seat: Seat;
  readonly key: (move: Move) => HistoryKey;
}

/** Most (Seat, Move) scores `HistoryScores` keeps; see there. */
export const HISTORY_ENTRIES = 1 << 16;
/** A score that would pass this halves all scores first; see `HistoryScores`. */
const HISTORY_SCORE_LIMIT = 1 << 24;

/**
 * The history heuristic's scores: a score per (Seat, quiet Move) that grows with every beta
 * cutoff the Move caused (by depth squared: a cutoff near the root saves a
 * bigger subtree), in any Position of the search. A quiet Move that refuted
 * many Positions is tried earlier in the others. Moves are opaque, so a Move
 * is identified by its key, the Engine's `moveKey` (default: `encodeMove`
 * text), per Seat to move (a Move has no meaning for the other Seat). Bounded: past `HISTORY_ENTRIES` entries, or a score past a limit, all
 * scores are halved (dropping those that reach 0), which is also how the
 * scores age between the depths of iterative deepening.
 */
export class HistoryScores {
  readonly #scores = new Map<Seat, Map<HistoryKey, number>>();
  #size = 0;
  /** Scratch of `orderMoves`: the scores of a node's Moves, by Move index. */
  readonly values: number[] = [];

  /** Number of (Seat, Move) scores kept. */
  get size(): number {
    return this.#size;
  }

  score(seat: Seat, key: HistoryKey): number {
    return this.#scores.get(seat)?.get(key) ?? 0;
  }

  /** Credits `key` for a cutoff at `depth` (plies left, >= 1). */
  record(seat: Seat, key: HistoryKey, depth: number, sign = 1): void {
    const add = sign * depth * depth;
    let scores = this.#scores.get(seat);
    let old = scores?.get(key);
    if (
      old === undefined
        ? this.#size >= HISTORY_ENTRIES
        : Math.abs(old + add) > HISTORY_SCORE_LIMIT
    ) {
      this.age();
      scores = this.#scores.get(seat);
      old = scores?.get(key);
      // Still full (every score was large): the new Move goes unrecorded.
      if (old === undefined && this.#size >= HISTORY_ENTRIES) return;
    }
    if (scores === undefined) this.#scores.set(seat, scores = new Map());
    const next = (old ?? 0) + add;
    if (next === 0) {
      // No information: do not hold a slot of the cap.
      if (old !== undefined) {
        scores.delete(key);
        this.#size--;
      }
      return;
    }
    if (old === undefined) this.#size++;
    scores.set(key, next);
  }

  /** Halves every score, dropping the ones that reach 0. */
  age(): void {
    for (const [seat, scores] of this.#scores) {
      for (const [key, value] of scores) {
        const half = Math.trunc(value / 2);
        if (half === 0) {
          scores.delete(key);
          this.#size--;
        } else scores.set(key, half);
      }
      if (scores.size === 0) this.#scores.delete(seat);
    }
  }
}

/** Engine-supplied priority of `move` in `position`; see `MinimaxOptions`. */
export type MovePriority<Position, Move> = (
  position: Position,
  move: Move,
) => number;

/**
 * The indices of `moves` in the order to try them: `hashMove` (an index, or
 * -1) first, then the rest by descending priority (stable), with the killer
 * Moves of `ply` (if `killers` is given) after the tactical ones. Calls
 * `priority` once per Move except the hash Move, and `encode` only on quiet
 * Moves, until every killer is found. Throws a RangeError for a priority that
 * is not finite. Reuses `scratch` for the priorities.
 */
export function orderMoves<Position, Move>(
  position: Position,
  moves: readonly Move[],
  hashMove: number,
  priority: MovePriority<Position, Move>,
  scratch: number[],
  killers?: Killers,
  ply = 0,
  encode?: (move: Move) => string,
  use?: HistoryUse<Move>,
): number[] {
  const n = moves.length;
  const order: number[] = new Array(n);
  let sorted = false; // some priority differs from its predecessor's
  let m = 0;
  if (hashMove >= 0) order[m++] = hashMove;
  const start = m;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    if (i === hashMove) continue;
    const p = priority(position, moves[i]!);
    if (!Number.isFinite(p)) {
      throw new RangeError(
        `movePriority must return a finite number, got ${p}`,
      );
    }
    if (m > start && p !== prev) sorted = true;
    prev = p;
    scratch[i] = p;
    order[m++] = i;
  }
  if (sorted) {
    // Stable insertion sort of the part after the hash Move, descending.
    for (let a = start + 1; a < n; a++) {
      const idx = order[a]!;
      const p = scratch[idx]!;
      let b = a - 1;
      while (b >= start && scratch[order[b]!]! < p) {
        order[b + 1] = order[b]!;
        b--;
      }
      order[b + 1] = idx;
    }
  }
  let t = start; // end of the tactical Moves
  while (t < n && scratch[order[t]!]! > 0) t++;
  if (use && use.history.size > 0 && n - t > 1) {
    sortByHistory(moves, order, t, scratch, use);
  }
  if (killers && encode) {
    placeKillers(moves, order, t, killers, ply, encode);
  }
  return order;
}

/**
 * Stable sort of the quiet Moves `order[t..]` (already sorted by priority) by
 * descending history score within equal priorities.
 */
function sortByHistory<Move>(
  moves: readonly Move[],
  order: number[],
  t: number,
  scratch: readonly number[],
  { history, seat, key }: HistoryUse<Move>,
): void {
  const values = history.values;
  const n = order.length;
  let any = false;
  for (let a = t; a < n; a++) {
    const idx = order[a]!;
    const v = history.score(seat, key(moves[idx]!));
    values[idx] = v;
    if (v !== 0) any = true;
  }
  if (!any) return;
  for (let a = t + 1; a < n; a++) {
    const idx = order[a]!;
    const p = scratch[idx]!;
    const v = values[idx]!;
    let b = a - 1;
    while (b >= t) {
      const other = order[b]!;
      const q = scratch[other]!;
      if (q > p || (q === p && values[other]! >= v)) break;
      order[b + 1] = other;
      b--;
    }
    order[b + 1] = idx;
  }
}

/** Moves the killers of `ply` found among the quiet Moves after the tactical ones. */
function placeKillers<Move>(
  moves: readonly Move[],
  order: number[],
  t: number, // end of the tactical Moves
  killers: Killers,
  ply: number,
  encode: (move: Move) => string,
): void {
  const newer = killers.newer(ply);
  if (newer === undefined) return;
  const older = killers.older(ply);
  let first = -1; // positions in `order` of the newer and the older killer
  let second = -1;
  for (let a = t; a < order.length; a++) {
    const key = encode(moves[order[a]!]!);
    if (first < 0 && key === newer) first = a;
    else if (second < 0 && key === older) second = a;
    else continue;
    if (first >= 0 && (older === undefined || second >= 0)) break;
  }
  if (first < 0 && second < 0) return;
  // Shift the quiet Moves in front of the last killer found up by the number
  // of killers, then put the killers (newer first) at `t`.
  const idFirst = first >= 0 ? order[first]! : -1;
  const idSecond = second >= 0 ? order[second]! : -1;
  const last = first > second ? first : second;
  let w = last;
  for (let a = last; a >= t; a--) {
    if (a !== first && a !== second) order[w--] = order[a]!;
  }
  if (idSecond >= 0) order[w--] = idSecond;
  if (idFirst >= 0) order[w--] = idFirst;
}
