import { assertEquals, assertThrows } from "@std/assert";
import type { GameRules } from "@boardwright/core";
import type { BoardRenderer, MoveTargets } from "./board.ts";
import { bindRenderer, type BoardRequest, gameView } from "./mod.ts";

// A tiny Game with multi-click Moves: "from-to" between points a, b, c, and a
// compound Move "b-a+c" that also removes the piece on c (like a mill in nine
// men's morris). Positions are the Move list joined with "|", so tests can see
// what the renderer received.
const MOVES = ["a-b", "a-c", "b-c", "b-a+c"];
interface SlideMove {
  from: string;
  to: string;
  take?: string;
}
const slide: GameRules<string[], SlideMove> = {
  id: "slide",
  name: "Slide",
  seats: ["first", "second"],
  initialPosition: () => [],
  toMove: (p) => (p.length % 2 === 0 ? "first" : "second"),
  legalMoves: () => MOVES.map((m) => slide.notation.decodeMove(m, [])),
  play: (p, m) => [...p, slide.notation.encodeMove(m)],
  outcome: () => undefined,
  notation: {
    encodePosition: (p) => p.join("|"),
    decodePosition: (text) => {
      if (text === "bad") throw new Error("bad position");
      return text === "" ? [] : text.split("|");
    },
    encodeMove: (m) => `${m.from}-${m.to}${m.take ? `+${m.take}` : ""}`,
    decodeMove: (text) => {
      if (!MOVES.includes(text)) throw new Error(`bad move ${text}`);
      return text[4]
        ? { from: text[0]!, to: text[2]!, take: text[4] }
        : { from: text[0]!, to: text[2]! };
    },
  },
};

const targetsOf = (m: SlideMove): MoveTargets =>
  m.take
    ? { path: [m.from, m.to], effects: [m.take] }
    : { path: [m.from, m.to] };
const clicksOf = (m: SlideMove) => {
  const { path, effects = [] } = targetsOf(m);
  return [...path, ...effects];
};

const seen: string[][] = [];
const slideRenderer: BoardRenderer<string[], SlideMove> = {
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
  moveTargets: targetsOf,
  input(_position, legal, selection, target) {
    const picked = [...selection, target];
    const starts = (m: SlideMove) =>
      picked.every((t, i) => clicksOf(m)[i] === t);
    const move = legal.find((m) =>
      starts(m) && clicksOf(m).length === picked.length
    );
    if (move) return { kind: "move", move };
    if (legal.some(starts)) return { kind: "select", selection: picked };
    return selection.length > 0
      ? { kind: "select", selection: [] }
      : { kind: "ignore" };
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
  assertEquals(gameView("chess")?.gameId, "chess");
  assertEquals(gameView("go"), undefined);
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
    { from: "a", to: "c", kind: "line", index: 0 },
    { from: "b", to: "c", kind: "line", index: 1 },
  ]);
});

Deno.test("board: a previewed Line is drawn Move by Move from the Positions it reaches", () => {
  seen.length = 0;
  const model = view.board(request({ preview: ["b-c", "b-a+c"] }));
  // Each Move decodes in the Position the earlier ones lead to.
  assertEquals(model.arrows, [
    { from: "b", to: "c", kind: "preview", index: 0 },
    { from: "b", to: "a", kind: "preview", index: 1 },
  ]);
  // Line arrows and the preview can be drawn together.
  assertEquals(
    view.board(request({ arrows: ["a-c"], preview: ["b-c"] })).arrows,
    [
      { from: "a", to: "c", kind: "line", index: 0 },
      { from: "b", to: "c", kind: "preview", index: 0 },
    ],
  );
});

Deno.test("board: a preview stops at the first Move that does not decode", () => {
  const model = view.board(request({ preview: ["a-b", "zz", "b-c"] }));
  assertEquals(model.arrows, [
    { from: "a", to: "b", kind: "preview", index: 0 },
  ]);
});

Deno.test("board: chess previews decode each Move in its own Position", () => {
  const board = gameView("chess")!.board({
    position: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    moves: [],
    legalMoves: [],
    selection: [],
    preview: ["e2e4", "e7e5", "g1f3"],
  });
  assertEquals(board.arrows.map((a) => [a.from, a.to, a.index]), [
    ["e2", "e4", 0],
    ["e7", "e5", 1],
    ["g1", "f3", 2],
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
  assertEquals(model.arrows, [{
    from: "b2",
    to: "b2",
    kind: "line",
    index: 0,
  }]);
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
  assertEquals(view.click(request({ selection: ["a"] }), "a"), {
    kind: "select",
    selection: [],
  });
});

Deno.test("compound Move: path drives arrows and highlights, effects are clicked last", () => {
  // Composing b-a+c: b, a, then the piece to remove.
  assertEquals(view.click(request({ selection: ["b"] }), "a"), {
    kind: "select",
    selection: ["b", "a"],
  });
  assertEquals(
    view.board(request({ selection: ["b", "a"] })).highlights,
    [
      { target: "b", kind: "selected" },
      { target: "a", kind: "selected" },
      { target: "c", kind: "destination" },
    ],
  );
  assertEquals(view.click(request({ selection: ["b", "a"] }), "c"), {
    kind: "move",
    move: "b-a+c",
  });
  // The arrow runs along the path only, not to the removed piece.
  assertEquals(view.board(request({ arrows: ["b-a+c"] })).arrows, [
    { from: "b", to: "a", kind: "line", index: 0 },
  ]);
  // As the last Move, the removed point is marked as an effect.
  assertEquals(view.board(request({ moves: ["a-b", "b-a+c"] })).highlights, [
    { target: "b", kind: "last-move" },
    { target: "a", kind: "last-move" },
    { target: "c", kind: "last-move-effect" },
  ]);
});

Deno.test("board and click skip Moves that do not decode instead of throwing", () => {
  const stale = request({ legalMoves: ["zz", "a-b"], arrows: ["zz", "a-c"] });
  const model = view.board(stale);
  assertEquals(model.arrows, [{ from: "a", to: "c", kind: "line", index: 1 }]);
  assertEquals(view.click(stale, "a"), { kind: "select", selection: ["a"] });
  assertEquals(view.click({ ...stale, selection: ["a"] }, "c"), {
    kind: "select",
    selection: [],
  });
  // An undecodable Position ignores clicks (board() throws; the page falls back).
  assertEquals(view.click(request({ position: "bad" }), "a"), {
    kind: "ignore",
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
