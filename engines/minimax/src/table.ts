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
 * Keys are exact, so a hit is never another Position's entry, but they can
 * be long: a key with a long repetition history runs to a few kilobytes. So
 * the table is bounded by a memory budget in bytes. It counts each entry as
 * {@link ENTRY_BYTES} plus its key (one byte per character, two if the key
 * has a character beyond Latin-1, as V8 then stores the whole string), and
 * each slot as {@link SLOT_BYTES}. An entry that would exceed the budget is
 * not stored.
 *
 * A key hashes to one slot, which holds one entry. There is one slot per
 * {@link ENTRY_BYTES} of budget, so with real keys the budget runs out
 * before the slots do. The slots are allocated in chunks, when a store first
 * needs one, so a short search does not pay for a large budget. Replacement
 * prefers depth: a new entry does not replace one searched deeper in the
 * same iteration (depth of iterative deepening), but entries from earlier
 * iterations always give way, so the table does not fill up with stale
 * results. This holds when the budget is full as well: an entry that does
 * not fit still drops an occupant from an earlier iteration, so the budget
 * keeps turning over.
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
   * none. The key determines the Position, so the same key lists the same
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

/**
 * Bytes counted per entry besides its key: the entry object and the key's
 * string header. Measured in V8 at about 100-110 bytes; rounded up, so the
 * budget is an upper bound.
 */
export const ENTRY_BYTES = 160;
/** Bytes counted per slot (one reference). */
export const SLOT_BYTES = 8;
/** Largest memory budget, 4 GiB (some 27 million slots). */
export const MAX_TABLE_BYTES = 2 ** 32;

/** Checks a memory budget: an integer from 0 to {@link MAX_TABLE_BYTES}. */
export function checkTableBytes(bytes: number): void {
  if (!(Number.isInteger(bytes) && bytes >= 0 && bytes <= MAX_TABLE_BYTES)) {
    throw new RangeError(
      `tableBytes must be an integer from 0 to ${MAX_TABLE_BYTES}, got ${bytes}`,
    );
  }
}

/** A key looked up in the table, ready to store a new result for it. */
export interface Probe {
  /** What is stored for the key, if anything. */
  readonly entry: Entry | undefined;
  /**
   * Stores `entry` for the key, unless its slot holds an entry searched
   * deeper in the current iteration, or it would exceed the budget.
   */
  store(entry: Entry): void;
}

export interface TranspositionTable {
  /** Looks up `key`; it is hashed once, for the lookup and a later store. */
  probe(key: string): Probe;
  /** Starts a new iteration: older entries give way to any new one. */
  nextIteration(): void;
  /** Number of entries held. */
  readonly size: number;
  /** Bytes counted for the slots and entries; never more than the budget. */
  readonly bytes: number;
}

/** The probe of a table without slots. */
const NOTHING: Probe = { entry: undefined, store() {} };

/** Slots per chunk: the slot array is allocated chunk by chunk, on first use. */
export const CHUNK_SLOTS = 256;

interface Slot extends Entry {
  readonly key: string;
  /** Bytes counted for this entry. */
  readonly cost: number;
  readonly iteration: number;
}

/**
 * Creates an empty table with a memory budget of `budget` bytes (see
 * {@link checkTableBytes}). A budget below {@link ENTRY_BYTES} (e.g. 0) has
 * no slot and stores nothing.
 *
 * There is one slot per {@link ENTRY_BYTES} of budget, but the slot array is
 * allocated in chunks of {@link CHUNK_SLOTS} slots when a store first needs
 * them, so a short search does not pay for a large budget (a 256 MiB table
 * has 1.7 million slots, 13 MB). A chunk counts as {@link SLOT_BYTES} per
 * slot once allocated, and is allocated only if the budget has room for it,
 * so `bytes` never exceeds the budget.
 */
export function createTranspositionTable(budget: number): TranspositionTable {
  checkTableBytes(budget);
  const slotCount = Math.floor(budget / ENTRY_BYTES);
  const chunks: ((Slot | undefined)[] | undefined)[] = new Array(
    Math.ceil(slotCount / CHUNK_SLOTS),
  );
  let bytes = 0;
  let size = 0;
  let iteration = 0;

  return {
    probe(key) {
      if (slotCount === 0) return NOTHING;
      // FNV-1a hash, noting whether the key needs two bytes per character.
      let h = 0x811c9dc5;
      let wide = false;
      for (let i = 0; i < key.length; i++) {
        const c = key.charCodeAt(i);
        if (c > 0xff) wide = true;
        h = Math.imul(h ^ c, 0x01000193);
      }
      const i = (h >>> 0) % slotCount;
      const chunk = Math.floor(i / CHUNK_SLOTS);
      const at = i - chunk * CHUNK_SLOTS;
      const cost = ENTRY_BYTES + (wide ? 2 : 1) * key.length;
      const found = chunks[chunk]?.[at];
      return {
        entry: found?.key === key ? found : undefined,
        store(entry) {
          let slots = chunks[chunk]; // may have changed since the lookup
          const old = slots?.[at];
          if (old?.iteration === iteration && old.depth > entry.depth) return;
          const growth = cost - (old?.cost ?? 0);
          const chunkBytes = slots === undefined
            ? Math.min(CHUNK_SLOTS, slotCount - chunk * CHUNK_SLOTS) *
              SLOT_BYTES
            : 0;
          if (bytes + chunkBytes + growth > budget) {
            // No room: an entry from an earlier iteration still gives way,
            // so the budget keeps turning over.
            if (old !== undefined && old.iteration < iteration) {
              slots![at] = undefined;
              bytes -= old.cost;
              size--;
            }
            return;
          }
          if (slots === undefined) {
            slots = chunks[chunk] = new Array(
              chunkBytes / SLOT_BYTES,
            );
          }
          bytes += chunkBytes + growth;
          if (old === undefined) size++;
          const { move, depth, score, bound } = entry;
          slots[at] = { key, cost, iteration, move, depth, score, bound };
        },
      };
    },
    nextIteration() {
      iteration++;
    },
    get size() {
      return size;
    },
    get bytes() {
      return bytes;
    },
  };
}
