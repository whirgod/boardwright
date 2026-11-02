import { assert, assertEquals, assertThrows } from "@std/assert";
import { seededRandom } from "@boardwright/testing";
import {
  HISTORY_ENTRIES,
  HistoryScores,
  Killers,
  orderMoves,
} from "./ordering.ts";

const order = (
  priorities: readonly number[],
  hashMove = -1,
  calls: number[] = [],
) =>
  orderMoves(
    null,
    priorities.map((_, i) => i),
    hashMove,
    (_p, m: number) => (calls.push(m), priorities[m]!),
    [],
  );

Deno.test("orders by descending priority; the Game's order breaks ties", () => {
  assertEquals(order([0, 5, 0, 5, -1, 2]), [1, 3, 5, 0, 2, 4]);
});

Deno.test("tactical Moves (> 0) go before quiet ones (<= 0)", () => {
  assertEquals(order([-3, 0, 1, -1]), [2, 1, 3, 0]);
});

Deno.test("the hash Move goes first and is not asked for a priority", () => {
  const calls: number[] = [];
  assertEquals(order([9, 0, 5, 0], 3, calls), [3, 0, 2, 1]);
  assertEquals(calls, [0, 1, 2]);
});

Deno.test("equal priorities keep the Game's order after the hash Move", () => {
  assertEquals(order([0, 0, 0, 0], 2), [2, 0, 1, 3]);
  assertEquals(order([0, 0, 0, 0]), [0, 1, 2, 3]);
  assertEquals(order([]), []);
});

Deno.test("a priority that is not finite is a RangeError", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assertThrows(() => order([0, bad]), RangeError, `got ${bad}`);
  }
});

Deno.test("random priorities and hash Moves: a stable, complete ordering", () => {
  const random = seededRandom(81);
  for (let round = 0; round < 500; round++) {
    const n = Math.floor(random() * 12);
    // Few distinct values (ties); negative, zero and positive.
    const priorities = Array.from(
      { length: n },
      () => Math.floor(random() * 5) - 2,
    );
    const hash = Math.floor(random() * (n + 1)) - 1; // -1 .. n-1
    const result = order(priorities, hash);
    const label = `${priorities} hash ${hash} -> ${result}`;
    // A permutation of 0..n-1.
    assertEquals(
      [...result].sort((a, b) => a - b),
      priorities.map((_, i) => i),
      label,
    );
    if (hash >= 0) assertEquals(result[0], hash, label);
    const rest = hash >= 0 ? result.slice(1) : result;
    for (let k = 1; k < rest.length; k++) {
      const [a, b] = [rest[k - 1]!, rest[k]!];
      assert(
        priorities[a]! > priorities[b]! ||
          (priorities[a] === priorities[b] && a < b),
        label,
      );
    }
    // Tactical (> 0) Moves before quiet ones.
    const firstQuiet = rest.findIndex((i) => priorities[i]! <= 0);
    if (firstQuiet >= 0) {
      assert(rest.slice(firstQuiet).every((i) => priorities[i]! <= 0), label);
    }
  }
});

const ordered = (
  priorities: readonly number[],
  killers: Killers,
  hashMove = -1,
  encoded: number[] = [],
) =>
  orderMoves(
    null,
    priorities.map((_, i) => i),
    hashMove,
    (_p, m: number) => priorities[m]!,
    [],
    killers,
    2,
    (m: number) => (encoded.push(m), `m${m}`),
  );

Deno.test("killers go after the tactical Moves, before the other quiet ones", () => {
  const k = new Killers();
  k.record(2, "m4");
  assertEquals(ordered([0, 3, 0, 1, 0, -1], k), [1, 3, 4, 0, 2, 5]);
  k.record(2, "m5"); // newer first
  assertEquals(ordered([0, 3, 0, 1, 0, -1], k), [1, 3, 5, 4, 0, 2]);
});

Deno.test("killers are per ply and without any, nothing changes", () => {
  const k = new Killers();
  k.record(1, "m4");
  assertEquals(ordered([0, 0, 0, 0, 0], k), [0, 1, 2, 3, 4]);
});

Deno.test("a killer that is the hash Move is skipped, an illegal one ignored", () => {
  const k = new Killers();
  k.record(2, "gone");
  k.record(2, "m3");
  assertEquals(ordered([0, 0, 0, 0, 0], k, 3), [3, 0, 1, 2, 4]);
  assertEquals(ordered([0, 0, 0, 0, 0], k), [3, 0, 1, 2, 4]);
  k.record(2, "m1");
  assertEquals(ordered([0, 0, 0, 0, 0], k, 1), [1, 3, 0, 2, 4]);
});

Deno.test("a killer that is tactical here keeps its priority place", () => {
  const k = new Killers();
  k.record(2, "m2");
  assertEquals(ordered([0, 5, 1, 0], k), [1, 2, 0, 3]);
});

