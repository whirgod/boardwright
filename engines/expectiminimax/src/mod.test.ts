import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type {
  Analysis,
  ChanceGameRules,
  SearchLimits,
  Seat,
} from "@boardwright/core";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import {
  assertEngineContract,
  DICE_RACE_GOAL,
  diceRace,
  type DiceRacePosition,
  seededRandom,
} from "@boardwright/testing";
import { MATE_BOUND, terminalScore, toScore } from "@boardwright/engine-search";
import { createExpectiminimaxEngine } from "./mod.ts";

/**
 * A hand-written game tree with chance, for exact expected values. Positions
 * are node ids; `eval` is the horizon value from Seat "a"'s perspective.
 */
type Node =
  | {
    readonly seat: Seat;
    readonly moves: Readonly<Record<string, string>>;
    readonly eval?: number;
  }
  | {
    readonly chance: Readonly<Record<string, readonly [number, string]>>;
    readonly eval?: number;
  }
  | { readonly winner: Seat | null };

function treeGame(
  nodes: Readonly<Record<string, Node>>,
  root = "root",
): ChanceGameRules<string, string, string> {
  const node = (id: string): Node => {
    const n = nodes[id];
    if (n === undefined) throw new Error(`no node ${id}`);
    return n;
  };
  const rules: ChanceGameRules<string, string, string> = {
    id: "tree",
    name: "Tree",
    seats: ["a", "b"],
    initialPosition: () => root,
    toMove: (p) => {
      const n = node(p);
      return "seat" in n ? n.seat : undefined;
    },
    legalMoves: (p) => {
      const n = node(p);
      return "moves" in n ? Object.keys(n.moves) : [];
    },
    play(p, move) {
      const n = node(p);
      const to = "moves" in n ? n.moves[move] : undefined;
      if (to === undefined) throw new Error(`illegal ${move} in ${p}`);
      return to;
    },
    outcome(p) {
      const n = node(p);
      if (!("winner" in n)) return undefined;
      return n.winner === null
        ? { reason: "draw" }
        : { winner: n.winner, reason: "win" };
    },
    chanceEvents(p) {
      const n = node(p);
      if (!("chance" in n)) return [];
      return Object.entries(n.chance).map(([chance, [probability]]) => ({
        chance,
        probability,
      }));
    },
    resolveChance(p, chance) {
      const n = node(p);
      const to = "chance" in n ? n.chance[chance]?.[1] : undefined;
      if (to === undefined) throw new Error(`no chance ${chance} in ${p}`);
      return to;
    },
    notation: {
      encodePosition: (p) => p,
      decodePosition: (t) => (node(t), t),
      encodeMove: (m) => m,
      decodeMove: (t) => t,
      encodeChance: (c) => c,
      decodeChance: (t) => t,
    },
  };
  return rules;
}

/** Evaluation of a tree node from `seat`'s perspective. */
function treeEval(nodes: Readonly<Record<string, Node>>) {
  return (p: string, seat: Seat) => {
    const n = nodes[p]!;
    const v = "eval" in n && n.eval !== undefined ? n.eval : 0;
    return seat === "a" ? v : -v;
  };
}

function treeEngine(nodes: Readonly<Record<string, Node>>, root = "root") {
  return createExpectiminimaxEngine({
    rules: treeGame(nodes, root),
    evaluate: treeEval(nodes),
    name: "expectiminimax",
    winValue: 100,
  });
}

async function collect<Move>(
  it: AsyncIterable<Analysis<Move>>,
): Promise<Analysis<Move>[]> {
  const all: Analysis<Move>[] = [];
  for await (const a of it) all.push(a);
  return all;
}

const A_WINS: Node = { winner: "a" };
const B_WINS: Node = { winner: "b" };
const DRAW: Node = { winner: null };

/**
 * "a" chooses between two dice gambles; after the roll, "b" picks a reply.
 *
 *   L (eval 5):  1/4 -> X1 (b: x -> a wins, y -> draw)
 *                3/4 -> X2 (b: x -> b wins)
 *   R (eval -5): 1/2 -> X3 (b: x -> draw)
 *                1/2 -> X4 (b: x -> a wins)
 */
