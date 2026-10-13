import { assertEquals, assertMatch } from "@std/assert";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import type { MoveListEntry } from "./api.ts";
import {
  describePly,
  keyAction,
  navigate,
  replay,
  replayMoveList,
  type ReviewPly,
  shownPly,
} from "./review.ts";

const mv = (move: string): MoveListEntry => ({ kind: "move", move });
const roll = (chance: string): MoveListEntry => ({ kind: "chance", chance });

Deno.test("replay: one step per Move list entry, with the Seat to move", () => {
  const { steps, error } = replayMoveList(ticTacToe, [mv("a1"), mv("b2")]);
  assertEquals(error, undefined);
  assertEquals(steps, [
    { position: ".........:x", toMove: "x" },
    { position: "x........:o", toMove: "o" },
    { position: "x...o....:x", toMove: "x" },
  ]);
});

Deno.test("replay: stops at an entry that does not apply, keeping earlier steps", () => {
  const result = replayMoveList(ticTacToe, [mv("a1"), mv("a1"), mv("b2")]);
  assertEquals(result.steps.length, 2);
  assertMatch(result.error!, /entry 2 \(a1\)/);
  const chance = replayMoveList(ticTacToe, [roll("6")]);
  assertEquals(chance.steps.length, 1);
  assertMatch(chance.error!, /no Chance events/);
});

Deno.test("replay: Games with chance resolve their Chance events", () => {
  const result = replay("backgammon", [roll("3-1"), mv("8/5 6/5")])!;
  assertEquals(result.error, undefined);
  assertEquals(result.steps.map((s) => s.toMove), [
    undefined, // the opening roll is pending: no Seat to move
    "white",
    undefined, // black's roll is pending
  ]);
  assertMatch(result.steps[1]!.position, / white 31$/);
});

Deno.test("replay: every hosted Game is known; others are not", () => {
  for (
    const id of [
      "tic-tac-toe",
      "nine-mens-morris",
      "checkers",
      "chess",
      "backgammon",
    ]
  ) {
    assertEquals(replay(id, [])?.steps.length, 1, id);
  }
  assertEquals(replay("go", []), undefined);
});

Deno.test("shownPly: live follows the Move list; fixed plies are clamped", () => {
  assertEquals(shownPly("live", 5), 5);
  assertEquals(shownPly(2, 5), 2);
  assertEquals(shownPly(9, 5), 5);
  assertEquals(shownPly(-1, 5), 0);
});

Deno.test("navigate: steps and jumps stay in range; the last ply is live", () => {
  const go = (
    review: ReviewPly,
    kind: "first" | "previous" | "next" | "last",
  ) => navigate(review, { kind }, 4);
  assertEquals(go("live", "previous"), 3);
  assertEquals(go(3, "next"), "live");
  assertEquals(go(0, "previous"), 0);
  assertEquals(go("live", "next"), "live");
  assertEquals(go(2, "first"), 0);
  assertEquals(go(0, "last"), "live");
  assertEquals(navigate(1, { kind: "go", ply: 2 }, 4), 2);
  assertEquals(navigate(1, { kind: "go", ply: 4 }, 4), "live");
  assertEquals(navigate(1, { kind: "go", ply: 99 }, 4), "live");
  assertEquals(navigate(1, { kind: "go", ply: -3 }, 4), 0);
  // An empty Move list has only the initial Position.
  assertEquals(navigate("live", { kind: "previous" }, 0), "live");
});

Deno.test("navigate: a fixed ply stays put while the Match goes on", () => {
  let review: ReviewPly = navigate("live", { kind: "previous" }, 3); // ply 2
  assertEquals(shownPly(review, 4), 2);
  review = navigate(review, { kind: "next" }, 4);
  assertEquals(review, 3);
});

Deno.test("describePly: names the shown Position", () => {
  const entries = [roll("3-1"), mv("8/5 6/5")];
  assertEquals(describePly(entries, 0), "Initial Position (0 of 2)");
  assertEquals(
    describePly(entries, 1),
    "After the Chance event 3-1 (1 of 2)",
  );
  assertEquals(describePly(entries, 2), "After 8/5 6/5 (2 of 2)");
  assertEquals(describePly([], 0), "Initial Position (0 of 0)");
});

Deno.test("keyAction: arrows step, Home/End jump", () => {
  assertEquals(keyAction({ key: "ArrowLeft" }), { kind: "previous" });
  assertEquals(keyAction({ key: "ArrowRight" }), { kind: "next" });
  assertEquals(keyAction({ key: "Home" }), { kind: "first" });
  assertEquals(keyAction({ key: "End", targetTag: "BUTTON" }), {
    kind: "last",
  });
  assertEquals(keyAction({ key: "a" }), undefined);
});

Deno.test("keyAction: ignores modified keys and keys typed into form fields", () => {
  assertEquals(keyAction({ key: "ArrowLeft", altKey: true }), undefined);
  assertEquals(keyAction({ key: "ArrowLeft", ctrlKey: true }), undefined);
  assertEquals(keyAction({ key: "ArrowLeft", metaKey: true }), undefined);
  assertEquals(keyAction({ key: "ArrowLeft", shiftKey: true }), undefined);
  for (const targetTag of ["INPUT", "SELECT", "TEXTAREA"]) {
    assertEquals(keyAction({ key: "ArrowRight", targetTag }), undefined);
  }
});
