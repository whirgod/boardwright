import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type Analysis,
  type ChanceGameRules,
  chancePending,
  type Engine,
  type GameRules,
  hasChance,
  type SearchLimits,
} from "@boardwright/core";
import {
  assertChanceGameRulesContract,
  assertEngineContract,
  assertGameRulesContract,
  diceRace,
  type DiceRaceMove,
  type DiceRacePosition,
  type DiceRaceRoll,
} from "./mod.ts";

type Rules = ChanceGameRules<DiceRacePosition, DiceRaceMove, DiceRaceRoll>;

/** Run the kit against a broken variant of the dice race and expect `message`. */
function expectFailure(patch: Partial<Rules>, message: string) {
  const broken: Rules = { ...diceRace, ...patch };
  const err = assertThrows(() =>
    assertChanceGameRulesContract(broken, { playouts: 20 })
  );
  const text = (err as Error).message;
  if (!text.includes(message) || !text.includes("seed=")) {
    throw new Error(`expected "${message}" (with seed) in: ${text}`);
  }
}

Deno.test("hasChance and chancePending tell Games with chance apart", () => {
  assertEquals(hasChance(diceRace), true);
  const { chanceEvents: _c, resolveChance: _r, ...plain } = diceRace;
  assertEquals(hasChance(plain as GameRules<unknown, unknown>), false);
  const start = diceRace.initialPosition();
  assertEquals(chancePending(diceRace, start), true);
  const rolled = diceRace.resolveChance(start, 2);
  assertEquals(chancePending(diceRace, rolled), false);
  assertEquals(
    chancePending(plain as GameRules<DiceRacePosition, DiceRaceMove>, start),
    false,
  );
});

Deno.test("chance contract: passes for the dice race", () => {
  assertChanceGameRulesContract(diceRace);
});

Deno.test("chance contract: kits refuse the wrong kind of Game", () => {
  assertThrows(
    () => assertGameRulesContract(diceRace),
    Error,
    "use assertChanceGameRulesContract",
  );
  const { chanceEvents: _c, ...plain } = diceRace;
  assertThrows(
    () => assertChanceGameRulesContract(plain as unknown as Rules),
    Error,
    "is not a ChanceGameRules",
  );
});

Deno.test("chance contract: detects probabilities not summing to 1", () => {
  expectFailure({
    chanceEvents: (p) =>
      diceRace.chanceEvents(p).map((e) => ({ ...e, probability: 0.3 })),
  }, "sum to");
});

Deno.test("chance contract: detects probabilities out of range", () => {
  expectFailure({
    chanceEvents: (p) =>
      diceRace.chanceEvents(p).map((e, i) => ({
        ...e,
        probability: i === 0 ? 0 : e.probability,
      })),
  }, "not in (0, 1]");
});

Deno.test("chance contract: detects a pending Chance event without results", () => {
  expectFailure({
    toMove: (p) =>
      diceRace.outcome(p) ? undefined : p.roll ? p.turn : undefined,
    chanceEvents: () => [],
  }, "has no results");
});

Deno.test("chance contract: detects legal Moves while a Chance event is pending", () => {
  expectFailure({ legalMoves: () => ["f"] }, "pending Chance event has legal");
});

Deno.test("chance contract: detects results that do not encode uniquely", () => {
  expectFailure({
    notation: { ...diceRace.notation, encodeChance: () => "1" },
  }, "encode uniquely");
});

Deno.test("chance contract: detects a broken chance round trip", () => {
  expectFailure({
    notation: {
      ...diceRace.notation,
      decodeChance(text, p) {
        diceRace.notation.decodeChance(text, p); // still rejects garbage
        return 1;
      },
    },
  }, "chance round trip");
});

Deno.test("chance contract: detects decodeChance accepting garbage", () => {
  expectFailure({
    notation: { ...diceRace.notation, decodeChance: () => 2 },
  }, "accepted garbage");
});

Deno.test("chance contract: detects resolveChance mutating its input", () => {
  expectFailure({
    resolveChance(p, roll) {
      const next = diceRace.resolveChance(p, roll);
      (p as { roll: number | null }).roll = roll;
      return next;
    },
  }, "mutated");
});

Deno.test("chance contract: detects results listed when nothing is pending", () => {
  expectFailure({
    chanceEvents: (p) =>
      diceRace.outcome(p) ? [] : [{ chance: 1, probability: 1 }],
  }, "chanceEvents is not empty");
});

Deno.test("chance contract: detects resolveChance accepting a result when nothing is pending", () => {
  expectFailure({
    resolveChance: (p, roll) => ({ ...p, roll }),
  }, "resolveChance accepted");
});

Deno.test("chance contract: detects unstable chanceEvents", () => {
  let flip = 0;
  expectFailure({
    chanceEvents: (p) =>
      diceRace.chanceEvents(p).map((e) => ({
        ...e,
        probability: e.probability + (flip++ % 2 === 0 ? 0 : 1e-12),
      })),
  }, "chanceEvents is not stable");
});

Deno.test("chance contract: detects non-deterministic replay through Chance events", () => {
  let calls = 0;
  expectFailure({
    resolveChance(p, roll) {
      const next = diceRace.resolveChance(p, roll);
      // Every so often, the same roll leads elsewhere.
      return ++calls % 97 === 0
        ? { ...next, turn: next.turn === "a" ? "b" : "a" }
        : next;
    },
  }, "replay diverged");
});

