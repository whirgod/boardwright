import {
  assert,
  assertEquals,
  assertObjectMatch,
  assertThrows,
} from "@std/assert";
import { MATE, MAX_EVALUATION } from "./mod.ts";
import {
  CHUNK_SLOTS,
  createTranspositionTable,
  type Entry,
  ENTRY_BYTES,
  fromTableScore,
  MAX_TABLE_BYTES,
  SLOT_BYTES,
  toTableScore,
  type TranspositionTable,
  tryOrder,
} from "./table.ts";

const entry = (depth: number, move = 0): Entry => ({
  move,
  depth,
  score: 0,
  bound: "exact",
});

const set = (table: TranspositionTable, key: string, e: Entry) =>
  table.probe(key).store(e);

/** Asserts what `table` holds for `key` (undefined: nothing). */
function assertHolds(table: TranspositionTable, key: string, e?: Entry) {
  const found = table.probe(key).entry;
  if (e === undefined) assertEquals(found, undefined, key);
  else assertObjectMatch(found ?? {}, { ...e }, key);
}

/** A budget with exactly one slot, room for one entry with a short key. */
const ONE_SLOT = 300;

Deno.test("returns what was stored, by key", () => {
  const table = createTranspositionTable(4096);
  assertHolds(table, "a");
  set(table, "a", entry(2, 3));
  set(table, "b", entry(1, 0));
  assertHolds(table, "a", entry(2, 3));
  assertHolds(table, "b", entry(1, 0));
  assertHolds(table, "c");
  assertEquals(table.size, 2);
});

Deno.test("a probe stores for its own key, even after other keys were stored", () => {
  const table = createTranspositionTable(4096);
  const probe = table.probe("d");
  set(table, "e", entry(1, 1));
  probe.store(entry(5, 2));
  assertHolds(table, "d", entry(5, 2));
});

Deno.test("store re-reads its slot: the budget holds when the occupant changed since the lookup", () => {
  const table = createTranspositionTable(ONE_SLOT); // all keys share the slot
  const probe = table.probe("d"); // looked up while the slot was empty
  set(table, "x".repeat(100), entry(1)); // the "subtree search" fills the slot
  assertEquals(table.bytes, SLOT_BYTES + ENTRY_BYTES + 100);
  table.nextIteration();
  set(table, "e", entry(1)); // replaces the long entry with a short one
  assertEquals(table.bytes, SLOT_BYTES + ENTRY_BYTES + 1);
  // A stale (empty) slot would add a second entry's cost.
  probe.store(entry(1, 7));
  assertHolds(table, "d", entry(1, 7));
  assertEquals(table.size, 1);
  assertEquals(table.bytes, SLOT_BYTES + ENTRY_BYTES + 1);
});

Deno.test("allocates its slots lazily, within the budget", () => {
  const budget = 256 * 2 ** 20;
  const table = createTranspositionTable(budget);
  assertEquals(table.bytes, 0);
  assertHolds(table, "a"); // a lookup allocates nothing
  assertEquals(table.bytes, 0);
  set(table, "a", entry(1, 2));
  // One chunk of slots plus the entry.
  assertEquals(table.bytes, CHUNK_SLOTS * SLOT_BYTES + ENTRY_BYTES + 1);
  assertHolds(table, "a", entry(1, 2));
  // Many keys: never over budget, and slot bytes grow with use only.
  for (let i = 0; i < 20000; i++) set(table, `key ${i}`, entry(1, i));
  assert(table.bytes <= budget);
  assert(table.bytes < budget / 4, `${table.bytes}`);
  for (const i of [0, 9999, 19999]) {
    assertHolds(table, `key ${i}`, entry(1, i));
  }
});

/** The slot index of `key` in a table of `slotCount` slots (FNV-1a, as in table.ts). */
function slotOf(key: string, slotCount: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  }
  return (h >>> 0) % slotCount;
}

