import { assert, assertEquals } from "@std/assert";
import {
  backgammon,
  type BackgammonMove,
  BAR,
  OFF,
} from "@boardwright/game-backgammon";
import {
  applySteps,
  backgammonRenderer as r,
  caption,
  DICE_TARGET,
  input,
  nextTargets,
  picked,
  pipCount,
  targetOf,
} from "./backgammon.ts";
import type { MoveListEntry } from "../api.ts";
import { gameView } from "./mod.ts";

const START = "b2,0,0,0,0,w5,0,w3,0,0,0,b5,w5,0,0,0,b3,0,b5,0,0,0,0,w2";
const decode = (text: string) => backgammon.notation.decodePosition(text);
const encode = (move: BackgammonMove) => backgammon.notation.encodeMove(move);
const at = (dice: string, turn = "white", points = START, bar = "0/0") =>
  decode(`${points} ${bar} ${turn} ${dice}`);

/** Clicks `targets` in order from an empty selection; the last intent. */
function clickAll(
  position: ReturnType<typeof at>,
  targets: readonly string[],
) {
  const legal = backgammon.legalMoves(position);
  let selection: readonly string[] = [];
  let intent = input(position, legal, selection, targets[0]!);
  for (const target of targets.slice(1)) {
    assertEquals(intent.kind, "select", `before ${target}`);
    if (intent.kind === "select") selection = intent.selection;
    intent = input(position, legal, selection, target);
  }
  return intent;
}

Deno.test("targetOf: points are named in white's numbering", () => {
  assertEquals(targetOf("white", 24), "p24");
  assertEquals(targetOf("black", 24), "p1");
  assertEquals(targetOf("black", BAR), "bar");
  assertEquals(targetOf("white", OFF), "off");
});

Deno.test("scene: 30 checkers, 24 points plus bar, tray and dice", () => {
  const scene = r.scene(backgammon.initialPosition());
  assertEquals(scene.targets.length, 27);
  // Stacks of five show four checkers and a count.
  const discs = scene.pieces.filter((p) => p.kind === "circle");
  assertEquals(discs.length, 2 * (2 + 4 + 3 + 4));
  const counts = scene.pieces.filter((p) => p.kind === "text");
  assertEquals(counts.map((t) => t.kind === "text" && t.text), [
    "5",
    "5",
    "5",
    "5",
  ]);
  const p24 = scene.targets.find((t) => t.id === "p24")!;
  assertEquals(p24.label, "point 24: 2 white");
  // White's 24-point is top right, its 1-point bottom right.
  const p1 = scene.targets.find((t) => t.id === "p1")!;
  assertEquals(p1.x, p24.x);
  assert(p1.y > p24.y);
});

Deno.test("scene: numbers points from the Seat to move's side", () => {
  const scene = r.scene(at("62", "black"));
  const p1 = scene.targets.find((t) => t.id === "p1")!;
  assertEquals(p1.label, "point 24: 2 black");
});

Deno.test("scene: bar, borne-off checkers and dice", () => {
  const points = "w1,0,0,0,0,w5,0,w3,0,0,0,b5,w3,0,0,0,b3,0,b5,0,0,0,0,w2";
  const p = at("33", "white", points, "1/1");
  // 1 + 5 + 3 + 3 + 2 on the board, 1 on the bar: 0 off for white.
  const scene = r.scene({ ...p, off: { white: 0, black: 1 } });
  const slabs = scene.pieces.filter((s) => s.kind === "rect");
  assertEquals(slabs.length, 1);
  assertEquals(
    scene.targets.find((t) => t.id === "bar")!.label,
    "bar: 1 white, 1 black",
  );
  const dice = scene.board.filter((s) => s.className.startsWith("die-face"));
  assertEquals(dice.map((s) => s.kind === "text" && s.text), ["3", "3"]);
});

