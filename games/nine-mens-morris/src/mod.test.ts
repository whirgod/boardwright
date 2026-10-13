import { assertEquals, assertThrows } from "@std/assert";
import { assertGameRulesContract } from "@boardwright/testing";
import {
  type Cell,
  MILLS,
  type MorrisMove,
  type MorrisPosition,
  neighborsOf,
  nineMensMorris as g,
  POINTS,
} from "./mod.ts";

const n = g.notation;

interface Spec {
  /** Space separated points. */
  white?: string;
  black?: string;
  turn?: "white" | "black";
  hand?: [number, number];
  quiet?: number;
}

/** Build a Position; the moving phase gets a synthetic history. */
function pos(spec: Spec): MorrisPosition {
  const board = Array<Cell>(24).fill(".");
  for (const p of (spec.white ?? "").split(" ").filter(Boolean)) {
    board[POINTS.indexOf(p)] = "w";
  }
  for (const p of (spec.black ?? "").split(" ").filter(Boolean)) {
    board[POINTS.indexOf(p)] = "b";
  }
  const turn = spec.turn ?? "white";
  const [white, black] = spec.hand ?? [0, 0];
  const quiet = spec.quiet ?? 0;
  const placing = white > 0 || black > 0;
  const key = board.join("") + (turn === "white" ? "w" : "b");
  const dummy = (i: number) =>
    ".".repeat(23) + "w" +
    (((quiet - i) % 2 === 0) === (turn === "white") ? "w" : "b");
  const history = placing
    ? []
    : [...Array.from({ length: quiet }, (_, i) => dummy(i)), key];
  return { board, turn, inHand: { white, black }, quietPlies: quiet, history };
}

function play(p: MorrisPosition, ...moves: string[]): MorrisPosition {
  return moves.reduce((q, m) => g.play(q, n.decodeMove(m, q)), p);
}

const enc = (moves: readonly MorrisMove[]) =>
  moves.map((m) => n.encodeMove(m)).sort();

Deno.test("satisfies the GameRules contract", () => {
  // Illegal-Move probing is quadratic in the Move pool; run it on few playouts
  // and cover many playouts without it.
  assertGameRulesContract(g, {
    seed: 7,
    playouts: 300,
    checkIllegalMoves: false,
  });
  assertGameRulesContract(g, { seed: 11, playouts: 4 });
});

Deno.test("initial position", () => {
  const p = g.initialPosition();
  assertEquals(g.seats, ["white", "black"]);
  assertEquals(g.toMove(p), "white");
  assertEquals(g.outcome(p), undefined);
  assertEquals(g.legalMoves(p).length, 24);
  assertEquals(n.encodePosition(p), ".".repeat(24) + ":w:9:9:0:");
  assertEquals(POINTS.length, 24);
  assertEquals(new Set(POINTS).size, 24);
});

Deno.test("placing alternates Seats and decrements hands", () => {
  const p = play(g.initialPosition(), "a1", "d1");
  assertEquals(p.inHand, { white: 8, black: 8 });
  assertEquals(g.toMove(p), "white");
  const q = play(p, "g7");
  assertEquals(g.toMove(q), "black");
  assertEquals(q.inHand, { white: 7, black: 8 });
  assertEquals(g.legalMoves(q).length, 21);
});

Deno.test("phase transition from placing to moving", () => {
  const white = "a1 a7 g1 g7 b2 b6 f2 f6 c3".split(" ");
  const black = "d1 d7 a4 g4 d2 d6 b4 f4 c5".split(" ");
  let p = g.initialPosition();
  for (let i = 0; i < 9; i++) {
    p = play(p, white[i]!);
    if (i < 8) {
      assertEquals(p.history, []);
    }
    p = play(p, black[i]!);
  }
  assertEquals(p.inHand, { white: 0, black: 0 });
  assertEquals(g.toMove(p), "white");
  assertEquals(p.history.length, 1);
  assertEquals(p.quietPlies, 0);
  // Moves now are slides between adjacent points only.
  for (const m of g.legalMoves(p)) {
    assertEquals(m.from !== undefined, true);
  }
  const next = g.play(p, g.legalMoves(p)[0]!);
  assertEquals(next.history.length, 2);
  assertEquals(next.quietPlies, 1);
});

