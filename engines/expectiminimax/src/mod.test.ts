import { assert, assertEquals, assertThrows } from "@std/assert";
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
function reference(
  p: DiceRacePosition,
  seat: Seat,
  depth: number,
  ply: number,
): number {
  const outcome = diceRace.outcome(p);
  if (outcome) return terminalScore(outcome, seat, ply);
  if (depth === 0) return raceEval(p, seat);
  const mover = diceRace.toMove(p);
  if (mover === undefined) {
    const values = diceRace.chanceEvents(p).map(({ chance, probability }) => ({
      probability,
      v: reference(diceRace.resolveChance(p, chance), seat, depth, ply),
    }));
    if (values.every(({ v }) => v > MATE_BOUND)) {
      return Math.min(...values.map(({ v }) => v));
    }
    if (values.every(({ v }) => v < -MATE_BOUND)) {
      return Math.max(...values.map(({ v }) => v));
    }
    return values.reduce(
      (sum, { probability, v }) =>
        sum + probability * (v > MATE_BOUND ? 100 : v < -MATE_BOUND ? -100 : v),
      0,
    );
  }
  const children = diceRace.legalMoves(p).map((m) =>
    reference(diceRace.play(p, m), mover, depth - 1, ply + 1)
  );
  const best = Math.max(...children);
  return mover === seat ? best : -best;
}

Deno.test("matches an unpruned reference on sampled dice races", async () => {
  for (const [a, b] of [[0, 0], [2, 3], [4, 1], [3, 4], [5, 2]] as const) {
    for (const turn of ["a", "b"] as const) {
      for (const roll of [1, 2, 3] as const) {
        const p = race(a, b, turn, roll);
        const all = await collect(
          raceEngine.analyze(p, { maxDepth: 4, lines: 2 }),
        );
        const last = all.at(-1)!;
        for (const line of last.lines) {
          const next = diceRace.play(p, line.moves[0]!);
          const want = reference(next, turn, last.depth - 1, 1);
          assertEquals(line.score, toScore(want), `${a}:${b}:${turn}:${roll}`);
        }
      }
    }
  }
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
  });
  const [a] = await collect(huge.analyze(race(0, 0, "a", null), {
    maxDepth: 1,
  }));
  assertEquals(a!.score, { kind: "value", value: 1e8 });
  const nan = createExpectiminimaxEngine({
    rules: diceRace,
    evaluate: () => NaN,
    name: "nan",
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
