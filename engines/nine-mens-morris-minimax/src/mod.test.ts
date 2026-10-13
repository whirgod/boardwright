import { assert, assertEquals } from "@std/assert";
import type { Analysis } from "@boardwright/core";
import { type MorrisMove, POINTS } from "@boardwright/game-nine-mens-morris";
import { assertEngineContract, seededRandom } from "@boardwright/testing";
import { engine, evaluate, rules, WEIGHTS } from "./mod.ts";

/** Position text for the given pieces; `hands` are `white:black` in hand. */
function text(
  white: string[],
  black: string[],
  turn: "w" | "b",
  hands: string,
): string {
  const board = POINTS.map((p) =>
    white.includes(p) ? "w" : black.includes(p) ? "b" : "."
  ).join("");
  // Moving phase needs the repetition history to hold the current Position.
  const history = hands === "0:0" ? board + turn : "";
  return `${board}:${turn}:${hands}:0:${history}`;
}

/** Placing-phase text; hands follow from the pieces already placed. */
function placing(white: string[], black: string[], turn: "w" | "b"): string {
  return text(white, black, turn, `${9 - white.length}:${9 - black.length}`);
}

const decode = (t: string) => rules.notation.decodePosition(t);

async function search(
  position: string,
  limits: { maxDepth?: number; maxTimeMs?: number; lines?: number },
): Promise<Analysis<MorrisMove>> {
  let last: Analysis<MorrisMove> | undefined;
  for await (const a of engine.analyze(decode(position), limits)) last = a;
  return last!;
}

async function best(position: string, maxDepth: number): Promise<string> {
  const a = await search(position, { maxDepth });
  return rules.notation.encodeMove(a.lines[0]!.moves[0]!);
}

Deno.test("belongs to nine-mens-morris", () => {
  assertEquals(engine.gameId, "nine-mens-morris");
  assertEquals(rules.id, "nine-mens-morris");
});

Deno.test("initial Position is level", () => {
  assertEquals(evaluate(rules.initialPosition()), 0);
});

const moving = (white: string[], black: string[], turn: "w" | "b") =>
  decode(text(white, black, turn, "0:0"));

Deno.test("evaluation is symmetric between Seats and favours material", () => {
  const w = ["a1", "d1", "d2", "g7"];
  const b = ["a7", "b4", "f6"];
  const white = evaluate(moving(w, b, "w"));
  assertEquals(white, -evaluate(moving(w, b, "b")));
  assert(white > WEIGHTS.piece / 2);
  // Swapping the colours as well mirrors the Position.
  assertEquals(evaluate(moving(b, w, "b")), white);
});

Deno.test("a closed mill outweighs a loose pair", () => {
  const black = ["a7", "d7", "b4"];
  const mill = moving(["a1", "d1", "g1"], black, "w");
  const loose = moving(["a1", "d1", "d3"], black, "w");
  assert(evaluate(mill) > evaluate(loose));
});

Deno.test("blocked pieces count against their owner", () => {
  // Black on a1 has neighbours d1 and a4.
  const black = ["a1", "c5", "e5", "b6"];
  const walled = moving(["d1", "a4", "g7"], black, "w");
  const free = moving(["d2", "a7", "e4"], black, "w");
  assert(evaluate(walled) > evaluate(free));
});

Deno.test("completes a mill and removes a piece", async () => {
  const move = await best(placing(["a1", "d1"], ["b2", "b4"], "w"), 3);
  assert(move.startsWith("g1x"), move);
});

/** Final Analysis with every legal root Move reported, best first. */
async function allLines(position: string, maxDepth: number) {
  const n = rules.legalMoves(decode(position)).length;
  const a = await search(position, { maxDepth, lines: n });
  return a.lines.map((l) => ({
    move: rules.notation.encodeMove(l.moves[0]!),
    value: l.score.kind === "value"
      ? l.score.value
      : l.score.kind === "win-in"
      ? 1e6
      : -1e6,
  }));
}

/** Asserts `expected` is best and every other Move is clearly worse. */
function assertOnlyMove(
  lines: { move: string; value: number }[],
  expected: string,
) {
  assertEquals(lines[0]!.move, expected);
  for (const l of lines.slice(1)) {
    assert(l.value <= lines[0]!.value - WEIGHTS.piece / 2, `${l.move} ties`);
  }
}