Deno.test("caption: the turn, the dice and the pip counts", () => {
  assertEquals(
    caption(backgammon.initialPosition()),
    "Opening roll · pips: white 167, black 167",
  );
  assertEquals(caption(at("-", "black")).split(" · ")[0], "Black to roll");
  assertEquals(caption(at("62")).split(" · ")[0], "White to play 6-2");
  const won = { ...at("-"), off: { white: 15, black: 0 } };
  assertEquals(caption(won).split(" · ")[0], "White won");
  const onBar = { ...at("-"), bar: { white: 1, black: 0 } };
  assertEquals(pipCount(onBar, "white"), 167 + 25);
});

Deno.test("input: a Step is checker then destination, in any order", () => {
  const p = at("31");
  // The canonical order is 8/5 6/5; entering 6/5 first works too.
  for (const clicks of [["p8", "p5", "p6", "p5"], ["p6", "p5", "p8", "p5"]]) {
    const intent = clickAll(p, clicks);
    assertEquals(intent.kind, "move");
    if (intent.kind === "move") assertEquals(encode(intent.move), "8/5 6/5");
  }
});

Deno.test("input: a checker moved on is clicked again, either die first", () => {
  for (const via of ["p21", "p23"]) {
    const intent = clickAll(at("31"), ["p24", via, via, "p20"]);
    assert(intent.kind === "move");
    assertEquals(encode(intent.move), "24/21 21/20");
  }
});

Deno.test("input: a Step onto a blot hits it; the checker may move on", () => {
  // A black blot on black's 7-point (white's 18-point).
  const points = START.replace("b3,0,b5", "b2,b1,b5");
  const p = at("65", "white", points);
  const intent = clickAll(p, ["p24", "p18", "p18", "p13"]);
  assert(intent.kind === "move");
  assertEquals(encode(intent.move), "24/18 18/13");
  assertEquals(backgammon.play(p, intent.move).bar.black, 1);
  // The 5 would land on black's made 6-point (white's 19): only the hit.
  const legal = backgammon.legalMoves(p);
  assertEquals(nextTargets(p, legal, ["p24"]), ["p18"]);
});

Deno.test("input: a checker on the bar enters first", () => {
  const p = at("31", "white", START.replace("w2", "w1"), "1/0");
  const legal = backgammon.legalMoves(p);
  assertEquals(nextTargets(p, legal, ["p6"]), []);
  assertEquals(input(p, legal, [], "p6"), { kind: "ignore" });
  const intent = clickAll(p, ["bar", "p22", "p6", "p5"]);
  assert(intent.kind === "move");
  assertEquals(encode(intent.move), "bar/22 6/5");
});

Deno.test("input: bearing off is a Step to the tray", () => {
  const p = decode(
    "w2,w2,w2,w2,w2,w5,0,0,0,0,0,b5,0,0,0,0,b3,0,b5,0,0,0,0,b2 0/0 white 61",
  );
  const intent = clickAll(p, ["p5", "p4", "p6", "off"]);
  assert(intent.kind === "move");
  assertEquals(encode(intent.move), "6/off 5/4");
});

Deno.test("input: only the listed legal Moves can be entered", () => {
  const p = at("31");
  const legal = backgammon.legalMoves(p).filter((m) => encode(m) === "8/5 6/5");
  assertEquals(nextTargets(p, legal, ["p6"]), ["p5"]);
  assertEquals(input(p, [], [], "p8"), { kind: "ignore" });
  assertEquals(input(backgammon.initialPosition(), [], [], "p8"), {
    kind: "ignore",
  });
});

Deno.test("input: black's Steps use black's own points", () => {
  // Black's 13/10 is white's p12 -> p15 on the board.
  const p = at("31", "black");
  const intent = clickAll(p, ["p12", "p15", "p19", "p20"]);
  assert(intent.kind === "move");
  assertEquals(encode(intent.move), "13/10 6/5");
});

