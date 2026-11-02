/**
 * Move ordering below the hash Move. The Game's Moves are listed by
 * `rules.legalMoves`; the table stores the hash Move as an index into that
 * list, so the search works on a permutation of indices and never reorders
 * the Moves themselves.
 *
 * Convention (the history heuristic slots into it):
 * 1. the hash Move;
 * 2. tactical Moves, `movePriority > 0` (captures, promotions), by priority,
 *    highest first;
 * 3. killer Moves: the quiet Moves that last caused a beta cutoff at the same
 *    ply (`Killers`), the newer first, those legal here and not the hash Move;
 * 4. the other quiet Moves, `movePriority <= 0` (and every Move without a
 *    hook), by priority, highest first (room for history scores).
 * The Game's order breaks ties everywhere.
 *
 * A Move has no identity across Positions (the Game's Moves are opaque), so
 * killers are remembered as `encodeMove` text, and compared lazily.
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
  if (killers && encode) {
    placeKillers(moves, order, start, scratch, killers, ply, encode);
  }
  return order;
}

/** Moves the killers of `ply` found among the quiet Moves after the tactical ones. */
function placeKillers<Move>(
  moves: readonly Move[],
  order: number[],
  start: number,
  scratch: readonly number[],
  killers: Killers,
  ply: number,
  encode: (move: Move) => string,
): void {
  const newer = killers.newer(ply);
  if (newer === undefined) return;
  const older = killers.older(ply);
  let first = -1; // positions in `order` of the newer and the older killer
  let second = -1;
  let t = start; // end of the tactical Moves
  while (t < order.length && scratch[order[t]!]! > 0) t++;
  for (let a = t; a < order.length; a++) {
    const key = encode(moves[order[a]!]!);
    if (first < 0 && key === newer) first = a;
    else if (second < 0 && key === older) second = a;
    else continue;
    if (first >= 0 && (older === undefined || second >= 0)) break;
  }
  if (first < 0 && second < 0) return;
  // Shift the quiet Moves in front of the last found killer up by the killers.
  const picked = [first, second].filter((a) => a >= 0);
  const ids = picked.map((a) => order[a]!);
  const last = Math.max(first, second);
  let w = last;
  for (let a = last; a >= t; a--) {
    if (!picked.includes(a)) order[w--] = order[a]!;
  }
  for (let j = ids.length - 1; j >= 0; j--) order[w--] = ids[j]!;
}