/** `count` keys of `length` characters in distinct slots of chunk `chunk`. */
function keysInChunk(
  chunk: number,
  slotCount: number,
  count: number,
  length: number,
): string[] {
  const keys: string[] = [];
  const used = new Set<number>();
  for (let i = 0; keys.length < count; i++) {
    const key = `k${i}`.padEnd(length, "|");
    const slot = slotOf(key, slotCount);
    if (Math.floor(slot / CHUNK_SLOTS) !== chunk || used.has(slot)) continue;
    used.add(slot);
    keys.push(key);
  }
  return keys;
}

Deno.test("the last, partial chunk is charged for its own slots only", () => {
  const slotCount = CHUNK_SLOTS + 44;
  const table = createTranspositionTable(slotCount * ENTRY_BYTES);
  const [key] = keysInChunk(1, slotCount, 1, 10);
  set(table, key!, entry(1));
  assertEquals(table.bytes, 44 * SLOT_BYTES + ENTRY_BYTES + 10);
});

Deno.test("a chunk is allocated only if the budget has room for it", () => {
  const slotCount = 2 * CHUNK_SLOTS;
  const budget = slotCount * ENTRY_BYTES;
  const table = createTranspositionTable(budget);
  // Fill chunk 0 with long keys, leaving room for a short entry but not for
  // another chunk on top of it.
  const longKeys = keysInChunk(0, slotCount, 68, 1000);
  for (const key of longKeys) set(table, key, entry(1));
  assertEquals(table.size, 68);
  const full = CHUNK_SLOTS * SLOT_BYTES + 68 * (ENTRY_BYTES + 1000);
  assertEquals(table.bytes, full);
  const room = budget - full;
  assert(room > ENTRY_BYTES + 10 && room < CHUNK_SLOTS * SLOT_BYTES);
  // The entry itself would fit, but chunk 1 would not: not stored.
  const [other] = keysInChunk(1, slotCount, 1, 10);
  const probe = table.probe(other!);
  probe.store(entry(1));
  assertHolds(table, other!);
  assertEquals(table.size, 68);
  assertEquals(table.bytes, full);
  // An entry in the allocated chunk still fits.
  const [inChunk0] = keysInChunk(0, slotCount, 1, 10);
  set(table, inChunk0!, entry(1));
  assertHolds(table, inChunk0!, entry(1));
  assert(table.bytes <= budget);
});

Deno.test("stays within its memory budget, also with long keys", () => {
  for (const budget of [0, ONE_SLOT, 5000, 2 ** 16]) {
    const table = createTranspositionTable(budget);
    for (let i = 0; i < 2000; i++) {
      // Keys from 4 to about 4000 characters, like long repetition histories.
      const key = `key ${i} `.padEnd(4 + ((i * 7919) % 4000), "|");
      set(table, key, entry(i % 5, i));
      if (i % 100 === 0) table.nextIteration();
      assert(table.bytes <= budget, `${table.bytes} > ${budget}`);
    }
    if (budget === 0) assertEquals(table.size, 0);
    else assert(table.size > 0);
    // Whatever is still held belongs to its own key.
    for (let i = 0; i < 2000; i++) {
      const key = `key ${i} `.padEnd(4 + ((i * 7919) % 4000), "|");
      const found = table.probe(key).entry;
      if (found) assertEquals(found.move, i);
    }
  }
});

Deno.test("counts keys beyond Latin-1 at two bytes per character", () => {
  // 10 slots and room for one entry with a 1000-character key, if one byte
  // per character.
  const budget = 10 * ENTRY_BYTES;
  const room = budget - 10 * SLOT_BYTES - ENTRY_BYTES;
  const latin1 = createTranspositionTable(budget);
  set(latin1, "é".repeat(room), entry(1));
  assertEquals(latin1.size, 1);
  const wide = createTranspositionTable(budget);
  set(wide, "→".repeat(room), entry(1));
  assertEquals(wide.size, 0);
  set(wide, "→".repeat(Math.floor(room / 2)), entry(1));
  assertEquals(wide.size, 1);
  assertEquals(wide.bytes, budget - (room % 2));
});