Deno.test("a placement forming a mill must remove (choices enumerated)", () => {
  const p = pos({
    white: "a1 d1",
    black: "b2 b4",
    hand: [7, 7],
  });
  const moves = enc(g.legalMoves(p).filter((m) => m.to === "g1"));
  assertEquals(moves, ["g1xb2", "g1xb4"]);
  // Placing elsewhere forms no mill and has no removal.
  assertEquals(g.legalMoves(p).filter((m) => m.remove).length, 2);
  const after = play(p, "g1xb2");
  assertEquals(after.board[POINTS.indexOf("b2")], ".");
  assertEquals(after.board[POINTS.indexOf("b4")], "b");
  assertEquals(after.inHand, { white: 6, black: 7 });
  assertThrows(() => play(p, "g1"), Error, "Illegal");
  assertThrows(() => play(p, "g1xa4"), Error, "Illegal");
  assertThrows(() => play(p, "g1xa1"), Error, "Illegal");
  assertThrows(() => play(p, "d1"), Error, "Illegal");
});

Deno.test("pieces in a mill are protected unless all are in mills", () => {
  const protectedMill = pos({
    white: "a1 d1",
    black: "b2 d2 f2 a4",
    hand: [7, 5],
  });
  assertEquals(
    enc(g.legalMoves(protectedMill).filter((m) => m.to === "g1")),
    ["g1xa4"],
  );
  const allInMills = pos({
    white: "a1 d1",
    black: "b2 d2 f2 c3 d3 e3",
    hand: [7, 3],
  });
  assertEquals(
    enc(g.legalMoves(allInMills).filter((m) => m.to === "g1")),
    ["g1xb2", "g1xc3", "g1xd2", "g1xd3", "g1xe3", "g1xf2"],
  );
});

Deno.test("a moved piece forming a mill removes; opening a mill is not a mill", () => {
  const p = pos({
    white: "a1 d1 g4 b6",
    black: "a7 d7 f4 f6",
  });
  // g4-g1 forms a1-d1-g1.
  const mills = g.legalMoves(p).filter((m) => m.to === "g1" && m.remove);
  assertEquals(mills.length, 4);
  assertEquals(mills.every((m) => m.from === "g4" && m.remove), true);
  const q = play(p, "g4-g1xf4");
  assertEquals(q.quietPlies, 0);
  assertEquals(q.history.length, 1);
  assertEquals(q.board[POINTS.indexOf("f4")], ".");
  // Moving a piece out of the mill and back forms the mill again.
  const out = play(q, "a7-a4", "g1-g4", "a4-a7");
  const back = g.legalMoves(out).filter((m) => m.from === "g4");
  assertEquals(back.some((m) => m.to === "g1" && m.remove), true);
});

Deno.test("adjacency follows the board lines, not the empty centre", () => {
  const p = pos({ white: "d3 a1 a7 g1", black: "b2 b6 f2 f6" });
  const d3 = enc(g.legalMoves(p).filter((m) => m.from === "d3"));
  assertEquals(d3, ["d3-c3", "d3-d2", "d3-e3"]);
  const q = pos({ white: "c4 a1 a7 g1", black: "b2 b6 f2 f6" });
  assertEquals(
    enc(g.legalMoves(q).filter((m) => m.from === "c4")),
    ["c4-b4", "c4-c3", "c4-c5"],
  );
  const r = pos({ white: "e4 a1 a7 g1", black: "b2 b6 f2 f6" });
  assertEquals(
    enc(g.legalMoves(r).filter((m) => m.from === "e4")),
    ["e4-e3", "e4-e5", "e4-f4"],
  );
  // Occupied neighbours are not targets.
  const s = pos({ white: "d3 d2 a1 a7", black: "c3 e3 f2 f6" });
  assertEquals(g.legalMoves(s).filter((m) => m.from === "d3").length, 0);
  assertThrows(() => play(p, "d3-d5"), Error, "Illegal");
});

