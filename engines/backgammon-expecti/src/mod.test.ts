import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import type { Analysis } from "@boardwright/core";
import type {
  BackgammonMove,
  BackgammonPosition,
  BackgammonSeat,
} from "@boardwright/game-backgammon";
import { assertEngineContract, seededRandom } from "@boardwright/testing";
import {
  DEFAULT_MAX_DEPTH,
  engine,
  evaluate,
  features,
  rawEvaluation,
  rules,
  SCALE,
} from "./mod.ts";

const decode = (t: string) => rules.notation.decodePosition(t);

/**
 * Position text from each Seat's checkers by its own point numbers (`bar`
 * for the bar); missing checkers are borne off.
 */
function position(
  white: Record<string, number>,
  black: Record<string, number>,
  turn: string,
  dice: string,
): BackgammonPosition {
  const points = new Array<string>(24).fill("0");
  for (const [p, n] of Object.entries(white)) {
    if (p !== "bar") points[Number(p) - 1] = `w${n}`;
  }
  for (const [p, n] of Object.entries(black)) {
    if (p !== "bar") points[24 - Number(p)] = `b${n}`;
  }
  return decode(
    `${points.join(",")} ${white.bar ?? 0}/${black.bar ?? 0} ${turn} ${dice}`,
  );
}

const START = { 24: 2, 13: 5, 8: 3, 6: 5 };

async function search(
  p: BackgammonPosition,
  limits: { maxDepth?: number; maxTimeMs?: number; lines?: number },
): Promise<Analysis<BackgammonMove>[]> {
  const all: Analysis<BackgammonMove>[] = [];
  for await (const a of engine.analyze(p, limits)) all.push(a);
  return all;
}

async function bestMove(
  p: BackgammonPosition,
  maxDepth = 1,
): Promise<BackgammonMove> {
  const all = await search(p, { maxDepth });
  return all.at(-1)!.lines[0]!.moves[0]!;
}

Deno.test("belongs to backgammon", () => {
  assertEquals(engine.gameId, "backgammon");
  assertEquals(rules.id, "backgammon");
});

Deno.test("initial Position is level and features are counted", () => {
  const p = rules.initialPosition();
  assertEquals(evaluate(p, "white"), 0);
  assertEquals(features(p, "white"), {
    pips: 167,
    off: 0,
    bar: 0,
    // The back checkers sit on a made point: no blots.
    blots: 0,
    points: 4,
    homePoints: 1,
  });
  assertEquals(features(p, "black"), features(p, "white"));
});

Deno.test("evaluation is symmetric, squashed and favours the pip lead", () => {
  const p = position(START, { 24: 2, 13: 5, 8: 3, 6: 4, 3: 1 }, "white", "-");
  const raw = rawEvaluation(p, "white");
  assertEquals(rawEvaluation(p, "black"), -raw);
  assertAlmostEquals(evaluate(p, "white"), Math.tanh(raw / SCALE));
  assertEquals(evaluate(p, "black"), -evaluate(p, "white"));
  // Black is 3 pips ahead but left a blot within reach of white's back men.
  assertEquals(features(p, "black").blots, 1);
  assert(evaluate(p, "white") > 0);
  // Values stay inside (-1, 1) even for a crushing lead.
  const crushing = position({ 1: 1 }, { 24: 15 }, "white", "-");
  assert(evaluate(crushing, "white") < 1);
  assert(evaluate(crushing, "white") > 0.99);
});

Deno.test("blots out of the Opponent's reach cost nothing", () => {
  // A race: every black checker is past every white one.
  const race = position({ 6: 1, 5: 14 }, { 6: 1, 5: 14 }, "white", "-");
  assertEquals(features(race, "white").blots, 0);
  // A black checker behind white's blot can hit it.
  const contact = position({ 6: 1, 5: 14 }, { 24: 1, 5: 14 }, "white", "-");
  assertEquals(features(contact, "white").blots, 1);
  // So can one on the bar, entering in white's home board.
  const bar = position({ 6: 1, 5: 14 }, { bar: 1, 5: 14 }, "white", "-");
  assertEquals(features(bar, "white").blots, 1);
  assertEquals(features(bar, "black").bar, 1);
  assertEquals(features(bar, "black").pips, 25 + 5 * 14);
});

