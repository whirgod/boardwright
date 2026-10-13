import { assertEquals } from "@std/assert";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import { ticTacToeRenderer } from "./tic-tac-toe.ts";

const decode = (text: string) => ticTacToe.notation.decodePosition(text);

Deno.test("scene: a 300x300 board with one target per cell, rank 3 on top", () => {
  const scene = ticTacToeRenderer.scene(ticTacToe.initialPosition());
  assertEquals([scene.width, scene.height], [300, 300]);
  assertEquals(scene.targets.map((t) => t.id), [
    "a1",
    "b1",
    "c1",
    "a2",
    "b2",
    "c2",
    "a3",
    "b3",
    "c3",
  ]);
  const at = (id: string) => scene.targets.find((t) => t.id === id)!;
  assertEquals([at("a3").x, at("a3").y], [0, 0]);
  assertEquals([at("a1").x, at("a1").y], [0, 200]);
  assertEquals([at("c1").x, at("c1").y, at("c1").width], [200, 200, 100]);
  // Board and grid (2 + 2 lines) only.
  assertEquals(scene.pieces, []);
  assertEquals(scene.board.map((s) => s.className), [
    "board",
    "grid",
    "grid",
    "grid",
    "grid",
  ]);
});

Deno.test("scene: draws X as two lines and O as a circle, labelled per cell", () => {
  const scene = ticTacToeRenderer.scene(decode("x...o....:x"));
  const { pieces } = scene;
  assertEquals(pieces.map((p) => [p.kind, p.className]), [
    ["line", "piece piece-x"],
    ["line", "piece piece-x"],
    ["circle", "piece piece-o"],
  ]);
  const o = pieces[2]!;
  assertEquals(
    o.kind === "circle" ? o.center : undefined,
    { x: 150, y: 150 },
  );
  const labels = scene.targets.map((t) => t.label);
  assertEquals(labels[0], "a1: x");
  assertEquals(labels[4], "b2: o");
  assertEquals(labels[8], "c3: empty");
});

Deno.test("input: a click on a legal cell is that Move; others are ignored", () => {
  const position = decode("x........:o");
  const legal = ticTacToe.legalMoves(position);
  assertEquals(ticTacToeRenderer.input(position, legal, [], "b2"), {
    kind: "move",
    move: "b2",
  });
  assertEquals(ticTacToeRenderer.input(position, legal, [], "a1"), {
    kind: "ignore",
  });
  assertEquals(ticTacToeRenderer.input(position, [], [], "b2"), {
    kind: "ignore",
  });
});

Deno.test("moveTargets: a placement touches its cell", () => {
  assertEquals(
    ticTacToeRenderer.moveTargets("c3", ticTacToe.initialPosition()),
    ["c3"],
  );
});
