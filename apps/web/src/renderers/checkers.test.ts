import { assertEquals } from "@std/assert";
import { checkers } from "@boardwright/game-checkers";
import { checkersRenderer as r, squareName } from "./checkers.ts";

const decode = (text: string) => checkers.notation.decodePosition(text);

Deno.test("squareName: standard numbering with white at the bottom", () => {
  assertEquals(
    [1, 4, 5, 29, 32].map(squareName),
    ["b8", "h8", "a7", "a1", "g1"],
  );
});

Deno.test("scene: 32 dark-square targets, 24 men at the start", () => {
  const scene = r.scene(checkers.initialPosition());
  assertEquals(scene.targets.length, 32);
  assertEquals(scene.pieces.length, 24);
  const t1 = scene.targets.find((t) => t.id === "1")!;
  assertEquals([t1.x, t1.y, t1.label], [100, 0, "b8 (1): black man"]);
  const t32 = scene.targets.find((t) => t.id === "32")!;
  assertEquals([t32.x, t32.y], [600, 700]);
});

Deno.test("scene: a king gets a mark and a label", () => {
  const scene = r.scene(decode("B:WK30:B1"));
  assertEquals(
    scene.pieces.flatMap((p) => p.kind === "circle" ? [p.className] : []),
    ["disc disc-black", "disc disc-white", "king-mark"],
  );
  assertEquals(
    scene.targets.find((t) => t.id === "30")!.label,
    "c1 (30): white king",
  );
});

Deno.test("moveTargets: the path is every visited square", () => {
  const pos = checkers.initialPosition();
  assertEquals(r.moveTargets([22, 15, 8], pos), { path: ["22", "15", "8"] });
});

Deno.test("input: a step is piece then destination", () => {
  const pos = checkers.initialPosition();
  const legal = checkers.legalMoves(pos);
  assertEquals(r.input(pos, legal, [], "9"), {
    kind: "select",
    selection: ["9"],
  });
  assertEquals(r.input(pos, legal, ["9"], "13"), {
    kind: "move",
    move: [9, 13],
  });
  assertEquals(r.input(pos, legal, ["9"], "14"), {
    kind: "move",
    move: [9, 14],
  });
});

Deno.test("input: a multi-jump is one Move composed square by square", () => {
  const pos = decode("B:W6,14:B1");
  const legal = checkers.legalMoves(pos);
  assertEquals(legal, [[1, 10, 17]]);
  assertEquals(r.input(pos, legal, [], "1"), {
    kind: "select",
    selection: ["1"],
  });
  // Stopping after the first jump is not a Move: it keeps selecting.
  assertEquals(r.input(pos, legal, ["1"], "10"), {
    kind: "select",
    selection: ["1", "10"],
  });
  assertEquals(r.input(pos, legal, ["1", "10"], "17"), {
    kind: "move",
    move: [1, 10, 17],
  });
});

Deno.test("input: mandatory captures hide steps", () => {
  const pos = decode("B:W6:B1,4");
  const legal = checkers.legalMoves(pos);
  assertEquals(r.input(pos, legal, [], "4"), { kind: "ignore" });
});