Deno.test("opening 31 makes the 5-point", async () => {
  const move = await bestMove(position(START, START, "white", "31"));
  assertEquals(rules.notation.encodeMove(move), "8/5 6/5");
});

Deno.test("hits a blot", async () => {
  // Black split to its 23-point (white's 2-point); white rolls 64.
  const p = position(START, { 24: 1, 23: 1, 13: 5, 8: 3, 6: 5 }, "white", "64");
  for (const depth of [1, 2]) {
    const after = rules.play(p, await bestMove(p, depth));
    assertEquals(after.bar.black, 1, `depth ${depth}`);
  }
});

Deno.test("bears off rather than moving inside", async () => {
  const white = { 6: 3, 5: 3, 4: 3, 3: 2, 2: 2, 1: 2 };
  const black = { 6: 3, 5: 3, 4: 3, 3: 2, 2: 2, 1: 2 };
  const p = position(white, black, "white", "64");
  const after = rules.play(p, await bestMove(p, 2));
  assertEquals(after.off.white, 2);
});

Deno.test("enters from the bar onto the safe point", async () => {
  // 41 enters on black's 4-point (white's 21) or 1-point (white's 24, made).
  const p = position({ ...START, 24: 1, bar: 1 }, START, "white", "41");
  const move = await bestMove(p);
  assertEquals(move.steps[0], { from: 25, to: 24 });
});

Deno.test("searches to DEFAULT_MAX_DEPTH unless told otherwise", async () => {
  const p = position(START, START, "white", "62");
  const all = await search(p, {});
  assertEquals(all.map((a) => a.depth), [1, DEFAULT_MAX_DEPTH]);
  assertEquals((await search(p, { maxDepth: 1 })).length, 1);
  const lines = (await search(p, { maxDepth: 1, lines: 3 })).at(-1)!.lines;
  assertEquals(lines.length, 3);
});

Deno.test("a pending roll yields an expected Score and no Lines", async () => {
  const p = position(START, START, "white", "-");
  const [a] = await search(p, { maxDepth: 1 });
  assertEquals(a!.lines, []);
  assertEquals(a!.seat, "white");
  assert(a!.score?.kind === "value");
});

/** One Match from the opening roll; returns the winner or undefined if unfinished. */
async function playMatch(
  engineSeat: BackgammonSeat,
  rand: () => number,
  maxPlies = 400,
): Promise<BackgammonSeat | undefined> {
  let p = rules.initialPosition();
  for (let ply = 0; ply < maxPlies; ply++) {
    if (rules.outcome(p)) break;
    const seat = rules.toMove(p);
    if (seat === undefined) {
      // Roll the dice by their probabilities.
      let r = rand();
      const events = rules.chanceEvents(p);
      const event = events.find((e) => (r -= e.probability) < 0) ??
        events.at(-1)!;
      p = rules.resolveChance(p, event.chance);
    } else if (seat === engineSeat) {
      p = rules.play(p, await bestMove(p, 1));
    } else {
      const moves = rules.legalMoves(p);
      p = rules.play(p, moves[Math.floor(rand() * moves.length)]!);
    }
  }
  return rules.outcome(p)?.winner as BackgammonSeat | undefined;
}

Deno.test("beats a seeded random mover", async () => {
  const rand = seededRandom(17);
  const matches = 6;
  let wins = 0;
  for (let i = 0; i < matches; i++) {
    const seat = i % 2 === 0 ? "white" : "black";
    if (await playMatch(seat, rand) === seat) wins++;
  }
  assertEquals(wins, matches);
});

Deno.test("honours the Engine contract", async () => {
  await assertEngineContract(engine, rules, { positions: 4, maxDepth: 2 });
});
