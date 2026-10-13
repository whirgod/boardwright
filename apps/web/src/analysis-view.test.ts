import { assertEquals } from "@std/assert";
import type { Analysis } from "@boardwright/core";
import {
  describeScore,
  formatScore,
  overlay,
  summarize,
} from "./analysis-view.ts";

const ANALYSIS: Analysis<string> = {
  depth: 4,
  lines: [
    { moves: ["e2e4", "e7e5"], score: { kind: "value", value: 35 } },
    { moves: ["d2d4"], score: { kind: "value", value: -12.5 } },
    { moves: ["g1f3", "b8c6"], score: { kind: "win-in", plies: 3 } },
  ],
};

Deno.test("formatScore: values signed, forced results in Plies", () => {
  assertEquals(formatScore({ kind: "value", value: 35 }), "+35");
  assertEquals(formatScore({ kind: "value", value: -0.5 }), "-0.50");
  assertEquals(formatScore({ kind: "value", value: 0.125 }), "+0.13");
  assertEquals(formatScore({ kind: "value", value: 0 }), "0");
  assertEquals(formatScore({ kind: "win-in", plies: 3 }), "Win in 3");
  assertEquals(formatScore({ kind: "loss-in", plies: 2 }), "Loss in 2");
});

Deno.test("describeScore: names the Seat whose perspective the Score takes", () => {
  assertEquals(
    describeScore({ kind: "value", value: 35 }, "white"),
    "White: +35",
  );
  assertEquals(
    describeScore({ kind: "win-in", plies: 1 }, "x"),
    "X wins in 1 Ply",
  );
  assertEquals(
    describeScore({ kind: "loss-in", plies: 4 }, "black"),
    "Black loses in 4 Plies",
  );
  assertEquals(describeScore({ kind: "value", value: -2 }, undefined), "-2");
  assertEquals(
    describeScore({ kind: "win-in", plies: 2 }, undefined),
    "The Seat to move wins in 2 Plies",
  );
  assertEquals(
    describeScore({ kind: "loss-in", plies: 2 }, undefined),
    "The Seat to move loses in 2 Plies",
  );
});

Deno.test("summarize: the best Line's Score heads the Lines", () => {
  const summary = summarize(ANALYSIS, "white");
  assertEquals(summary.depth, 4);
  assertEquals(summary.expected, false);
  assertEquals(summary.score, { text: "+35", description: "White: +35" });
  assertEquals(summary.lines.map((l) => [l.rank, l.score, l.moves]), [
    [0, "+35", ["e2e4", "e7e5"]],
    [1, "-12.50", ["d2d4"]],
    [2, "Win in 3", ["g1f3", "b8c6"]],
  ]);
  assertEquals(summary.lines[2]!.description, "White wins in 3 Plies");
});

Deno.test("summarize: a pending Chance event shows the expected Score from its seat", () => {
  const summary = summarize({
    depth: 2,
    lines: [],
    score: { kind: "value", value: 0.25 },
    seat: "black",
  }, undefined);
  assertEquals(summary.expected, true);
  assertEquals(summary.lines, []);
  assertEquals(summary.score, {
    text: "+0.25",
    description: "Expected: Black: +0.25",
  });
  const forced = summarize({
    depth: 1,
    lines: [],
    score: { kind: "loss-in", plies: 2 },
    seat: "white",
  }, undefined);
  assertEquals(forced.score?.description, "Expected: White loses in 2 Plies");
});

Deno.test("summarize: an end of the Match has no Score and no Lines", () => {
  assertEquals(summarize({ depth: 0, lines: [] }, undefined), {
    depth: 0,
    expected: false,
    lines: [],
  });
});

Deno.test("overlay: arrows for the first Move of each Line, best first", () => {
  assertEquals(overlay(ANALYSIS), { arrows: ["e2e4", "d2d4", "g1f3"] });
  assertEquals(overlay(undefined), { arrows: [] });
  assertEquals(overlay({ depth: 0, lines: [] }), { arrows: [] });
  // A Line without Moves keeps its rank, so the best Line stays index 0.
  assertEquals(
    overlay({
      depth: 1,
      lines: [
        { moves: [], score: { kind: "value", value: 1 } },
        { moves: ["d2d4"], score: { kind: "value", value: 0 } },
      ],
    }).arrows,
    [null, "d2d4"],
  );
});

Deno.test("overlay: a previewed Line replaces the arrows with its Moves", () => {
  assertEquals(overlay(ANALYSIS, 2), {
    arrows: [],
    preview: ["g1f3", "b8c6"],
  });
  // A Line that no longer exists (a shallower Analysis) previews nothing.
  assertEquals(overlay(ANALYSIS, 7), { arrows: ["e2e4", "d2d4", "g1f3"] });
});