Deno.test("Moves are encoded only until the killers are found", () => {
  const k = new Killers();
  k.record(2, "m1");
  const encoded: number[] = [];
  assertEquals(ordered([0, 0, 0, 0, 0], k, -1, encoded), [1, 0, 2, 3, 4]);
  assertEquals(encoded, [0, 1]);
});

Deno.test("Killers keeps the last two distinct Moves, newest first", () => {
  const k = new Killers();
  k.record(0, "a");
  k.record(0, "b");
  k.record(0, "b");
  assertEquals([k.newer(0), k.older(0)], ["b", "a"]);
  k.record(0, "a");
  assertEquals([k.newer(0), k.older(0)], ["a", "b"]);
  k.record(0, "c");
  assertEquals([k.newer(0), k.older(0)], ["c", "a"]);
  k.clear();
  assertEquals([k.newer(0), k.older(0)], [undefined, undefined]);
});

Deno.test("only the older killer is legal here: it is placed alone", () => {
  const k = new Killers();
  k.record(2, "m3");
  k.record(2, "gone"); // newer, not legal
  assertEquals(ordered([0, 0, 0, 0, 0], k), [3, 0, 1, 2, 4]);
});

Deno.test("random killers: tactical, then killers, then the other quiet Moves", () => {
  const random = seededRandom(84);
  for (let round = 0; round < 500; round++) {
    const n = Math.floor(random() * 12);
    const priorities = Array.from(
      { length: n },
      () => Math.floor(random() * 5) - 2,
    );
    const hash = Math.floor(random() * (n + 1)) - 1;
    const k = new Killers();
    // Keys "m<i>" (maybe legal, maybe tactical or the hash Move) or "gone".
    const pick = () =>
      random() < 0.25 ? "gone" : `m${Math.floor(random() * Math.max(n, 1))}`;
    k.record(2, pick());
    k.record(2, pick());
    const result = ordered(priorities, k, hash);
    const label = `${priorities} hash ${hash} ${k.newer(2)},${
      k.older(2)
    } -> ${result}`;
    assertEquals(
      [...result].sort((a, b) => a - b),
      priorities.map((_, i) => i),
      label,
    );
    // Reference: the same order without killers, killers moved to the front
    // of its quiet part.
    const base = order(priorities, hash);
    const rest = hash >= 0 ? base.slice(1) : base;
    const tactical = rest.filter((i) => priorities[i]! > 0);
    const quiet = rest.filter((i) => priorities[i]! <= 0);
    const killed = [k.newer(2), k.older(2)]
      .map((key) => quiet.find((i) => `m${i}` === key))
      .filter((i): i is number => i !== undefined);
    const expected = [
      ...(hash >= 0 ? [hash] : []),
      ...tactical,
      ...killed,
      ...quiet.filter((i) => !killed.includes(i)),
    ];
    assertEquals(result, expected, label);
  }
});

Deno.test("HistoryScores: scores grow by depth squared, per Seat, and fall for failures", () => {
  const h = new HistoryScores();
  assertEquals(h.score("a", "x"), 0);
  h.record("a", "x", 3);
  h.record("a", "x", 2);
  h.record("b", "x", 1);
  h.record("a", "y", 2, -1);
  assertEquals(
    [h.score("a", "x"), h.score("b", "x"), h.score("a", "y")],
    [13, 1, -4],
  );
  assertEquals(h.size, 3);
});

Deno.test("HistoryScores ages by halving and forgets scores that reach 0", () => {
  const h = new HistoryScores();
  h.record("a", "big", 4); // 16
  h.record("a", "small", 1); // 1
  h.record("b", "neg", 3, -1); // -9
  h.age();
  assertEquals([h.score("a", "big"), h.score("a", "small")], [8, 0]);
  assertEquals(h.score("b", "neg"), -4);
  assertEquals(h.size, 2);
  for (let i = 0; i < 5; i++) h.age();
  assertEquals(h.size, 0);
  h.record("a", "x", 1); // usable again after everything is forgotten
  assertEquals(h.score("a", "x"), 1);
});

Deno.test("HistoryScores keeps at most HISTORY_ENTRIES scores: aging makes room", () => {
  const h = new HistoryScores();
  for (let i = 0; i < HISTORY_ENTRIES; i++) h.record("a", i, 2); // 4 each
  assertEquals(h.size, HISTORY_ENTRIES);
  h.record("a", "new", 1); // full: everything halves (4 -> 2), still full
  assertEquals([h.size, h.score("a", 0), h.score("a", "new")], [
    HISTORY_ENTRIES,
    2,
    0,
  ]);
  h.record("a", 0, 1); // a Move that is kept still counts
  assertEquals(h.score("a", 0), 3);
  for (let i = 0; i < 2; i++) h.age(); // 3 -> 1 -> 0, the others 2 -> 1 -> 0
  h.record("a", "new", 1);
  assertEquals([h.size, h.score("a", "new")], [1, 1]);
});