Deno.test("flying with exactly three pieces", () => {
  const p = pos({ white: "a1 a7 g7", black: "d1 d2 b2 b4 f6" });
  const empties = POINTS.filter((q) =>
    !"a1 a7 g7 d1 d2 b2 b4 f6".split(" ").includes(q)
  );
  assertEquals(empties.length, 16);
  const fromA1 = g.legalMoves(p).filter((m) => m.from === "a1");
  assertEquals(
    [...new Set(fromA1.map((m) => m.to))].sort(),
    [...empties].sort(),
  );
  // Flying to d7 completes a7-d7-g7: one Move per removal choice.
  assertEquals(fromA1.filter((m) => m.to !== "d7").length, 15);
  assertEquals(
    enc(fromA1.filter((m) => m.to === "d7")),
    ["a1-d7xb2", "a1-d7xb4", "a1-d7xd1", "a1-d7xd2", "a1-d7xf6"],
  );
  // Black with five pieces cannot fly.
  const q = pos({ white: "a1 a7 g7", black: "d1 d2 b2 b4 f6", turn: "black" });
  assertEquals(
    enc(g.legalMoves(q).filter((m) => m.from === "b4")),
    ["b4-a4", "b4-b6", "b4-c4"],
  );
  assertThrows(() => play(q, "b4-g4"), Error, "Illegal");
  // Four pieces do not fly either.
  const r = pos({ white: "a1 a7 g7 g1" });
  assertEquals(
    g.legalMoves(r).some((m) => m.from === "a1" && m.to === "g4"),
    false,
  );
});

Deno.test("a Seat reduced to three by a removal flies on its next Move", () => {
  const p = pos({ white: "a1 d1 g4 b6", black: "a7 d7 f4 f6", turn: "white" });
  // With four pieces black may only slide: a7 reaches a4 only.
  const slid = play(p, "b6-b4");
  assertEquals(
    enc(g.legalMoves(slid).filter((m) => m.from === "a7")),
    ["a7-a4"],
  );
  const q = play(p, "g4-g1xf4");
  assertEquals(g.outcome(q), undefined);
  const flights = g.legalMoves(q).filter((m) => m.from === "a7");
  assertEquals(flights.some((m) => m.to === "c3"), true);
  assertEquals(flights.length > 1, true);
  const r = play(q, "a7-c3");
  assertEquals(r.board[POINTS.indexOf("c3")], "b");
  assertEquals(r.board[POINTS.indexOf("a7")], ".");
});

Deno.test("hand pieces do not allow flying", () => {
  const p = pos({
    white: "a1 a7 g7",
    black: "d1 d2 b2",
    hand: [1, 2],
    turn: "black",
  });
  // Black has hand 2 vs white 1: valid; black places.
  assertEquals(g.legalMoves(p).every((m) => m.from === undefined), true);
});

Deno.test("loss: fewer than three pieces after a removal", () => {
  const p = pos({ white: "a1 d1 g4", black: "a7 d7 f4", turn: "white" });
  const q = play(p, "g4-g1xa7");
  // Black now has 2 pieces.
  assertEquals(g.outcome(q), {
    winner: "white",
    reason: "fewer-than-three-pieces",
  });
  assertEquals(g.toMove(q), undefined);
  assertEquals(g.legalMoves(q), []);
});

Deno.test("loss: pieces in hand count towards the three", () => {
  const p = pos({
    white: "a1 d1 a7",
    black: "b2 b4",
    hand: [3, 3],
    turn: "white",
  });
  assertEquals(g.outcome(p), undefined);
  const dead = pos({
    white: "a1 d1 a7",
    black: "b2 b4",
    hand: [0, 0],
    turn: "white",
  });
  assertEquals(g.outcome(dead), {
    winner: "white",
    reason: "fewer-than-three-pieces",
  });
  const dead2 = pos({ white: "a1 d1", black: "b2 b4 d6", turn: "black" });
  assertEquals(g.outcome(dead2)?.winner, "black");
});

