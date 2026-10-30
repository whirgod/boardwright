import { assert, assertEquals, assertThrows } from "@std/assert";
import { MATE, MAX_EVALUATION } from "@boardwright/engine-search";
import {
  createTranspositionTable,
  type Entry,
  fromTableScore,
  toTableScore,
} from "./table.ts";

const entry = (depth: number, move = 0): Entry => ({
  move,
  depth,
  score: 0,
  bound: "exact",
});

Deno.test("returns what was stored, by key", () => {
  const table = createTranspositionTable(1024);
  assertEquals(table.get("a"), undefined);
  table.set("a", entry(2, 3));
  table.set("b", entry(1, 0));
  assertEquals(table.get("a"), entry(2, 3));
  assertEquals(table.get("b"), entry(1, 0));
  assertEquals(table.get("c"), undefined);
  assertEquals(table.size, 2);
});

Deno.test("stays within its capacity", () => {
  for (const capacity of [1, 7, 64]) {
    const table = createTranspositionTable(capacity);
    for (let i = 0; i < 1000; i++) {
      table.set(`key ${i}`, entry(i % 5, i));
      if (i % 100 === 0) table.nextIteration();
      assert(table.size <= capacity, `${table.size} > ${capacity}`);
    }
    assertEquals(table.size, capacity);
    // Whatever is still held belongs to its own key.
    for (let i = 0; i < 1000; i++) {
      const found = table.get(`key ${i}`);
      if (found) assertEquals(found.move, i);
    }
  }
});

Deno.test("replacement keeps the deeper entry within an iteration", () => {
  const table = createTranspositionTable(1); // every key shares one slot
  table.set("deep", entry(3));
  table.set("shallow", entry(2));
  assertEquals(table.get("deep"), entry(3));
  assertEquals(table.get("shallow"), undefined);
  // The same depth replaces, and so does the same key searched again.
  table.set("other", entry(3));
  assertEquals(table.get("other"), entry(3));
  table.set("other", entry(4, 1));
  assertEquals(table.get("other"), entry(4, 1));
  assertEquals(table.size, 1);
});

Deno.test("entries from an earlier iteration always give way", () => {
  const table = createTranspositionTable(1);
  table.set("old", entry(Infinity));
  table.nextIteration();
  table.set("new", entry(1));
  assertEquals(table.get("old"), undefined);
  assertEquals(table.get("new"), entry(1));
});

Deno.test("rejects an invalid capacity", () => {
  for (const capacity of [0, -1, 1.5, NaN, Infinity]) {
    assertThrows(() => createTranspositionTable(capacity), RangeError);
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