Deno.test("input: a double takes four Steps", () => {
  const p = at("66");
  const intent = clickAll(p, ["p24", "p18", "p24", "p18", "p13", "p7"]);
  assertEquals(intent.kind, "select");
  const legal = backgammon.legalMoves(p);
  assert(intent.kind === "select");
  const last = input(p, legal, intent.selection, "p13");
  assert(last.kind === "select");
  const done = input(p, legal, last.selection, "p7");
  assert(done.kind === "move");
  assertEquals(encode(done.move), "24/18 24/18 13/7 13/7");
});

Deno.test("input: re-picking, dropping and starting over", () => {
  const p = at("31");
  const legal = backgammon.legalMoves(p);
  // A checker that cannot be picked is ignored.
  assertEquals(input(p, legal, [], "p3"), { kind: "ignore" });
  assertEquals(input(p, legal, [], "p8"), {
    kind: "select",
    selection: ["p8"],
  });
  // Another checker replaces the picked one; the picked one drops itself.
  assertEquals(input(p, legal, ["p8"], "p6"), {
    kind: "select",
    selection: ["p6"],
  });
  assertEquals(input(p, legal, ["p8", "p5", "p6"], "p6"), {
    kind: "select",
    selection: ["p8", "p5"],
  });
  // A stray click keeps the selection; the dice start over.
  assertEquals(input(p, legal, ["p8"], "p20"), {
    kind: "select",
    selection: ["p8"],
  });
  assertEquals(input(p, legal, ["p8", "p5"], DICE_TARGET), {
    kind: "select",
    selection: [],
  });
  assertEquals(input(p, legal, [], DICE_TARGET), { kind: "ignore" });
});

Deno.test("input: the dice play pass when nothing can move", () => {
  // White is on the bar against a closed board.
  const closed = "w1,0,0,0,0,w5,0,w3,0,0,0,0,w5,0,0,0,0,b2,b3,b2,b2,b2,b2,b2";
  const p = decode(`${closed} 1/0 white 66`);
  const legal = backgammon.legalMoves(p);
  assertEquals(legal.map(encode), ["pass"]);
  const intent = input(p, legal, [], DICE_TARGET);
  assert(intent.kind === "move");
  assertEquals(encode(intent.move), "pass");
  assertEquals(r.moveTargets(intent.move, p), { path: [DICE_TARGET] });
});

Deno.test("nextTargets: movable checkers, then their destinations", () => {
  const p = at("31");
  const legal = backgammon.legalMoves(p);
  assertEquals(nextTargets(p, legal, []).sort(), [
    "p13",
    "p24",
    "p6",
    "p8",
  ]);
  assertEquals(nextTargets(p, legal, ["p6"]).sort(), ["p3", "p5"]);
  assertEquals(nextTargets(p, legal, ["p6", "p5"]).sort(), [
    "p13",
    "p24",
    "p5",
    "p6",
    "p8",
  ]);
  assertEquals(nextTargets(p, legal, ["p6", "p5", "p8"]), ["p5"]);
});

Deno.test("moveTargets: the first checker's journey, then the other points", () => {
  const p = at("31");
  const move = backgammon.notation.decodeMove("24/21 21/20", p);
  assertEquals(r.moveTargets(move, p), { path: ["p24", "p21", "p20"] });
  const split = backgammon.notation.decodeMove("13/10 6/5", p);
  assertEquals(r.moveTargets(split, p), {
    path: ["p13", "p10"],
    effects: ["p6", "p5"],
  });
  const p66 = at("66");
  const four = backgammon.notation.decodeMove("24/18 24/18 13/7 13/7", p66);
  assertEquals(r.moveTargets(four, p66), {
    path: ["p24", "p18"],
    effects: ["p13", "p7"],
  });
  const off = decode(
    "w2,w2,w2,w2,w2,w5,0,0,0,0,0,b5,0,0,0,0,b3,0,b5,0,0,0,0,b2 0/0 white 61",
  );
  assertEquals(
    r.moveTargets(backgammon.notation.decodeMove("6/off 6/5", off), off),
    { path: ["p6", "off"], effects: ["p5"] },
  );
});

