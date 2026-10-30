/**
 * A transposition table: what earlier searches found out about a Position,
 * looked up by the Position's key (its `Notation.encodePosition` text).
 *
 * An entry holds the best Move found (to search it first next time) and the
 * score, with how far it can be trusted: how deep the search went, and
 * whether the score is exact or only a bound (alpha-beta cut the search
 * short). Forced wins and losses are counted from the Position itself, not
 * from the root, because the same Position can be reached at different
 * plies ({@link toTableScore}).
 *
 * The table has a fixed number of slots, so it never grows beyond its
 * capacity. A key hashes to one slot, which holds one entry. Replacement
 * prefers depth: a new entry does not replace one searched deeper in the
 * same iteration (depth of iterative deepening), but entries from earlier
 * iterations always give way, so the table does not fill up with stale
 * results.
 */

import { MATE_BOUND } from "@boardwright/engine-search";

/**
 * What a fail-soft alpha-beta search of window (alpha, beta) returned: the
 * exact value if it lies inside the window; otherwise the search stopped
 * early, and the value is only an upper bound (failed low, <= alpha) or a
 * lower bound (failed high, >= beta).
 */
export type Bound = "exact" | "lower" | "upper";

/** What a search stored about one Position. */
export interface Entry {
  /**
   * Index of the best Move found in `rules.legalMoves(position)`, or -1 if
   * none. Games are deterministic, so the same key always lists the same
   * Moves in the same order.
   */
  readonly move: number;
  /**
   * Plies searched below the Position, or Infinity if the search hit no
   * horizon (every branch it looked at ended in an Outcome): then the score
   * holds at any depth.
   */
  readonly depth: number;
  /**
   * The search's score, from the perspective of the Seat to move, with
   * forced wins and losses counted from this Position ({@link toTableScore}).
   */
  readonly score: number;
  readonly bound: Bound;
}

/**
 * A score found `ply` plies below the root, as stored in the table: the
 * search counts a forced win as `MATE - p` with `p` plies from the root
 * (see `@boardwright/engine-search`), the table counts from the Position.
 */
export function toTableScore(score: number, ply: number): number {
  if (score > MATE_BOUND) return score + ply;
  if (score < -MATE_BOUND) return score - ply;
  return score;
}

/** A stored score, for the Position reached `ply` plies below the root. */
export function fromTableScore(score: number, ply: number): number {
  return toTableScore(score, -ply);
}

export interface TranspositionTable {
  /** The entry stored for `key`, if it is still in the table. */
  get(key: string): Entry | undefined;
  /**
   * Stores `entry` for `key`, replacing what its slot holds unless that was
   * searched deeper in the current iteration.
   */
  set(key: string, entry: Entry): void;
  /** Starts a new iteration: older entries give way to any new one. */
  nextIteration(): void;
  /** Number of entries held; never more than the capacity. */
  readonly size: number;
}

interface Slot {
  readonly key: string;
  readonly entry: Entry;
  readonly iteration: number;
}

/** Creates an empty table with `capacity` slots (an integer >= 1). */
export function createTranspositionTable(
  capacity: number,
): TranspositionTable {
  if (!(Number.isInteger(capacity) && capacity >= 1)) {
    throw new RangeError(`capacity must be an integer >= 1, got ${capacity}`);
  }
  const slots: (Slot | undefined)[] = new Array(capacity);
  let size = 0;
  let iteration = 0;

  /** FNV-1a hash of `key`, reduced to a slot index. */
  function slotOf(key: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
    }
    return (h >>> 0) % capacity;
  }

  return {
    get(key) {
      const slot = slots[slotOf(key)];
      return slot?.key === key ? slot.entry : undefined;
    },
    set(key, entry) {
      const i = slotOf(key);
      const old = slots[i];
      if (old === undefined) size++;
      else if (old.iteration === iteration && old.entry.depth > entry.depth) {
        return; // keep the deeper result
      }
      slots[i] = { key, entry, iteration };
    },
    nextIteration() {
      iteration++;
    },
    get size() {
      return size;
    },
  };
}
