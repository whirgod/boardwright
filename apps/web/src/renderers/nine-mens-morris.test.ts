import { assertEquals } from "@std/assert";
import { nineMensMorris, POINTS } from "@boardwright/game-nine-mens-morris";
import {
  nineMensMorrisRenderer as r,
  pointCenter,
} from "./nine-mens-morris.ts";

const decode = (text: string) => nineMensMorris.notation.decodePosition(text);
const board = (cells: Record<string, "w" | "b">) =>
  POINTS.map((p) => cells[p] ?? ".").join("");

Deno.test("scene: 24 targets, one per point, rank 7 on top", () => {
  const scene = r.scene(nineMensMorris.initialPosition());
  assertEquals(scene.targets.length, 24);
  assertEquals(scene.pieces.filter((p) => p.kind === "circle"), []);
  assertEquals(pointCenter("a7"), { x: 50, y: 50 });
  assertEquals(pointCenter("g1"), { x: 650, y: 650 });
  assertEquals(scene.board.filter((s) => s.className === "grid").length, 16);
});

Deno.test("scene: pieces and in-hand counts", () => {
  const pos = decode(`${board({ a1: "w", d1: "b" })}:w:8:8:0:`);
  const scene = r.scene(pos);
  assertEquals(
    scene.pieces.flatMap((p) => p.kind === "circle" ? [p.className] : []),
    ["disc disc-white", "disc disc-black"],
  );
  assertEquals(
    scene.pieces.flatMap((p) => p.kind === "text" ? [p.text] : []),
    ["White in hand: 8", "Black in hand: 8"],
  );
  assertEquals(scene.targets.find((t) => t.id === "a1")!.label, "a1: white");
  assertEquals(scene.targets.find((t) => t.id === "a4")!.label, "a4: empty");
});

Deno.test("moveTargets: placement, move and removal effect", () => {
  const pos = nineMensMorris.initialPosition();
  assertEquals(r.moveTargets({ to: "d1" }, pos), { path: ["d1"] });
  assertEquals(r.moveTargets({ from: "d1", to: "d2" }, pos), {
    path: ["d1", "d2"],
  });
  assertEquals(r.moveTargets({ from: "d1", to: "d2", remove: "g7" }, pos), {
    path: ["d1", "d2"],
    effects: ["g7"],
  });
});

Deno.test("input: a placement is one click", () => {
  const pos = nineMensMorris.initialPosition();
  const legal = nineMensMorris.legalMoves(pos);
  assertEquals(r.input(pos, legal, [], "d1"), {
    kind: "move",
    move: { to: "d1" },
  });
});

Deno.test("input: a mill placement needs the removal click", () => {
  // White has a1, d1 and places g1; black has a7 and d7 (free to remove).
  const pos = decode(
    `${board({ a1: "w", d1: "w", a7: "b", d7: "b" })}:w:7:7:0:`,
  );
  const legal = nineMensMorris.legalMoves(pos);
  assertEquals(r.input(pos, legal, [], "g1"), {
    kind: "select",
    selection: ["g1"],
  });
  assertEquals(r.input(pos, legal, ["g1"], "a7"), {
    kind: "move",
    move: { to: "g1", remove: "a7" },
  });
  // Removing one's own piece is not a legal Move.
  assertEquals(r.input(pos, legal, ["g1"], "a1"), { kind: "ignore" });
});

Deno.test("input: moving phase selects a piece, then its destination", () => {
  const pos = decode(
    `${
      board({ a1: "w", a7: "w", g1: "w", d7: "b", g7: "b", b2: "b" })
    }:w:0:0:0:` +
      `${board({ a1: "w", a7: "w", g1: "w", d7: "b", g7: "b", b2: "b" })}w`,
  );
  const legal = nineMensMorris.legalMoves(pos);
  // Three white pieces fly: any empty point is a destination.
  assertEquals(r.input(pos, legal, [], "a1"), {
    kind: "select",
    selection: ["a1"],
  });
  assertEquals(r.input(pos, legal, ["a1"], "d2"), {
    kind: "move",
    move: { from: "a1", to: "d2" },
  });
  assertEquals(r.input(pos, legal, [], "d7"), { kind: "ignore" });
  assertEquals(r.input(pos, legal, ["a1"], "a7"), {
    kind: "select",
    selection: ["a7"],
  });
});