Deno.test("gameView: backgammon highlights the destinations of a pick", () => {
  const view = gameView("backgammon")!;
  const p = at("31");
  const request = {
    position: backgammon.notation.encodePosition(p),
    entries: [],
    legalMoves: backgammon.legalMoves(p).map(encode),
    selection: ["p6"],
  };
  const { highlights } = view.board(request);
  assertEquals(
    highlights.filter((h) => h.kind === "destination").map((h) => h.target)
      .sort(),
    ["p3", "p5"],
  );
  assertEquals(
    view.click({ ...request, selection: ["p6", "p5", "p8"] }, "p5"),
    {
      kind: "move",
      move: "8/5 6/5",
    },
  );
});

Deno.test("gameView: an Analysis Line's Move is an arrow of its first checker", () => {
  const view = gameView("backgammon")!;
  const p = at("31");
  const { arrows } = view.board({
    position: backgammon.notation.encodePosition(p),
    entries: [],
    legalMoves: [],
    selection: [],
    arrows: ["13/10 6/5", null, "24/21 21/20"],
    preview: ["8/5 6/5"],
  });
  assertEquals(arrows, [
    { from: "p13", to: "p10", kind: "line", index: 0 },
    { from: "p24", to: "p20", kind: "line", index: 2 },
    { from: "p8", to: "p5", kind: "preview", index: 0 },
  ]);
});

Deno.test("applySteps: the Steps entered so far are played on the shown Position", () => {
  const p = at("31");
  assertEquals(applySteps(p, []), p);
  const moved = applySteps(p, ["p8", "p5", "p6"]);
  // A trailing picked checker is not a Step yet.
  assertEquals([moved.points[7], moved.points[4], moved.points[5]], [2, 1, 5]);
  assertEquals(p.points[7], 3, "the original Position is untouched");
  const both = applySteps(p, ["p8", "p5", "p6", "p5"]);
  assertEquals([both.points[5], both.points[4]], [4, 2]);
  // Black's checkers move towards lower points in white's numbering.
  const black = at("31", "black");
  const down = applySteps(black, ["p12", "p9"]);
  assertEquals([down.points[11], down.points[8]], [-4, -1]);
});

Deno.test("applySteps: hits, entering from the bar and bearing off", () => {
  const blot = "b1,0,0,0,b1,w5,0,w3,0,0,0,b5,w5,0,0,0,b3,0,b5,0,0,0,0,w2";
  const hit = applySteps(at("31", "white", blot), ["p6", "p5"]);
  assertEquals([hit.points[4], hit.points[5], hit.bar.black], [1, 4, 1]);
  const entering = applySteps(
    at("31", "white", START.replace(/w2$/, "w1"), "1/0"),
    ["bar", "p22"],
  );
  assertEquals([entering.bar.white, entering.points[21]], [0, 1]);
  const home = "w2,w2,w2,w2,w2,w5,0,0,0,0,0,b5,0,0,0,0,b3,0,b5,0,0,0,0,b2";
  const off = applySteps(at("61", "white", home), ["p6", "off"]);
  assertEquals([off.off.white, off.points[5]], [1, 4]);
  // Stale or impossible Steps are skipped.
  const p = at("31");
  assertEquals(applySteps(p, ["p2", "p1"]), p);
  assertEquals(applySteps(p, ["bar", "p2"]), p);
  assertEquals(applySteps(p, ["p6", "p30"]), p);
  assertEquals(applySteps({ ...p, turn: null }, ["p6", "p5"]).points, p.points);
});

