import {
  assert,
  assertEquals,
  assertObjectMatch,
  assertThrows,
} from "@std/assert";
import { MATE, MAX_EVALUATION } from "@boardwright/engine-search";
import {
  createTranspositionTable,
  type Entry,
  ENTRY_BYTES,
  fromTableScore,
  MAX_TABLE_BYTES,
  SLOT_BYTES,
  toTableScore,
  type TranspositionTable,
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
  // A probe stores for its own key, even after other keys were stored.
  const probe = table.probe("d");
  set(table, "e", entry(1, 1));
  probe.store(entry(5, 2));
  assertHolds(table, "d", entry(5, 2));
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

Deno.test("a full budget keeps the entries it has", () => {
  const table = createTranspositionTable(ONE_SLOT);
  const key = (c: string, length: number) => c.repeat(length);
  set(table, key("a", 100), entry(1));
  // Another key of the same length replaces it (a later iteration)...
  table.nextIteration();
  set(table, key("b", 100), entry(1));
  assertHolds(table, key("b", 100), entry(1));
  // ...but a longer one would exceed the budget: the old entry stays.
  table.nextIteration();
  set(table, key("c", 200), entry(1));
  assertHolds(table, key("c", 200));
  assertHolds(table, key("b", 100), entry(1));
  assertEquals(table.bytes, SLOT_BYTES + ENTRY_BYTES + 100);
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
