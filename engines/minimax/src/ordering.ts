/**
 * Move ordering below the hash Move. The Game's Moves are listed by
 * `rules.legalMoves`; the table stores the hash Move as an index into that
 * list, so the search works on a permutation of indices and never reorders
 * the Moves themselves.
 *
 * Convention (killer Moves and the history heuristic slot into it):
 * 1. the hash Move;
 * 2. tactical Moves, `movePriority > 0` (captures, promotions), by priority,
 *    highest first;
 * 3. (room for killer Moves)
 * 4. quiet Moves, `movePriority <= 0` (and every Move without a hook), by
 *    priority, highest first (room for history scores).
 * The Game's order breaks ties everywhere.
 */

/** Engine-supplied priority of `move` in `position`; see `MinimaxOptions`. */
export type MovePriority<Position, Move> = (
  position: Position,
  move: Move,
) => number;

/**
 * The indices of `moves` in the order to try them: `hashMove` (an index, or
 * -1) first, then the rest by descending priority (stable). Calls `priority`
 * once per Move except the hash Move. Throws a RangeError for a priority that
 * is not finite. Reuses `scratch` for the priorities.
 */
export function orderMoves<Position, Move>(
  position: Position,
  moves: readonly Move[],
  hashMove: number,
  priority: MovePriority<Position, Move>,
  scratch: number[],
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
  if (!sorted) return order;
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
  return order;
}