Deno.test("loss: no legal move", () => {
  const p = pos({
    white: "a7 b4 d2 g4",
    black: "a1 a4 d1 g1",
    turn: "black",
  });
  assertEquals(g.legalMoves(p), []);
  assertEquals(g.outcome(p), { winner: "white", reason: "no-legal-moves" });
  // The same blockade with white to move: white has moves, no outcome.
  assertEquals(
    g.outcome({
      ...p,
      turn: "white",
      history: [p.history[0]!.slice(0, 24) + "w"],
    }),
    undefined,
  );
});

Deno.test("loss: blocked piece count of exactly three can still fly", () => {
  const p = pos({
    white: "a7 b4 d2 g4 g7",
    black: "a1 a4 d1",
    turn: "black",
  });
  assertEquals(g.outcome(p), undefined);
});

Deno.test("draw: threefold repetition", () => {
  const start = pos({ white: "a1 g7 c3 e5", black: "a7 g1 e3 c5" });
  const cycle = ["a1-a4", "g1-g4", "a4-a1", "g4-g1"];
  let p = start;
  for (let i = 0; i < 7; i++) {
    p = play(p, cycle[i % 4]!);
    assertEquals(g.outcome(p), undefined, `ply ${i + 1}`);
  }
  p = play(p, cycle[3]!);
  assertEquals(
    n.encodePosition(p).split(":")[0],
    n.encodePosition(start).split(":")[0],
  );
  assertEquals(g.outcome(p), { reason: "threefold-repetition" });
  assertEquals(g.toMove(p), undefined);
  assertEquals(g.legalMoves(p), []);
});

Deno.test("draw: twice is not enough, and a removal resets repetition", () => {
  const start = pos({ white: "a1 g7 c3 e5", black: "a7 g1 e3 c5" });
  const p = play(start, "a1-a4", "g1-g4", "a4-a1", "g4-g1");
  assertEquals(g.outcome(p), undefined);
  assertEquals(p.history.length, 5);
  const m = pos({ white: "a1 d1 g4 c3", black: "a7 d7 f4 f6" });
  const q = play(m, "g4-g1xf4");
  assertEquals(q.history.length, 1);
});

Deno.test("draw: fifty plies without removal", () => {
  const p = pos({ white: "a1 g7 c3 e5", black: "a7 g1 e3 c5", quiet: 49 });
  assertEquals(g.outcome(p), undefined);
  const q = play(p, "a1-a4");
  assertEquals(q.quietPlies, 50);
  assertEquals(g.outcome(q), { reason: "fifty-moves-without-removal" });
  // A removal on the 50th ply resets the counter instead.
  const r = pos({ white: "a1 d1 g4 c3", black: "a7 d7 f4 f6", quiet: 49 });
  const s = play(r, "g4-g1xf4");
  assertEquals(s.quietPlies, 0);
  assertEquals(g.outcome(s), undefined);
});

Deno.test("loss takes precedence over a draw", () => {
  const p = pos({ white: "a1 d1 g4 c3", black: "a7 d7 f4", quiet: 49 });
  const q = play(p, "g4-g1xa7");
  assertEquals(g.outcome(q)?.winner, "white");
});

Deno.test("notation: moves", () => {
  assertEquals(n.decodeMove("d1", g.initialPosition()), { to: "d1" });
  assertEquals(n.decodeMove("d1-d2", g.initialPosition()), {
    from: "d1",
    to: "d2",
  });
  assertEquals(n.decodeMove("d1-d2xg7", g.initialPosition()), {
    from: "d1",
    to: "d2",
    remove: "g7",
  });
  assertEquals(n.decodeMove("d1xg7", g.initialPosition()), {
    to: "d1",
    remove: "g7",
  });
  for (const t of ["d1-d2xg7", "d1", "d1-d2", "g1xa4"]) {
    assertEquals(n.encodeMove(n.decodeMove(t, g.initialPosition())), t);
  }
  for (
    const bad of [
      "xg7",
      "h1",
      "d4",
      "a2",
      "D1",
      "d1-",
      "d1-d4",
      "d1-d2x",
      "d1-d2xd4",
      "d1 d2",
      "d1-d2-d3",
      "d1xg7-d2",
      "x",
    ]
  ) {
    assertThrows(
      () => n.decodeMove(bad, g.initialPosition()),
      Error,
      "Invalid",
      bad,
    );
  }
  // Syntactically valid but illegal Moves are rejected by play.
  assertThrows(() => play(g.initialPosition(), "d1-d2"), Error, "Illegal");
  assertThrows(() => play(g.initialPosition(), "d1-d1"), Error, "Illegal");
});

