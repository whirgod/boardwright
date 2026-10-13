import { assertEquals } from "@std/assert";
import { clickOrder, composeMove } from "./compose.ts";

const clicksOf = (m: string) => ({ path: m.split(",") });

Deno.test("composeMove: completes a Move when its last target is clicked", () => {
  assertEquals(composeMove(clicksOf, ["a,b", "a,c"], ["a"], "b"), {
    kind: "move",
    move: "a,b",
  });
});

Deno.test("composeMove: a first click that is a prefix selects", () => {
  assertEquals(composeMove(clicksOf, ["a,b", "a,c"], [], "a"), {
    kind: "select",
    selection: ["a"],
  });
});

Deno.test("composeMove: a Move that a longer Move continues is not completed early", () => {
  assertEquals(composeMove(clicksOf, ["a,b", "a,b,c"], ["a"], "b"), {
    kind: "select",
    selection: ["a", "b"],
  });
  assertEquals(composeMove(clicksOf, ["a,b", "a,b,c"], ["a", "b"], "c"), {
    kind: "move",
    move: "a,b,c",
  });
});

Deno.test("composeMove: re-picking another start restarts; junk is ignored", () => {
  assertEquals(composeMove(clicksOf, ["a,b", "x,y"], ["a"], "x"), {
    kind: "select",
    selection: ["x"],
  });
  assertEquals(composeMove(clicksOf, [], [], "a"), { kind: "ignore" });
});

Deno.test("composeMove: re-clicking the last selected target deselects it", () => {
  assertEquals(composeMove(clicksOf, ["a,b"], ["a"], "a"), {
    kind: "select",
    selection: [],
  });
  assertEquals(composeMove(clicksOf, ["a,b,c"], ["a", "b"], "b"), {
    kind: "select",
    selection: ["a"],
  });
});

Deno.test("composeMove: a stray click keeps a partial selection", () => {
  assertEquals(composeMove(clicksOf, ["a,b,c"], ["a", "b"], "z"), {
    kind: "select",
    selection: ["a", "b"],
  });
  assertEquals(composeMove(clicksOf, ["a,b"], [], "z"), { kind: "ignore" });
});

Deno.test("clickOrder: path then effects", () => {
  assertEquals(clickOrder({ path: ["a", "b"], effects: ["x"] }), [
    "a",
    "b",
    "x",
  ]);
  assertEquals(clickOrder({ path: ["a"] }), ["a"]);
});
