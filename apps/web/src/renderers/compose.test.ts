import { assertEquals } from "@std/assert";
import { composeMove } from "./compose.ts";

const clicksOf = (m: string) => m.split(",");

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
  assertEquals(composeMove(clicksOf, ["a,b"], ["a"], "z"), { kind: "ignore" });
  assertEquals(composeMove(clicksOf, [], [], "a"), { kind: "ignore" });
});