const GAMBLES: Record<string, Node> = {
  root: { seat: "a", moves: { L: "C1", R: "C2" } },
  C1: { chance: { r1: [0.25, "X1"], r2: [0.75, "X2"] }, eval: 5 },
  C2: { chance: { r1: [0.5, "X3"], r2: [0.5, "X4"] }, eval: -5 },
  X1: { seat: "b", moves: { x: "AW", y: "D" } },
  X2: { seat: "b", moves: { x: "BW" } },
  X3: { seat: "b", moves: { x: "D" } },
  X4: { seat: "b", moves: { x: "AW" } },
  AW: A_WINS,
  BW: B_WINS,
  D: DRAW,
};

Deno.test("engine identity", () => {
  const engine = treeEngine(GAMBLES);
  assertEquals(engine.gameId, "tree");
  assertEquals(engine.name, "expectiminimax");
});

Deno.test("a pending Chance event at the horizon is evaluated, not rolled", async () => {
  const [analysis] = await collect(
    treeEngine(GAMBLES).analyze("root", { maxDepth: 1, lines: 2 }),
  );
  // Depth 1 ends right after a's Move, before the roll: evaluate C1 / C2.
  assertEquals(analysis, {
    depth: 1,
    lines: [
      { moves: ["L"], score: { kind: "value", value: 5 } },
      { moves: ["R"], score: { kind: "value", value: -5 } },
    ],
  });
});

Deno.test("forced results mixed with others count as ±winValue (solved at depth 2)", async () => {
  const all = await collect(treeEngine(GAMBLES).analyze("root", { lines: 2 }));
  // Depth 2 reaches only Outcomes, so the search stops there.
  assertEquals(all.map((a) => a.depth), [1, 2]);
  // L: b draws in X1 (0), wins in X2: 1/4 * 0 + 3/4 * -100 = -75.
  // R: X3 is a draw (0), X4 a win for a: 1/2 * 0 + 1/2 * 100 = 50.
  assertEquals(all[1]!.lines, [
    { moves: ["R"], score: { kind: "value", value: 50 } },
    { moves: ["L"], score: { kind: "value", value: -75 } },
  ]);
});

Deno.test("win-in only when forced whatever the dice, counting the slowest", async () => {
  const nodes: Record<string, Node> = {
    root: { seat: "a", moves: { W: "C", S: "S" } },
    // Either roll wins: at once (ply 1) or after one more Move (ply 2).
    C: { chance: { r1: [0.5, "AW"], r2: [0.5, "Y"] } },
    Y: { seat: "a", moves: { w: "AW" } },
    // A safe draw.
    S: DRAW,
    AW: A_WINS,
  };
  const all = await collect(treeEngine(nodes).analyze("root", { lines: 2 }));
  assertEquals(all.at(-1)!.lines, [
    { moves: ["W"], score: { kind: "win-in", plies: 2 } },
    { moves: ["S"], score: { kind: "value", value: 0 } },
  ]);
});

Deno.test("loss-in when every roll loses, counting the slowest", async () => {
  const nodes: Record<string, Node> = {
    root: { seat: "a", moves: { m: "C" } },
    C: { chance: { r1: [0.5, "BW"], r2: [0.5, "Y"] } },
    Y: { seat: "b", moves: { w: "BW" } },
    BW: B_WINS,
  };
  const all = await collect(treeEngine(nodes).analyze("root", {}));
  assertEquals(all.at(-1)!.lines, [
    { moves: ["m"], score: { kind: "loss-in", plies: 2 } },
  ]);
});

