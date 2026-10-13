import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { Analysis } from "@boardwright/core";
import {
  createNodeCounter,
  horizonScore,
  type Iteration,
  iterativeDeepening,
  MATE,
  MAX_EVALUATION,
  NODES_PER_TICK,
  rankRootMoves,
  type Result,
  type Search,
  terminalScore,
  toLines,
  toScore,
  validateLimits,
} from "./mod.ts";

/** Runs a Search to completion, ignoring its yields. */
function run<T>(search: Search<T>): T {
  for (;;) {
    const step = search.next();
    if (step.done) return step.value;
  }
}

async function collect<Move>(
  it: AsyncIterable<Analysis<Move>>,
): Promise<number[]> {
  const depths: number[] = [];
  for await (const a of it) depths.push(a.depth);
  return depths;
}

/** A depth search that yields `ticks` times and reports `solved` at `solvedAt`. */
function fakeDepth(
  solvedAt = Infinity,
  ticks = 0,
): (depth: number) => Search<Iteration<string>> {
  return function* (depth) {
    for (let i = 0; i < ticks; i++) yield;
    return {
      analysis: { depth, lines: [] },
      solved: depth >= solvedAt,
    };
  };
}

Deno.test("validateLimits accepts valid limits and rejects invalid ones", () => {
  validateLimits({});
  validateLimits({ maxDepth: 1, maxTimeMs: 0, lines: 3 });
  for (
    const bad of [
      { maxDepth: 0 },
      { maxDepth: 1.5 },
      { maxDepth: NaN },
      { maxTimeMs: -1 },
      { maxTimeMs: NaN },
      { lines: 0 },
      { lines: 2.5 },
    ]
  ) {
    assertThrows(() => validateLimits(bad), RangeError);
  }
});

Deno.test("the score scale round-trips forced results and values", () => {
  assertEquals(terminalScore({ winner: "a", reason: "r" }, "a", 3), MATE - 3);
  assertEquals(
    terminalScore({ winner: "a", reason: "r" }, "b", 3),
    -(MATE - 3),
  );
  assertEquals(terminalScore({ reason: "draw" }, "a", 3), 0);
  assertEquals(toScore(MATE - 3), { kind: "win-in", plies: 3 });
  assertEquals(toScore(-(MATE - 5)), { kind: "loss-in", plies: 5 });
  assertEquals(toScore(-0), { kind: "value", value: 0 });
  assertEquals(toScore(42.5), { kind: "value", value: 42.5 });
});

Deno.test("horizonScore clamps evaluations and rejects NaN", () => {
  assertEquals(horizonScore(1e12, () => "p"), MAX_EVALUATION);
  assertEquals(horizonScore(-1e12, () => "p"), -MAX_EVALUATION);
  assertEquals(horizonScore(7, () => "p"), 7);
  assertThrows(() => horizonScore(NaN, () => "pos"), TypeError, "pos");
});

Deno.test("the node counter asks for a yield every NODES_PER_TICK nodes", () => {
  const counter = createNodeCounter();
  let due = 0;
  for (let i = 0; i < NODES_PER_TICK * 3; i++) if (counter.visit()) due++;
  assertEquals(due, 3);
});

Deno.test("rankRootMoves keeps the best n exact, ties in order", () => {
  const scores: Record<string, number> = { a: 1, b: 5, c: 5, d: 3, e: 0 };
  const alphas: number[] = [];
  const results = run(
    rankRootMoves(["a", "b", "c", "d", "e"], 2, function* (move, alpha) {
      alphas.push(alpha);
      yield;
      return { score: scores[move]!, pv: [`${move}'`] } as Result<string>;
    }),
  );
  assertEquals(results.map((r) => r.pv[0]), ["b", "c", "d", "a", "e"]);
  // The best two keep their PVs; the rest only their first Move.
  assertEquals(results[0]!.pv, ["b", "b'"]);
  assertEquals(results[1]!.pv, ["c", "c'"]);
  assertEquals(results[2]!.pv, ["d"]);
  // alpha is the current 2nd best once there are two.
  assertEquals(alphas, [-Infinity, -Infinity, 1, 5, 5]);
  assertEquals(toLines(results, 2), [
    { moves: ["b", "b'"], score: { kind: "value", value: 5 } },
    { moves: ["c", "c'"], score: { kind: "value", value: 5 } },
  ]);
});

Deno.test("iterativeDeepening stops at maxDepth or once solved", async () => {
  assertEquals(
    await collect(iterativeDeepening({ maxDepth: 3 }, undefined, fakeDepth())),
    [1, 2, 3],
  );
  assertEquals(
    await collect(iterativeDeepening({}, undefined, fakeDepth(2))),
    [1, 2],
  );
});

Deno.test("iterativeDeepening honours abort and time limits", async () => {
  const aborted = new AbortController();
  aborted.abort();
  assertEquals(
    await collect(iterativeDeepening({}, aborted.signal, fakeDepth())),
    [],
  );
  // maxTimeMs 0 still completes depth 1, then stops.
  assertEquals(
    await collect(iterativeDeepening({ maxTimeMs: 0 }, undefined, fakeDepth())),
    [1],
  );
  // Aborting mid-depth discards that depth.
  const controller = new AbortController();
  const slow = function* (depth: number): Search<Iteration<string>> {
    if (depth === 2) controller.abort();
    yield;
    return { analysis: { depth, lines: [] }, solved: false };
  };
  assertEquals(
    await collect(iterativeDeepening({}, controller.signal, slow)),
    [1],
  );
});

Deno.test("iterativeDeepening gives the event loop a turn during long depths", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  // One endless depth: only the abort observed at a breath can stop it.
  const endless = function* (): Search<Iteration<string>> {
    for (;;) yield;
  };
  assertEquals(
    await collect(iterativeDeepening({}, controller.signal, endless)),
    [],
  );
});

Deno.test("iterativeDeepening propagates search errors", async () => {
  // deno-lint-ignore require-yield
  const broken = function* (): Search<Iteration<string>> {
    throw new TypeError("boom");
  };
  await assertRejects(
    () => collect(iterativeDeepening({}, undefined, broken)),
    TypeError,
    "boom",
  );
});