Deno.test("scene: shows the Steps already entered, the caption keeps the Position", () => {
  const p = at("31");
  const scene = r.scene(p, ["p8", "p5"]);
  assertEquals(
    scene.targets.find((t) => t.id === "p5")!.label,
    "point 5: 1 white",
  );
  assertEquals(
    scene.targets.find((t) => t.id === "p8")!.label,
    "point 8: 2 white",
  );
  const caption = (s: typeof scene) =>
    s.board.find((x) => x.className === "caption");
  assertEquals(caption(scene), caption(r.scene(p)));
});

Deno.test("gameView: backgammon highlights the last Move across Chance events", () => {
  const view = gameView("backgammon")!;
  const p = backgammon.notation.encodePosition(backgammon.initialPosition());
  const entries = [
    { kind: "chance", chance: "6-1" },
    { kind: "move", move: "13/7 8/7" },
    { kind: "chance", chance: "52" },
  ] as const;
  const { highlights } = view.board({
    position: p,
    entries,
    legalMoves: [],
    selection: [],
  });
  assertEquals(highlights, [
    { target: "p13", kind: "last-move" },
    { target: "p7", kind: "last-move" },
    { target: "p8", kind: "last-move-effect" },
  ]);
});

Deno.test("gameView: backgammon review at an earlier ply and bad Chance events", () => {
  const view = gameView("backgammon")!;
  const position = backgammon.notation.encodePosition(
    backgammon.initialPosition(),
  );
  const request = { position, legalMoves: [], selection: [] };
  const last = (entries: readonly MoveListEntry[]) =>
    view.board({ ...request, entries }).highlights;
  const entries: MoveListEntry[] = [
    { kind: "chance", chance: "6-1" },
    { kind: "move", move: "13/7 8/7" },
    { kind: "chance", chance: "52" },
    { kind: "move", move: "24/22 13/8" },
  ];
  // Reviewing at ply 2 highlights the first Move, not the later one.
  assertEquals(last(entries.slice(0, 2)).map((h) => h.target), [
    "p13",
    "p7",
    "p8",
  ]);
  assertEquals(last(entries.slice(0, 3)).length, 3);
  // A Chance event that does not decode: no highlight, no throw.
  assertEquals(last([{ kind: "chance", chance: "zz" }, entries[1]!]), []);
});

Deno.test("picked: only a trailing picked checker is pending", () => {
  assertEquals(picked([]), []);
  assertEquals(picked(["p8"]), ["p8"]);
  assertEquals(picked(["p8", "p5"]), []);
  assertEquals(picked(["p8", "p5", "p6"]), ["p6"]);
  const view = gameView("backgammon")!;
  const { highlights } = view.board({
    position: backgammon.notation.encodePosition(at("31")),
    entries: [],
    legalMoves: [],
    selection: ["p8", "p5", "p6"],
  });
  assertEquals(
    highlights.filter((h) => h.kind === "selected").map((h) => h.target),
    ["p6"],
  );
});

Deno.test("applySteps: black entering from the bar, bearing off and hitting", () => {
  const blot = "b1,w1,0,0,0,w5,0,w3,0,0,0,b5,w5,0,0,0,b3,0,b5,0,0,0,0,w1";
  const entered = applySteps(at("31", "black", blot, "0/1"), ["bar", "p24"]);
  assertEquals(
    [entered.bar.black, entered.points[23], entered.bar.white],
    [0, -1, 1],
  );
  const hit = applySteps(
    at(
      "31",
      "black",
      "w1,b2,0,0,0,w5,0,w3,0,0,0,b5,w5,0,0,0,b3,0,b5,0,0,0,0,w1",
    ),
    ["p2", "p1"],
  );
  assertEquals([hit.points[0], hit.points[1], hit.bar.white], [-1, -1, 1]);
  const home = "b2,b2,b2,b2,b2,b5,0,0,0,0,0,w5,0,0,0,0,w3,0,w5,0,0,0,0,w2";
  const off = applySteps(at("61", "black", home), ["p6", "off"]);
  assertEquals([off.off.black, off.points[5]], [1, -4]);
});
