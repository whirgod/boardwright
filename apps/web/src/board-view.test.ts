import { assertEquals } from "@std/assert";
import { boardClass, targetLabel, targetStates } from "./board-view.ts";
import type { BoardScene } from "./renderers/mod.ts";

const scene = (width: number, height: number): BoardScene => ({
  width,
  height,
  board: [],
  pieces: [],
  targets: [],
});

Deno.test("targetStates: kinds per target, in speaking order, without repeats", () => {
  const states = targetStates([
    { target: "a", kind: "last-move" },
    { target: "a", kind: "selected" },
    { target: "a", kind: "last-move" },
    { target: "b", kind: "destination" },
  ]);
  assertEquals(states.get("a"), ["selected", "last-move"]);
  assertEquals(states.get("b"), ["destination"]);
  assertEquals(states.get("c"), undefined);
});

Deno.test("targetLabel: appends what is highlighted", () => {
  assertEquals(targetLabel("e4: pawn", undefined), "e4: pawn");
  assertEquals(targetLabel("e4: pawn", []), "e4: pawn");
  assertEquals(
    targetLabel("e4: pawn", ["selected"]),
    "e4: pawn (selected)",
  );
  assertEquals(
    targetLabel("e4: empty", ["destination", "last-move-effect"]),
    "e4: empty (possible destination, touched by the last Move)",
  );
});

Deno.test("boardClass: interactive and wide boards", () => {
  assertEquals(boardClass(scene(800, 800), false), "board");
  assertEquals(boardClass(scene(800, 800), true), "board interactive");
  assertEquals(boardClass(scene(886, 600), true), "board interactive wide");
});