Deno.test("Lines end at the next Chance event, also after several Moves", async () => {
  const nodes: Record<string, Node> = {
    // a moves twice in a row, then the dice decide.
    root: { seat: "a", moves: { p: "Z" } },
    Z: { seat: "a", moves: { q: "C" } },
    C: { chance: { r1: [0.5, "Y"], r2: [0.5, "Y"] }, eval: 3 },
    Y: { seat: "b", moves: { y: "D" } },
    D: DRAW,
  };
  const all = await collect(treeEngine(nodes).analyze("root", {}));
  assertEquals(all.map((a) => a.depth), [1, 2, 3]);
  assertEquals(all[1]!.lines, [
    { moves: ["p", "q"], score: { kind: "value", value: 3 } },
  ]);
  assertEquals(all[2]!.lines, [
    { moves: ["p", "q"], score: { kind: "value", value: 0 } },
  ]);
});

Deno.test("a pending Chance event yields its expected Score and no Lines", async () => {
  const nodes: Record<string, Node> = {
    root: { chance: { r1: [0.5, "A1"], r2: [0.5, "A2"] }, eval: 7 },
    A1: { seat: "a", moves: { m: "AW", n: "D" }, eval: 30 },
    A2: { seat: "a", moves: { m: "D" }, eval: -10 },
    AW: A_WINS,
    D: DRAW,
  };
  const all = await collect(treeEngine(nodes).analyze("root", {}));
  // Depth counts Moves: the roll is free, then one Move of "a" ends the tree.
  // 1/2 * 100 (forced win, mixed) + 1/2 * 0 = 50, from "a" (who moves next).
  assertEquals(all, [
    { depth: 1, lines: [], score: { kind: "value", value: 50 }, seat: "a" },
  ]);
});

Deno.test("a pending Chance event takes the first Seat's view when the mover depends on the roll", async () => {
  const nodes: Record<string, Node> = {
    root: { chance: { r1: [0.25, "A"], r2: [0.75, "B"] } },
    A: { seat: "a", moves: { m: "AW" }, eval: 1 },
    B: { seat: "b", moves: { m: "BW" }, eval: 1 },
    AW: A_WINS,
    BW: B_WINS,
  };
  const all = await collect(treeEngine(nodes).analyze("root", {}));
  // 1/4 * 100 + 3/4 * -100 = -50 for "a".
  assertEquals(all, [
    { depth: 1, lines: [], score: { kind: "value", value: -50 }, seat: "a" },
  ]);
});

const race = (
  a: number,
  b: number,
  turn: "a" | "b",
  roll: DiceRacePosition["roll"],
): DiceRacePosition => ({ a, b, turn, roll });

/** Progress difference from `seat`'s perspective. */
const raceEval = (p: DiceRacePosition, seat: Seat) =>
  seat === "a" ? p.a - p.b : p.b - p.a;

const raceEngine = createExpectiminimaxEngine({
  rules: diceRace,
  evaluate: raceEval,
  name: "expectiminimax",
  winValue: 100,
});

Deno.test("dice race: forced results through the dice", async () => {
  // a at 5 wins with any roll.
  assertEquals(await collect(raceEngine.analyze(race(5, 0, "a", null), {})), [
    { depth: 1, lines: [], score: { kind: "win-in", plies: 1 }, seat: "a" },
  ]);
  // a at 4 cannot reach the goal; then b, at 5, wins with any roll.
  const lost = await collect(raceEngine.analyze(race(4, 5, "a", 1), {}));
  assertEquals(lost.at(-1)!.lines[0]!.score, { kind: "loss-in", plies: 2 });
});

Deno.test("dice race: exact expected values per depth", async () => {
  // a at 3, b at 5, a to roll. A 3 (p 1/4) wins at once; a 1 or 2 leaves b,
  // at 5, to win with any roll.
  const all = await collect(raceEngine.analyze(race(3, 5, "a", null), {}));
  // Depth 1 evaluates after a's Move (progress difference, a's view):
  // 1/2 * (4 - 5) + 1/4 * (5 - 5) + 1/4 * 100 = 24.5.
  // Depth 2 is exact: 3/4 * -100 + 1/4 * 100 = -50.
  assertEquals(all, [
    { depth: 1, lines: [], score: { kind: "value", value: 24.5 }, seat: "a" },
    { depth: 2, lines: [], score: { kind: "value", value: -50 }, seat: "a" },
  ]);
});