Deno.test("notation: positions round trip", () => {
  let p = g.initialPosition();
  const texts: string[] = [];
  const rng = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9];
  for (const r of rng) {
    texts.push(n.encodePosition(p));
    const moves = g.legalMoves(p);
    p = g.play(p, moves[r % moves.length]!);
  }
  for (const t of texts) assertEquals(n.encodePosition(n.decodePosition(t)), t);
  const moving = pos({ white: "a1 g7 c3 e5", black: "a7 g1 e3 c5", quiet: 3 });
  const t = n.encodePosition(moving);
  assertEquals(n.decodePosition(t), moving);
});

Deno.test("notation: invalid positions", () => {
  const empty = ".".repeat(24);
  const key = empty + "w";
  const bad = [
    "",
    empty,
    empty + ":w:9:9:0",
    "x".repeat(24) + ":w:9:9:0:",
    empty + ":x:9:9:0:",
    empty + ":w:9:9:0",
    `${empty}:w:9:8:0:`, // hands out of step for white
    `${empty}:b:9:9:0:`, // hands out of step for black
    `${empty}:w:9:9:1:`, // counters in placing phase
    `${empty}:w:9:9:0:${key}`, // history in placing phase
    `${empty}:w:0:0:0:`, // moving phase needs history
    `${empty}:w:0:0:0:${empty}b`, // history must end with current
    `${empty}:w:0:0:1:${key}`, // quiet vs history
    `${empty}:w:0:0:51:${key}`,
    `${"w".repeat(10)}${".".repeat(14)}:w:0:0:0:${"w".repeat(10)}${
      ".".repeat(14)
    }w`, // too many
    `${"w".repeat(5)}${".".repeat(19)}:w:5:5:0:`, // 5 on board + 5 in hand
    `${empty}:w:10:10:0:`,
    `${empty}:w:9:9:0: `,
  ];
  for (const t of bad) {
    assertThrows(
      () => n.decodePosition(t),
      Error,
      "Invalid",
      JSON.stringify(t),
    );
  }
});

Deno.test("play never mutates its input", () => {
  const p = pos({ white: "a1 d1", black: "b2 b4", hand: [7, 7] });
  const before = n.encodePosition(p);
  play(p, "g1xb2");
  assertEquals(n.encodePosition(p), before);
  assertThrows(() => play(p, "a4xb2"), Error, "Illegal");
  assertEquals(n.encodePosition(p), before);
});

// Independent literal topology (not derived from MILLS).
const EXPECTED_MILLS = [
  "a1 d1 g1",
  "b2 d2 f2",
  "c3 d3 e3",
  "a4 b4 c4",
  "e4 f4 g4",
  "c5 d5 e5",
  "b6 d6 f6",
  "a7 d7 g7",
  "a1 a4 a7",
  "b2 b4 b6",
  "c3 c4 c5",
  "d1 d2 d3",
  "d5 d6 d7",
  "e3 e4 e5",
  "f2 f4 f6",
  "g1 g4 g7",
].map((l) => l.split(" "));

const EXPECTED_NEIGHBORS: Record<string, string[]> = Object.fromEntries(
  Object.entries({
    a1: "a4 d1",
    a4: "a1 a7 b4",
    a7: "a4 d7",
    b2: "b4 d2",
    b4: "a4 b2 b6 c4",
    b6: "b4 d6",
    c3: "c4 d3",
    c4: "b4 c3 c5",
    c5: "c4 d5",
    d1: "a1 d2 g1",
    d2: "b2 d1 d3 f2",
    d3: "c3 d2 e3",
    d5: "c5 d6 e5",
    d6: "b6 d5 d7 f6",
    d7: "a7 d6 g7",
    e3: "d3 e4",
    e4: "e3 e5 f4",
    e5: "d5 e4",
    f2: "d2 f4",
    f4: "e4 f2 f6 g4",
    f6: "d6 f4",
    g1: "d1 g4",
    g4: "f4 g1 g7",
    g7: "d7 g4",
  }).map(([k, v]) => [k, v.split(" ")]),
);

