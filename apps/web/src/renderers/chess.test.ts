import { assertEquals } from "@std/assert";
import { chess } from "@boardwright/game-chess";
import { chessRenderer as r } from "./chess.ts";
import { bindRenderer } from "./mod.ts";

const decode = (fen: string) => chess.notation.decodePosition(fen);
const uci = chess.notation.encodeMove;

Deno.test("scene: 64 squares plus 4 picker targets, 32 pieces at the start", () => {
  const scene = r.scene(chess.initialPosition());
  assertEquals(scene.targets.length, 68);
  // 32 pieces and the 4 picker pieces.
  assertEquals(scene.pieces.length, 36);
  assertEquals(scene.height, 900);
  const a1 = scene.targets.find((t) => t.id === "a1")!;
  assertEquals([a1.x, a1.y, a1.label], [0, 700, "a1: white rook"]);
  const e8 = scene.targets.find((t) => t.id === "e8")!;
  assertEquals([e8.x, e8.y, e8.label], [400, 0, "e8: black king"]);
  assertEquals(scene.targets.find((t) => t.id === "e4")!.label, "e4: empty");
});

Deno.test("scene: the picker shows the pieces of the Seat to move", () => {
  const classes = (fen: string) =>
    r.scene(decode(fen)).pieces.slice(-4)
      .map((p) => p.kind === "text" && p.className);
  assertEquals(
    classes("4k3/8/8/8/8/8/8/4K3 w - - 0 1"),
    Array(4).fill("glyph glyph-white"),
  );
  assertEquals(
    classes("4k3/8/8/8/8/8/8/4K3 b - - 0 1"),
    Array(4).fill("glyph glyph-black"),
  );
});

Deno.test("moveTargets: from and to; promotion adds the picker as an effect", () => {
  const pos = decode("r3k2r/1P4P1/8/8/8/8/8/R3K2R w KQkq - 0 1");
  assertEquals(r.moveTargets({ from: 12, to: 28 }, pos), {
    path: ["e2", "e4"],
  });
  assertEquals(r.moveTargets({ from: 49, to: 57, promotion: "n" }, pos), {
    path: ["b7", "b8"],
    effects: ["=n"],
  });
});

Deno.test("input: a Move is piece then destination", () => {
  const pos = chess.initialPosition();
  const legal = chess.legalMoves(pos);
  assertEquals(r.input(pos, legal, [], "e2"), {
    kind: "select",
    selection: ["e2"],
  });
  assertEquals(r.input(pos, legal, ["e2"], "e4"), {
    kind: "move",
    move: { from: 12, to: 28 },
  });
  // Stray and empty clicks do nothing; the picker is inert without a promotion.
  assertEquals(r.input(pos, legal, [], "e4"), { kind: "ignore" });
  assertEquals(r.input(pos, legal, [], "=q"), { kind: "ignore" });
  assertEquals(r.input(pos, legal, ["e2"], "=q"), {
    kind: "select",
    selection: ["e2"],
  });
});

Deno.test("input: castling is the king moving two squares", () => {
  const pos = decode("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  const legal = chess.legalMoves(pos);
  assertEquals(r.input(pos, legal, ["e1"], "g1"), {
    kind: "move",
    move: { from: 4, to: 6 },
  });
  assertEquals(r.input(pos, legal, ["e1"], "c1"), {
    kind: "move",
    move: { from: 4, to: 2 },
  });
  // Clicking the rook's square is not castling; it re-picks the rook.
  assertEquals(r.input(pos, legal, ["e1"], "h1"), {
    kind: "select",
    selection: ["h1"],
  });
});

Deno.test("input: promotion needs a click on the picker", () => {
  const pos = decode("4k3/1P6/8/8/8/8/8/4K3 w - - 0 1");
  const legal = chess.legalMoves(pos);
  assertEquals(r.input(pos, legal, ["b7"], "b8"), {
    kind: "select",
    selection: ["b7", "b8"],
  });
  for (const piece of ["q", "r", "b", "n"] as const) {
    assertEquals(r.input(pos, legal, ["b7", "b8"], `=${piece}`), {
      kind: "move",
      move: { from: 49, to: 57, promotion: piece },
    });
  }
  // Clicking the destination again takes it back.
  assertEquals(r.input(pos, legal, ["b7", "b8"], "b8"), {
    kind: "select",
    selection: ["b7"],
  });
});

Deno.test("view: destinations highlight the picker once a promotion is selected", () => {
  const view = bindRenderer(chess, r);
  const pos = decode("4k3/1P6/8/8/8/8/8/4K3 w - - 0 1");
  const request = (selection: string[]) => ({
    position: chess.notation.encodePosition(pos),
    entries: [],
    legalMoves: chess.legalMoves(pos).map(uci),
    selection,
  });
  const destinations = (selection: string[]) =>
    view.board(request(selection)).highlights
      .filter((h) => h.kind === "destination").map((h) => h.target).sort();
  assertEquals(destinations(["b7"]), ["b8"]);
  assertEquals(destinations(["b7", "b8"]), ["=b", "=n", "=q", "=r"]);
  // The Move text the UI sends is UCI with the promotion letter.
  assertEquals(view.click(request(["b7", "b8"]), "=q"), {
    kind: "move",
    move: "b7b8q",
  });
});

Deno.test("view: the last Move highlights its squares", () => {
  const view = bindRenderer(chess, r);
  const after = chess.play(chess.initialPosition(), { from: 12, to: 28 });
  const { highlights } = view.board({
    position: chess.notation.encodePosition(after),
    entries: [{ kind: "move", move: "e2e4" }],
    legalMoves: [],
    selection: [],
  });
  assertEquals(
    highlights.filter((h) => h.kind === "last-move").map((h) => h.target),
    ["e2", "e4"],
  );
});