Deno.test("dice race: Lines never continue past the next roll", async () => {
  const all = await collect(
    raceEngine.analyze(race(1, 1, "a", 2), { maxDepth: 4, lines: 2 }),
  );
  assertEquals(all.map((a) => a.depth), [1, 2, 3, 4]);
  for (const a of all) {
    // Both Moves are reported, and every Line stops at b's roll.
    assertEquals(a.lines.map((l) => l.moves.length), [1, 1]);
  }
});

/**
 * Plain expectiminimax without pruning, straight from the definition, as a
 * reference for the pruned search: value of `p` for `seat` with `depth` Moves
 * left, `ply` Moves after the root.
 */
function reference<P, M, C>(
  rules: ChanceGameRules<P, M, C>,
  evaluate: (p: P, seat: Seat) => number,
  winValue: number,
  p: P,
  seat: Seat,
  depth: number,
  ply: number,
): number {
  const ref = (q: P, s: Seat, d: number, pl: number) =>
    reference(rules, evaluate, winValue, q, s, d, pl);
  const outcome = rules.outcome(p);
  if (outcome) return terminalScore(outcome, seat, ply);
  if (depth === 0) {
    return Math.max(-winValue, Math.min(winValue, evaluate(p, seat)));
  }
  const mover = rules.toMove(p);
  if (mover === undefined) {
    const values = rules.chanceEvents(p).map(({ chance, probability }) => ({
      probability,
      v: ref(rules.resolveChance(p, chance), seat, depth, ply),
    }));
    if (values.every(({ v }) => v > MATE_BOUND)) {
      return Math.min(...values.map(({ v }) => v));
    }
    if (values.every(({ v }) => v < -MATE_BOUND)) {
      return Math.max(...values.map(({ v }) => v));
    }
    return values.reduce(
      (sum, { probability, v }) =>
        sum +
        probability *
          (v > MATE_BOUND ? winValue : v < -MATE_BOUND ? -winValue : v),
      0,
    );
  }
  const children = rules.legalMoves(p).map((m) =>
    ref(rules.play(p, m), mover, depth - 1, ply + 1)
  );
  const best = Math.max(...children);
  return mover === seat ? best : -best;
}

/**
 * Checks every Analysis of `position` against {@link reference}: each Line's
 * Score (multi-PV Lines are exact) and that the best Line is a best Move; a
 * pending Chance event's expected Score.
 */
async function assertMatchesReference<P, M, C>(
  rules: ChanceGameRules<P, M, C>,
  evaluate: (p: P, seat: Seat) => number,
  winValue: number,
  position: P,
  limits: SearchLimits,
): Promise<void> {
  const engine = createExpectiminimaxEngine({
    rules,
    evaluate,
    winValue,
    name: "pruned",
  });
  const where = `${rules.notation.encodePosition(position)} ${
    JSON.stringify(limits)
  }`;
  const ref = (q: P, s: Seat, d: number, pl: number) =>
    reference(rules, evaluate, winValue, q, s, d, pl);
  for (const a of await collect(engine.analyze(position, limits))) {
    const at = `${where} depth ${a.depth}`;
    const seat = rules.toMove(position);
    if (seat === undefined) {
      assertEquals(a.score, toScore(ref(position, a.seat!, a.depth, 0)), at);
      continue;
    }
    const best = Math.max(
      ...rules.legalMoves(position).map((m) =>
        ref(rules.play(position, m), seat, a.depth - 1, 1)
      ),
    );
    assertEquals(a.lines[0]!.score, toScore(best), `${at}: best Score`);
    for (const line of a.lines) {
      const want = ref(
        rules.play(position, line.moves[0]!),
        seat,
        a.depth - 1,
        1,
      );
      assertEquals(line.score, toScore(want), `${at}: Line ${line.moves[0]}`);
    }
  }
}

