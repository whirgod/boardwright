import { assert, assertEquals } from "@std/assert";
import type { Analysis } from "@boardwright/core";
import { type MorrisMove, POINTS } from "@boardwright/game-nine-mens-morris";
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

Deno.test("blocks an immediate mill", async () => {
  assertEquals(await best(placing(["a7", "c3"], ["a1", "d1"], "w"), 2), "g1");
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
