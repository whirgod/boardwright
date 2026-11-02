import { assert, assertEquals, assertThrows } from "@std/assert";
import { seededRandom } from "@boardwright/testing";
import { orderMoves } from "./ordering.ts";

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