Deno.test("chance contract: detects resolveChance accepting a result that is not offered", () => {
  // B's die only ever shows 1, but resolveChance takes any roll while pending.
  expectFailure({
    chanceEvents: (p) =>
      diceRace.chanceEvents(p).length > 0 && p.turn === "b"
        ? [{ chance: 1, probability: 1 }]
        : diceRace.chanceEvents(p),
    resolveChance(p, roll) {
      if (diceRace.chanceEvents(p).length === 0) throw new Error("not pending");
      return { ...p, roll };
    },
  }, "which is not offered");
});

Deno.test("chance contract: detects results listed at a terminal Position", () => {
  expectFailure({
    chanceEvents: (p) =>
      diceRace.outcome(p)
        ? [{ chance: 1, probability: 1 }]
        : diceRace.chanceEvents(p),
  }, "chanceEvents is not empty");
});

Deno.test("chance contract: fails when no playout meets a Chance event", () => {
  // Starts already rolled and never rolls again: plays like a Game without chance.
  expectFailure({
    initialPosition: () => ({ a: 0, b: 0, turn: "a", roll: 1 }),
    play(p, move) {
      const next = diceRace.play(p, move);
      return { ...next, roll: 1 };
    },
  }, "no playout reached a Chance event");
});

// --- Engine contract for Games with chance ---------------------------------

type ChanceBug =
  | "lines-while-pending"
  | "no-score"
  | "past-chance"
  | "no-seat"
  | "bad-seat"
  | "score-with-lines";

/** A trivial Engine for the dice race: "f" first, one depth. */
function diceEngine(bug?: ChanceBug): Engine<DiceRacePosition, DiceRaceMove> {
  async function* run(
    position: DiceRacePosition,
    limits: SearchLimits,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<Analysis<DiceRaceMove>> {
    if (diceRace.outcome(position)) {
      yield { depth: 0, lines: [] };
      return;
    }
    if (signal?.aborted) return;
    await new Promise((r) => setTimeout(r, 1));
    if (signal?.aborted) return;
    const value = position.a - position.b;
    const score = { kind: "value", value } as const;
    if (chancePending(diceRace, position)) {
      yield bug === "lines-while-pending"
        ? {
          depth: 1,
          lines: [{ moves: ["f"], score }],
          score,
          seat: "a",
        }
        : bug === "no-score"
        ? { depth: 1, lines: [] }
        : bug === "no-seat"
        ? { depth: 1, lines: [], score }
        : { depth: 1, lines: [], score, seat: bug === "bad-seat" ? "c" : "a" };
      return;
    }
    const moves: DiceRaceMove[] = bug === "past-chance" ? ["f", "f"] : ["f"];
    const lines = [{ moves, score }];
    if ((limits.lines ?? 1) > 1) lines.push({ moves: ["1"], score });
    yield bug === "score-with-lines"
      ? { depth: 1, lines, score, seat: "a" }
      : { depth: 1, lines };
  }
  return {
    name: "dice",
    gameId: diceRace.id,
    analyze(position, limits, signal) {
      const { maxDepth, maxTimeMs, lines } = limits;
      if (
        (maxDepth !== undefined &&
          !(Number.isInteger(maxDepth) && maxDepth >= 1)) ||
        (maxTimeMs !== undefined && !(maxTimeMs >= 0)) ||
        (lines !== undefined && !(Number.isInteger(lines) && lines >= 1))
      ) {
        throw new RangeError("bad limits");
      }
      return run(position, limits, signal);
    },
  };
}

Deno.test("engine contract: accepts expected-Score Analysis while a Chance event is pending", async () => {
  await assertEngineContract(diceEngine(), diceRace);
});

Deno.test("engine contract: catches Lines while a Chance event is pending", async () => {
  await assertRejects(
    () => assertEngineContract(diceEngine("lines-while-pending"), diceRace),
    Error,
    "has no Lines",
  );
});

Deno.test("engine contract: catches a pending Chance event without expected score", async () => {
  await assertRejects(
    () => assertEngineContract(diceEngine("no-score"), diceRace),
    Error,
    "needs an expected score",
  );
});

Deno.test("engine contract: catches a Line continuing past a Chance event", async () => {
  await assertRejects(
    () => assertEngineContract(diceEngine("past-chance"), diceRace),
    Error,
    "continues past a Chance event",
  );
});

Deno.test("engine contract: catches an expected score without its seat", async () => {
  await assertRejects(
    () => assertEngineContract(diceEngine("no-seat"), diceRace),
    Error,
    "seat must be present exactly when score is",
  );
});

Deno.test("engine contract: catches a seat that is not a Seat of the Game", async () => {
  await assertRejects(
    () => assertEngineContract(diceEngine("bad-seat"), diceRace),
    Error,
    "is not one of the Game's Seats",
  );
});

Deno.test("engine contract: catches a score where a Seat is to move", async () => {
  await assertRejects(
    () => assertEngineContract(diceEngine("score-with-lines"), diceRace),
    Error,
    "score is only for a pending Chance event",
  );
});