Deno.test("HistoryScores stays within the cap however many Moves cause cutoffs", () => {
  const h = new HistoryScores();
  for (let i = 0; i < 3 * HISTORY_ENTRIES; i++) {
    h.record(i % 2 ? "a" : "b", i, 1 + (i % 7));
    assert(h.size <= HISTORY_ENTRIES);
  }
  assert(h.size > 0);
});

Deno.test("HistoryScores halves all scores before one passes the limit", () => {
  const h = new HistoryScores();
  h.record("a", "x", 4096); // 2^24: at the limit
  h.record("a", "y", 8);
  h.record("a", "x", 1); // would pass it: all halve first
  assertEquals([h.score("a", "x"), h.score("a", "y")], [2 ** 23 + 1, 32]);
});

const withHistory = (
  priorities: readonly number[],
  history: HistoryScores,
  seat = "a",
  killers?: Killers,
  hashMove = -1,
) =>
  orderMoves(
    null,
    priorities.map((_, i) => i),
    hashMove,
    (_p, m: number) => priorities[m]!,
    [],
    killers,
    0,
    (m: number) => `m${m}`,
    { history, seat, key: (m: number) => `m${m}` },
  );

Deno.test("history orders the quiet Moves, stably, below tactical Moves and killers", () => {
  const h = new HistoryScores();
  h.record("a", "m3", 2);
  h.record("a", "m2", 3);
  h.record("a", "m4", 1, -1);
  // 1 is tactical; quiet by history: 2 (9), 3 (4), then 0 and 5 (0), 4 (-1).
  assertEquals(withHistory([0, 1, 0, 0, 0, 0], h), [1, 2, 3, 0, 5, 4]);
  // Priority still dominates history among quiet Moves.
  assertEquals(withHistory([0, 0, -1, 0, 0, 0], h), [3, 0, 1, 5, 4, 2]);
  // Killers go first among the quiet Moves; the hash Move before everything.
  const k = new Killers();
  k.record(0, "m5");
  assertEquals(withHistory([0, 1, 0, 0, 0, 0], h, "a", k), [1, 5, 2, 3, 0, 4]);
  assertEquals(
    withHistory([0, 1, 0, 0, 0, 0], h, "a", k, 4),
    [4, 1, 5, 2, 3, 0],
  );
});

Deno.test("history scores are per Seat", () => {
  const h = new HistoryScores();
  h.record("a", "m2", 2);
  assertEquals(withHistory([0, 0, 0], h, "a"), [2, 0, 1]);
  assertEquals(withHistory([0, 0, 0], h, "b"), [0, 1, 2]);
});

Deno.test("random history, killers and hash Move: still a permutation", () => {
  const random = seededRandom(85);
  for (let round = 0; round < 500; round++) {
    const n = Math.floor(random() * 12);
    const priorities = Array.from(
      { length: n },
      () => Math.floor(random() * 5) - 2,
    );
    const hash = Math.floor(random() * (n + 1)) - 1;
    const some = () => `m${Math.floor(random() * Math.max(n, 1))}`;
    const h = new HistoryScores();
    for (let i = 0; i < 6; i++) {
      h.record("a", some(), 1 + (i % 3), random() < 0.3 ? -1 : 1);
    }
    const k = new Killers();
    k.record(0, some());
    k.record(0, some());
    const result = withHistory(priorities, h, "a", k, hash);
    const label = `${priorities} hash ${hash} -> ${result}`;
    assertEquals(
      [...result].sort((x, y) => x - y),
      priorities.map((_, i) => i),
      label,
    );
    if (hash >= 0) assertEquals(result[0], hash, label);
    // Tactical Moves precede quiet ones.
    const rest = hash >= 0 ? result.slice(1) : result;
    const firstQuiet = rest.findIndex((i) => priorities[i]! <= 0);
    if (firstQuiet >= 0) {
      assert(rest.slice(0, firstQuiet).every((i) => priorities[i]! > 0), label);
      assert(rest.slice(firstQuiet).every((i) => priorities[i]! <= 0), label);
    }
  }
});

Deno.test("a score that returns to 0 frees its slot of the cap", () => {
  const h = new HistoryScores();
  h.record("a", "x", 3);
  h.record("a", "x", 3, -1);
  assertEquals([h.size, h.score("a", "x")], [0, 0]);
  h.record("a", "y", 1, -1); // a new Move may start with a malus
  assertEquals([h.size, h.score("a", "y")], [1, -1]);
});
