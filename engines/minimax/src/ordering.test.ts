import { assertEquals, assertThrows } from "@std/assert";
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