Deno.test("a full budget does not store what would exceed it", () => {
  const table = createTranspositionTable(ONE_SLOT);
  const key = (c: string, length: number) => c.repeat(length);
  set(table, key("a", 100), entry(1));
  // Another key of the same length replaces it (a later iteration)...
  table.nextIteration();
  set(table, key("b", 100), entry(1));
  assertHolds(table, key("b", 100), entry(1));
  // ...but not one in the same iteration that is longer.
  set(table, key("c", 200), entry(1));
  assertHolds(table, key("c", 200));
  assertHolds(table, key("b", 100), entry(1));
  assertEquals(table.bytes, SLOT_BYTES + ENTRY_BYTES + 100);
});

Deno.test("an entry from an earlier iteration gives way when the budget is full", () => {
  const table = createTranspositionTable(ONE_SLOT);
  set(table, "a".repeat(100), entry(1));
  table.nextIteration();
  // Too long to fit: not stored, but the stale occupant is dropped...
  set(table, "b".repeat(200), entry(1));
  assertEquals(table.size, 0);
  assertEquals(table.bytes, SLOT_BYTES);
  // ...so the budget serves the next key, even a longer one than the old.
  set(table, "c".repeat(120), entry(1));
  assertHolds(table, "c".repeat(120), entry(1));
});

Deno.test("replacement keeps the deeper entry within an iteration", () => {
  const table = createTranspositionTable(ONE_SLOT); // all keys share a slot
  set(table, "deep", entry(3));
  set(table, "shallow", entry(2));
  assertHolds(table, "deep", entry(3));
  assertHolds(table, "shallow");
  // The same depth replaces, and so does the same key searched again.
  set(table, "other", entry(3));
  assertHolds(table, "other", entry(3));
  set(table, "other", entry(4, 1));
  assertHolds(table, "other", entry(4, 1));
  assertEquals(table.size, 1);
});

Deno.test("entries from an earlier iteration always give way", () => {
  const table = createTranspositionTable(ONE_SLOT);
  set(table, "old", entry(Infinity));
  table.nextIteration();
  set(table, "new", entry(1));
  assertHolds(table, "old");
  assertHolds(table, "new", entry(1));
});

Deno.test("rejects an invalid budget", () => {
  for (const budget of [-1, 1.5, NaN, Infinity, MAX_TABLE_BYTES + 1]) {
    assertThrows(() => createTranspositionTable(budget), RangeError);
  }
});

Deno.test("forced results are stored counted from the Position", () => {
  // Found at ply 2: a win 5 plies after the root is 3 after the Position...
  assertEquals(toTableScore(MATE - 5, 2), MATE - 3);
  // ...so where the Position recurs at ply 4, it is 7 after the root.
  assertEquals(fromTableScore(MATE - 3, 4), MATE - 7);
  assertEquals(toTableScore(-(MATE - 5), 2), -(MATE - 3));
  assertEquals(fromTableScore(-(MATE - 3), 4), -(MATE - 7));
  // Evaluations and draws do not depend on the ply.
  for (const score of [0, 42, -MAX_EVALUATION, MAX_EVALUATION]) {
    assertEquals(toTableScore(score, 3), score);
    assertEquals(fromTableScore(score, 3), score);
  }
});

Deno.test("tryOrder puts the hash Move first, the rest in the Game's order", () => {
  const order = (first: number) => [0, 1, 2, 3].map((k) => tryOrder(k, first));
  assertEquals(order(-1), [0, 1, 2, 3]);
  assertEquals(order(0), [0, 1, 2, 3]);
  assertEquals(order(2), [2, 0, 1, 3]);
  assertEquals(order(3), [3, 0, 1, 2]);
});