const sorted = (xs: readonly string[]) => [...xs].sort();

Deno.test("topology: the 16 mills are exactly the expected lines", () => {
  assertEquals(
    sorted(MILLS.map((m) => sorted(m).join(" "))),
    sorted(EXPECTED_MILLS.map((m) => sorted(m).join(" "))),
  );
});

Deno.test("topology: neighbours of all 24 points", () => {
  assertEquals(Object.keys(EXPECTED_NEIGHBORS).length, 24);
  let edges = 0;
  for (const point of POINTS) {
    const expected = EXPECTED_NEIGHBORS[point]!;
    edges += expected.length;
    assertEquals(sorted(neighborsOf(point)), expected, point);
    for (const q of expected) {
      assertEquals(EXPECTED_NEIGHBORS[q]!.includes(point), true);
    }
  }
  assertEquals(edges, 64); // 32 undirected edges
});

Deno.test("topology: a lone sliding piece reaches exactly its neighbours", () => {
  for (const point of POINTS) {
    // Four white pieces so nobody flies; the other three sit far away.
    const others = POINTS.filter((q) =>
      q !== point && !EXPECTED_NEIGHBORS[point]!.includes(q)
    );
    const p = pos({
      white: [point, ...others.slice(0, 3)].join(" "),
      black: noMill(others.slice(3), 4),
    });
    const targets = g.legalMoves(p).filter((m) => m.from === point).map((m) =>
      m.to
    );
    assertEquals(
      sorted([...new Set(targets)]),
      EXPECTED_NEIGHBORS[point],
      point,
    );
  }
});

/** First `k` candidates such that the chosen set holds no complete mill. */
function noMill(candidates: readonly string[], k: number): string {
  const chosen: string[] = [];
  for (const c of candidates) {
    const next = [...chosen, c];
    if (EXPECTED_MILLS.some((m) => m.every((q) => next.includes(q)))) continue;
    chosen.push(c);
    if (chosen.length === k) break;
  }
  return chosen.join(" ");
}

function blackAvoiding(avoid: string[]): string {
  return noMill(POINTS.filter((q) => !avoid.includes(q)), 4);
}

Deno.test("every mill: placing the third piece removes", () => {
  for (const mill of EXPECTED_MILLS) {
    for (const third of mill) {
      const two = mill.filter((q) => q !== third);
      const p = pos({
        white: two.join(" "),
        black: blackAvoiding(mill),
        hand: [7, 7],
      });
      const placements = g.legalMoves(p).filter((m) => m.to === third);
      assertEquals(placements.length, 4, `${mill} ${third}`);
      assertEquals(placements.every((m) => m.remove !== undefined), true);
      // Placing elsewhere never removes.
      assertEquals(
        g.legalMoves(p).filter((m) => m.to !== third && m.remove).length,
        0,
        `${mill}`,
      );
    }
  }
});

Deno.test("every mill: sliding or flying the third piece removes", () => {
  for (const mill of EXPECTED_MILLS) {
    for (const third of mill) {
      const two = mill.filter((q) => q !== third);
      const via = EXPECTED_NEIGHBORS[third]!.find((q) => !mill.includes(q))!;
      const extra = POINTS.find((q) =>
        !mill.includes(q) && q !== via && !EXPECTED_NEIGHBORS[via]!.includes(q)
      )!;
      const black = blackAvoiding([...mill, via, extra]);
      const slide = pos({ white: [...two, via, extra].join(" "), black });
      const slides = g.legalMoves(slide).filter((m) =>
        m.from === via && m.to === third
      );
      assertEquals(slides.length, 4, `slide ${via}-${third}`);
      assertEquals(slides.every((m) => m.remove !== undefined), true);
      const fly = pos({ white: [...two, via].join(" "), black });
      const flights = g.legalMoves(fly).filter((m) =>
        m.from === via && m.to === third
      );
      assertEquals(flights.length, 4, `fly ${via}-${third}`);
      assertEquals(flights.every((m) => m.remove !== undefined), true);
    }
  }
});