Deno.test("matches an unpruned reference on sampled dice races", async () => {
  for (const [a, b] of [[0, 0], [2, 3], [4, 1], [3, 4], [5, 2]] as const) {
    for (const turn of ["a", "b"] as const) {
      for (const roll of [1, 2, 3] as const) {
        for (const lines of [1, 2]) {
          await assertMatchesReference(
            diceRace,
            raceEval,
            100,
            race(a, b, turn, roll),
            { maxDepth: 4, lines },
          );
        }
      }
    }
  }
});

/**
 * A random game tree with chance, `height` levels deep: decision nodes (a
 * random Seat, so a Seat may move twice in a row or the Opponent reply
 * without a roll), Chance events with dyadic probabilities (exact sums),
 * terminal nodes, and small integer evaluations.
 */
function randomTree(seed: number, height: number): Record<string, Node> {
  const rand = seededRandom(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const nodes: Record<string, Node> = {};
  let next = 0;
  const grow = (level: number, allowChance: boolean): string => {
    const id = level === 0 ? "root" : `n${next++}`;
    const r = rand();
    const evaluation = Math.floor(rand() * 121) - 60;
    if (level === height || (level > 0 && r < 0.12)) {
      nodes[id] = { winner: pick(["a", "b", null] as const) };
    } else if (allowChance && r < 0.4) {
      const ps = pick([[0.5, 0.5], [0.25, 0.75], [0.25, 0.25, 0.5]]);
      const chance: Record<string, readonly [number, string]> = {};
      // Chance events never follow each other directly here.
      ps.forEach((p, i) => (chance[`r${i}`] = [p, grow(level + 1, false)]));
      nodes[id] = { chance, eval: evaluation };
    } else {
      const moves: Record<string, string> = {};
      const count = 2 + Math.floor(rand() * 3);
      for (let i = 0; i < count; i++) moves[`m${i}`] = grow(level + 1, true);
      nodes[id] = { seat: pick(["a", "b"]), moves, eval: evaluation };
    }
    return id;
  };
  grow(0, true);
  return nodes;
}

Deno.test("matches an unpruned reference on random trees with consecutive Moves", async () => {
  for (let seed = 1; seed <= 60; seed++) {
    const nodes = randomTree(seed, 6);
    for (
      const limits of [{ lines: 1 }, { lines: 1, maxDepth: 3 }, { lines: 2 }]
    ) {
      await assertMatchesReference(
        treeGame(nodes),
        treeEval(nodes),
        100,
        "root",
        limits,
      );
    }
  }
});

Deno.test("alpha-beta cuts off a refuted Move above Chance events", async () => {
  // a's M1 is worth 50. Against M2, b's first reply q1 already gives a only
  // -50 < 50, so b's second reply q2 (a sure win for a) is never searched.
  const nodes: Record<string, Node> = {
    root: { seat: "a", moves: { M1: "P", M2: "Q" } },
    P: { seat: "b", moves: { p: "CP" } },
    CP: { chance: { r1: [0.5, "D"], r2: [0.5, "AW"] } },
    Q: { seat: "b", moves: { q1: "CQ1", q2: "CQ2" } },
    CQ1: { chance: { r1: [0.5, "BW"], r2: [0.5, "D"] } },
    CQ2: { chance: { r1: [1, "AW"] } },
    AW: A_WINS,
    BW: B_WINS,
    D: DRAW,
  };
  const rules = treeGame(nodes);
  const visited = new Set<string>();
  const spy: ChanceGameRules<string, string, string> = {
    ...rules,
    outcome: (p) => {
      visited.add(p);
      return rules.outcome(p);
    },
  };
  const engine = createExpectiminimaxEngine({
    rules: spy,
    evaluate: treeEval(nodes),
    name: "spy",
    winValue: 100,
  });
  const all = await collect(engine.analyze("root", { lines: 1 }));
  assertEquals(all.at(-1)!.lines, [
    { moves: ["M1", "p"], score: { kind: "value", value: 50 } },
  ]);
  assert(visited.has("CQ1"), "q1 was searched");
  assert(!visited.has("CQ2"), "q2 should have been cut off");
  // With both Lines wanted, nothing is cut and M2 is exact: b plays q1.
  const both = await collect(
    createExpectiminimaxEngine({
      rules,
      evaluate: treeEval(nodes),
      name: "full",
      winValue: 100,
    }).analyze("root", { lines: 2 }),
  );
  assertEquals(both.at(-1)!.lines, [
    { moves: ["M1", "p"], score: { kind: "value", value: 50 } },
    { moves: ["M2", "q1"], score: { kind: "value", value: -50 } },
  ]);
});

Deno.test("a pending Position without chanceEvents is reported as a Game bug", async () => {
  const nodes: Record<string, Node> = {
    root: { seat: "a", moves: { m: "C" } },
    C: { chance: {} },
  };
  await assertRejects(
    () => collect(treeEngine(nodes).analyze("root", { maxDepth: 2 })),
    TypeError,
    "no chanceEvents in C",
  );
});

Deno.test("a terminal Position yields one empty Analysis", async () => {
  assertEquals(
    await collect(raceEngine.analyze(race(DICE_RACE_GOAL, 0, "b", null), {})),
    [{ depth: 0, lines: [] }],
  );
});

Deno.test("the horizon may be a pending Chance event, evaluated from the searching Seat", async () => {
  const seen: [string, Seat][] = [];
  const engine = createExpectiminimaxEngine({
    rules: diceRace,
    evaluate: (p, seat) => {
      seen.push([diceRace.notation.encodePosition(p), seat]);
      return raceEval(p, seat);
    },
    name: "probe",
    winValue: 100,
  });
  const [analysis] = await collect(
    engine.analyze(race(0, 0, "a", 3), { maxDepth: 1 }),
  );
  assertEquals(seen, [["3:0:b:-", "a"], ["1:0:b:-", "a"]]);
  assertEquals(analysis!.lines[0], {
    moves: ["f"],
    score: { kind: "value", value: 3 },
  });
});

Deno.test("clamps evaluations and rejects NaN", async () => {
  const huge = createExpectiminimaxEngine({
    rules: diceRace,
    evaluate: () => 1e15,
    name: "huge",
    winValue: 100,
  });
  const [a] = await collect(huge.analyze(race(0, 0, "a", null), {
    maxDepth: 1,
  }));
  assertEquals(a!.score, { kind: "value", value: 100 });
  const nan = createExpectiminimaxEngine({
    rules: diceRace,
    evaluate: () => NaN,
    name: "nan",
    winValue: 100,
  });
  let thrown: unknown;
  try {
    await collect(nan.analyze(race(0, 0, "a", null), { maxDepth: 1 }));
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof TypeError, `expected a TypeError, got ${thrown}`);
});

Deno.test("rejects invalid limits and options", () => {
  const bad: SearchLimits[] = [{ maxDepth: 0 }, { maxTimeMs: -1 }, {
    lines: 0,
  }];
  for (const limits of bad) {
    assertThrows(
      () => raceEngine.analyze(diceRace.initialPosition(), limits),
      RangeError,
    );
  }
  for (const winValue of [0, -1, NaN, 1e9]) {
    assertThrows(
      () =>
        createExpectiminimaxEngine({
          rules: diceRace,
          evaluate: () => 0,
          name: "x",
          winValue,
        }),
      RangeError,
    );
  }
});

Deno.test("refuses Games without chance (ADR 0005)", () => {
  assertThrows(
    () =>
      createExpectiminimaxEngine({
        rules: ticTacToe as unknown as ChanceGameRules<unknown, unknown, never>,
        evaluate: () => 0,
        name: "x",
        winValue: 1,
      }),
    TypeError,
    "tic-tac-toe",
  );
});

Deno.test("a time limit stops an unbounded search after depth 1", async () => {
  const start = performance.now();
  const all = await collect(
    raceEngine.analyze(diceRace.initialPosition(), { maxTimeMs: 30 }),
  );
  assert(all.length >= 1);
  assert(performance.now() - start < 1000, "search overran its time limit");
});

Deno.test("honours the Engine contract", async () => {
  await assertEngineContract(raceEngine, diceRace);
});
