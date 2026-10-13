import { assertEquals, assertThrows } from "@std/assert";
import type { GameRules } from "@boardwright/core";
import type { BoardRenderer } from "./board.ts";
import { bindRenderer, type BoardRequest, gameView } from "./mod.ts";

// A tiny two-step Game: Moves "from-to" between points a, b, c. Positions are
// the Move list joined with "|", so tests can see what the renderer received.
const MOVES = ["a-b", "a-c", "b-c"];
const slide: GameRules<string[], { from: string; to: string }> = {
  id: "slide",
  name: "Slide",
  seats: ["first", "second"],
  initialPosition: () => [],
  toMove: (p) => (p.length % 2 === 0 ? "first" : "second"),
  legalMoves: () => MOVES.map((m) => ({ from: m[0]!, to: m[2]! })),
  play: (p, m) => [...p, `${m.from}-${m.to}`],
  outcome: () => undefined,
  notation: {
    encodePosition: (p) => p.join("|"),
    decodePosition: (text) => {
      if (text === "bad") throw new Error("bad position");
      return text === "" ? [] : text.split("|");
    },
    encodeMove: (m) => `${m.from}-${m.to}`,
    decodeMove: (text) => {
      if (!MOVES.includes(text)) throw new Error(`bad move ${text}`);
      return { from: text[0]!, to: text[2]! };
    },
  },
};

const seen: string[][] = [];
const slideRenderer: BoardRenderer<string[], { from: string; to: string }> = {
  scene(position) {
    seen.push(position);
    return {
      width: 30,
      height: 10,
      board: [],
      pieces: [],
      targets: ["a", "b", "c"].map((id, i) => ({
        id,
        label: id,
        x: i * 10,
        y: 0,
        width: 10,
        height: 10,
      })),
    };
  },
  moveTargets: (m) => [m.from, m.to],
  input(_position, legal, selection, target) {
    if (selection.length === 0) {
      return legal.some((m) => m.from === target)
        ? { kind: "select", selection: [target] }
        : { kind: "ignore" };
    }
    const move = legal.find((m) => m.from === selection[0] && m.to === target);
    return move ? { kind: "move", move } : { kind: "select", selection: [] };
  },
};

const view = bindRenderer(slide, slideRenderer);
const request = (over: Partial<BoardRequest> = {}): BoardRequest => ({
  position: "a-b",
  moves: [],
  legalMoves: MOVES,
  selection: [],
  ...over,
});

Deno.test("gameView: tic-tac-toe has a board; unknown Games have none", () => {
  assertEquals(gameView("tic-tac-toe")?.gameId, "tic-tac-toe");
  assertEquals(gameView("chess"), undefined);
});

Deno.test("board: the renderer receives the Position decoded with the Game's Notation", () => {
  seen.length = 0;
  const model = view.board(request({ position: "a-b|b-c" }));
  assertEquals(seen, [["a-b", "b-c"]]);
  assertEquals(model.highlights, []);
  assertEquals(model.arrows, []);
  assertEquals(model.scene.targets.length, 3);
});

Deno.test("board: undecodable Positions throw", () => {
  assertThrows(() => view.board(request({ position: "bad" })), Error, "bad");
});

Deno.test("board: highlights the last Move, found by replaying the Move list", () => {
  const model = view.board(request({ moves: ["a-c", "b-c"] }));
  assertEquals(model.highlights, [
    { target: "b", kind: "last-move" },
    { target: "c", kind: "last-move" },
  ]);
});

Deno.test("board: a Move list that does not replay highlights nothing", () => {
  const model = view.board(request({ moves: ["zz", "a-b"] }));
  assertEquals(model.highlights, []);
});

Deno.test("board: a selection highlights itself and the legal destinations", () => {
  const model = view.board(request({ selection: ["a"] }));
  assertEquals(model.highlights, [
    { target: "a", kind: "selected" },
    { target: "b", kind: "destination" },
    { target: "c", kind: "destination" },
  ]);
  // A complete selection has no further destinations.
  assertEquals(
    view.board(request({ selection: ["a", "b"] })).highlights.filter((h) =>
      h.kind === "destination"
    ),
    [],
  );
});

Deno.test("board: arrows run from a Move's first to its last target", () => {
  const model = view.board(request({ arrows: ["a-c", "b-c"] }));
  assertEquals(model.arrows, [
    { from: "a", to: "c", kind: "line" },
    { from: "b", to: "c", kind: "line" },
  ]);
});

Deno.test("board: tic-tac-toe placements become single-target arrows", () => {
  const ttt = gameView("tic-tac-toe")!;
  const model = ttt.board({
    position: "x........:o",
    moves: ["a1"],
    legalMoves: [],
    selection: [],
    arrows: ["b2"],
  });
  assertEquals(model.arrows, [{ from: "b2", to: "b2", kind: "line" }]);
  assertEquals(model.highlights, [{ target: "a1", kind: "last-move" }]);
});

Deno.test("click: selections pass through, Moves come back in Notation", () => {
  assertEquals(view.click(request(), "a"), {
    kind: "select",
    selection: ["a"],
  });
  assertEquals(view.click(request(), "c"), { kind: "ignore" });
  assertEquals(view.click(request({ selection: ["a"] }), "c"), {
    kind: "move",
    move: "a-c",
  });
  assertEquals(view.click(request({ selection: ["b"] }), "a"), {
    kind: "select",
    selection: [],
  });
});

Deno.test("click: tic-tac-toe plays the clicked cell when it is legal", () => {
  const ttt = gameView("tic-tac-toe")!;
  const req = {
    position: "x........:o",
    moves: ["a1"],
    legalMoves: ["b1", "c1", "a2", "b2", "c2", "a3", "b3", "c3"],
    selection: [],
  };
  assertEquals(ttt.click(req, "b2"), { kind: "move", move: "b2" });
  assertEquals(ttt.click(req, "a1"), { kind: "ignore" });
  assertEquals(ttt.click({ ...req, legalMoves: [] }, "b2"), {
    kind: "ignore",
  });
});