Deno.test("mill detection only concerns the moved piece and one colour", () => {
  // An existing white mill does not make other Moves remove.
  const existing = pos({ white: "a1 d1 g1 b2", black: "a7 d7 f4 f6" });
  const moves = g.legalMoves(existing);
  assertEquals(moves.length > 0, true);
  assertEquals(moves.filter((m) => m.remove).length, 0);
  // Opening and closing the same mill does remove.
  const open = play(existing, "g1-g4", "a7-a4");
  assertEquals(
    g.legalMoves(open).some((m) =>
      m.from === "g4" && m.to === "g1" && m.remove
    ),
    true,
  );
  // Black completing a line that holds white pieces forms no mill.
  const mixed = pos({
    white: "a1 d1 b2 b6",
    black: "g4 a7 d7 f6",
    turn: "black",
  });
  const toG1 = g.legalMoves(mixed).filter((m) => m.to === "g1");
  assertEquals(toG1.length, 1);
  assertEquals(toG1[0]!.remove, undefined);
  // A placement beside opposing pieces on a line is not a mill.
  const placing = pos({ white: "a1 d1", black: "g1 g4", hand: [7, 6] });
  assertEquals(g.legalMoves(placing).filter((m) => m.remove).length, 0);
});

Deno.test("placing phase ends with one Seat out of hand first", () => {
  // White has placed all nine; black still holds one piece and is to move.
  const white = "a1 a7 g1 g7 b2 b6 f2 f6 c3";
  const black = "d1 d7 a4 g4 d2 d6 b4 f4";
  const p = pos({ white, black, hand: [0, 1], turn: "black" });
  assertEquals(g.outcome(p), undefined);
  assertEquals(g.toMove(p), "black");
  // Black must place (no slides) although white has nothing in hand.
  const moves = g.legalMoves(p);
  assertEquals(new Set(moves.map((m) => m.to)).size, 24 - 17);
  assertEquals(moves.every((m) => m.from === undefined), true);
  assertEquals(n.decodePosition(n.encodePosition(p)), p);
  const q = play(p, "c5");
  assertEquals(q.inHand, { white: 0, black: 0 });
  assertEquals(g.toMove(q), "white");
  assertEquals(q.history.length, 1);
  assertEquals(q.quietPlies, 0);
  assertEquals(g.outcome(q), undefined);
  // "No legal Move" cannot occur while placing: at most 18 of the 24 points
  // are ever occupied, so a free point always exists.
});

Deno.test("decoding is canonical and strict", () => {
  const e = ".".repeat(24);
  const keyW = e + "w";
  const keyB = e + "b";
  const ok = [
    `${e}:w:9:9:0:`,
    `${e}:w:0:0:0:${keyW}`,
    `${e}:w:0:0:1:${keyB},${keyW}`,
    `${e}:b:0:0:1:${keyW},${keyB}`,
  ];
  for (const t of ok) assertEquals(n.encodePosition(n.decodePosition(t)), t);
  const bad = [
    `${e}:w:0:0:00:${keyW}`, // leading zero
    `${e}:w:0:0:01:${keyB},${keyW}`,
    `${e}:w:0:0:1:${keyW},${keyW}`, // turns do not alternate
    `${e}:w:0:0:2:${keyW},${keyB},${keyB}`,
    `${"w".repeat(5)}${".".repeat(19)}:w:8:8:0:`, // 5 on board, only 1 placed
    `${"b".repeat(3)}${".".repeat(21)}:w:9:9:0:`,
  ];
  for (const t of bad) {
    assertThrows(() => n.decodePosition(t), Error, "Invalid", t);
  }
});