Deno.test("blocks an immediate mill; every other Move loses a piece", async () => {
  const lines = await allLines(placing(["a7", "c3"], ["a1", "d1"], "w"), 2);
  assertOnlyMove(lines, "g1");
});

Deno.test("moving phase: blocks the opponent's mill", async () => {
  // Black threatens d3-d2 closing b2-d2-f2; only white's d1 can block it.
  const position = text(
    ["d1", "a7", "g7", "e5"],
    ["b2", "f2", "d3", "a1"],
    "w",
    "0:0",
  );
  assertOnlyMove(await allLines(position, 2), "d1-d2");
});

Deno.test("flies to close a mill", async () => {
  // White has three pieces; g7 is not adjacent to g1 but may fly there.
  const position = text(
    ["a1", "d1", "g7"],
    ["b2", "b4", "f4", "e5"],
    "w",
    "0:0",
  );
  assert((await best(position, 1)).startsWith("g7-g1x"));
});

Deno.test("flying Seats are never counted as blocked", () => {
  const three = ["a1", "c5", "e5"];
  const walled = moving(["d1", "a4", "g7"], three, "w");
  const free = moving(["d2", "a7", "e4"], three, "w");
  assertEquals(evaluate(walled), evaluate(free));
});

const MATCHES = 6;
const MAX_PLIES = 120;

Deno.test("beats a seeded random mover", async () => {
  const rand = seededRandom(7);
  let wins = 0;
  let losses = 0;
  for (let i = 0; i < MATCHES; i++) {
    const seat = i % 2 === 0 ? "white" : "black";
    let p = rules.initialPosition();
    for (let ply = 0; ply < MAX_PLIES && !rules.outcome(p); ply++) {
      if (p.turn === seat) {
        let last: Analysis<MorrisMove> | undefined;
        for await (const a of engine.analyze(p, { maxDepth: 2 })) last = a;
        p = rules.play(p, last!.lines[0]!.moves[0]!);
      } else {
        const moves = rules.legalMoves(p);
        p = rules.play(p, moves[Math.floor(rand() * moves.length)]!);
      }
    }
    const winner = rules.outcome(p)?.winner;
    if (winner === seat) wins++;
    else if (winner !== undefined) losses++;
  }
  assert(wins >= MATCHES - 1 && losses === 0, `wins ${wins} losses ${losses}`);
});

Deno.test("moving phase: closes a mill by stepping", async () => {
  // g4-g1 completes a1-d1-g1.
  const position = text(
    ["a1", "d1", "g4"],
    ["a7", "d7", "b6", "f6"],
    "w",
    "0:0",
  );
  assert((await best(position, 1)).startsWith("g4-g1x"));
});

Deno.test("search honours limits and yields legal Lines", async () => {
  const p = rules.initialPosition();
  const all: Analysis<MorrisMove>[] = [];
  for await (const a of engine.analyze(p, { maxDepth: 3, lines: 3 })) {
    all.push(a);
  }
  assertEquals(all.map((a) => a.depth), [1, 2, 3]);
  const legal = rules.legalMoves(p).map(rules.notation.encodeMove);
  const last = all.at(-1)!;
  assertEquals(last.lines.length, 3);
  for (const line of last.lines) {
    assert(legal.includes(rules.notation.encodeMove(line.moves[0]!)));
  }
});

Deno.test("time limit stops an unbounded search", async () => {
  const a = await search(
    rules.notation.encodePosition(rules.initialPosition()),
    { maxTimeMs: 200 },
  );
  assert(a.depth >= 1);
});

Deno.test("terminal Position yields no Lines", async () => {
  // Black has only two pieces left.
  const a = await search(text(["a1", "d1", "g1"], ["b2", "b4"], "w", "0:0"), {
    maxDepth: 2,
  });
  assertEquals(a.depth, 0);
  assertEquals(a.lines, []);
});

Deno.test("honours the Engine contract", async () => {
  await assertEngineContract(engine, rules, { positions: 3, maxDepth: 2 });
});
