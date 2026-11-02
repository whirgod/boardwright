import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type {
  Analysis,
  ChanceGameRules,
  Score,
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
import { createExpectiminimaxEngine, DEFAULT_TABLE_BYTES } from "./mod.ts";

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

function treeEngine(
  nodes: Readonly<Record<string, Node>>,
  tableBytes = DEFAULT_TABLE_BYTES,
) {
  return createExpectiminimaxEngine({
    rules: treeGame(nodes),
    evaluate: treeEval(nodes),
    name: "expectiminimax",
    winValue: 100,
    tableBytes,
  });
}

async function collect<Move>(
  it: AsyncIterable<Analysis<Move>>,
): Promise<Analysis<Move>[]> {
  const all: Analysis<Move>[] = [];
  for await (const a of it) all.push(a);
  return all;
}

/**
 * A table budget with exactly one slot (and room for one entry with a short
 * key): every Position shares it, so entries are replaced all the time.
 */
const ONE_SLOT = 300;
/** Table budgets the search must give the same results with. */
const BUDGETS = [
  ["default", DEFAULT_TABLE_BYTES],
  ["one slot", ONE_SLOT],
  ["none", 0],
] as const;

/** Registers test `name` once per table budget in {@link BUDGETS}. */
function testEachBudget(
  name: string,
  fn: (tableBytes: number) => Promise<void>,
) {
  for (const [label, tableBytes] of BUDGETS) {
    Deno.test(`${name} (table: ${label})`, () => fn(tableBytes));
  }
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

testEachBudget(
  "a pending Chance event at the horizon is evaluated, not rolled",
  async (tableBytes) => {
    const [analysis] = await collect(
      treeEngine(GAMBLES, tableBytes).analyze("root", {
        maxDepth: 1,
        lines: 2,
      }),
    );
    // Depth 1 ends right after a's Move, before the roll: evaluate C1 / C2.
    assertEquals(analysis, {
      depth: 1,
      lines: [
        { moves: ["L"], score: { kind: "value", value: 5 } },
        { moves: ["R"], score: { kind: "value", value: -5 } },
      ],
    });
  },
);

testEachBudget(
  "forced results mixed with others count as ±winValue (solved at depth 2)",
  async (tableBytes) => {
    const all = await collect(
      treeEngine(GAMBLES, tableBytes).analyze("root", { lines: 2 }),
    );
    // Depth 2 reaches only Outcomes, so the search stops there.
    assertEquals(all.map((a) => a.depth), [1, 2]);
    // L: b draws in X1 (0), wins in X2: 1/4 * 0 + 3/4 * -100 = -75.
    // R: X3 is a draw (0), X4 a win for a: 1/2 * 0 + 1/2 * 100 = 50.
    assertEquals(all[1]!.lines, [
      { moves: ["R"], score: { kind: "value", value: 50 } },
      { moves: ["L"], score: { kind: "value", value: -75 } },
    ]);
  },
);

testEachBudget(
  "win-in only when forced whatever the dice, counting the slowest",
  async (tableBytes) => {
    const nodes: Record<string, Node> = {
      root: { seat: "a", moves: { W: "C", S: "S" } },
      // Either roll wins: at once (ply 1) or after one more Move (ply 2).
      C: { chance: { r1: [0.5, "AW"], r2: [0.5, "Y"] } },
      Y: { seat: "a", moves: { w: "AW" } },
      // A safe draw.
      S: DRAW,
      AW: A_WINS,
    };
    const all = await collect(
      treeEngine(nodes, tableBytes).analyze("root", { lines: 2 }),
    );
    assertEquals(all.at(-1)!.lines, [
      { moves: ["W"], score: { kind: "win-in", plies: 2 } },
      { moves: ["S"], score: { kind: "value", value: 0 } },
    ]);
  },
);

testEachBudget(
  "loss-in when every roll loses, counting the slowest",
  async (tableBytes) => {
    const nodes: Record<string, Node> = {
      root: { seat: "a", moves: { m: "C" } },
      C: { chance: { r1: [0.5, "BW"], r2: [0.5, "Y"] } },
      Y: { seat: "b", moves: { w: "BW" } },
      BW: B_WINS,
    };
    const all = await collect(
      treeEngine(nodes, tableBytes).analyze("root", {}),
    );
    assertEquals(all.at(-1)!.lines, [
      { moves: ["m"], score: { kind: "loss-in", plies: 2 } },
    ]);
  },
);

testEachBudget(
  "Lines end at the next Chance event, also after several Moves",
  async (tableBytes) => {
    const nodes: Record<string, Node> = {
      // a moves twice in a row, then the dice decide.
      root: { seat: "a", moves: { p: "Z" } },
      Z: { seat: "a", moves: { q: "C" } },
      C: { chance: { r1: [0.5, "Y"], r2: [0.5, "Y"] }, eval: 3 },
      Y: { seat: "b", moves: { y: "D" } },
      D: DRAW,
    };
    const all = await collect(
      treeEngine(nodes, tableBytes).analyze("root", {}),
    );
    assertEquals(all.map((a) => a.depth), [1, 2, 3]);
    assertEquals(all[1]!.lines, [
      { moves: ["p", "q"], score: { kind: "value", value: 3 } },
    ]);
    assertEquals(all[2]!.lines, [
      { moves: ["p", "q"], score: { kind: "value", value: 0 } },
    ]);
  },
);

testEachBudget(
  "a pending Chance event yields its expected Score and no Lines",
  async (tableBytes) => {
    const nodes: Record<string, Node> = {
      root: { chance: { r1: [0.5, "A1"], r2: [0.5, "A2"] }, eval: 7 },
      A1: { seat: "a", moves: { m: "AW", n: "D" }, eval: 30 },
      A2: { seat: "a", moves: { m: "D" }, eval: -10 },
      AW: A_WINS,
      D: DRAW,
    };
    const all = await collect(
      treeEngine(nodes, tableBytes).analyze("root", {}),
    );
    // Depth counts Moves: the roll is free, then one Move of "a" ends the tree.
    // 1/2 * 100 (forced win, mixed) + 1/2 * 0 = 50, from "a" (who moves next).
    assertEquals(all, [
      { depth: 1, lines: [], score: { kind: "value", value: 50 }, seat: "a" },
    ]);
  },
);

testEachBudget(
  "a pending Chance event takes the first Seat's view when the mover depends on the roll",
  async (tableBytes) => {
    const nodes: Record<string, Node> = {
      root: { chance: { r1: [0.25, "A"], r2: [0.75, "B"] } },
      A: { seat: "a", moves: { m: "AW" }, eval: 1 },
      B: { seat: "b", moves: { m: "BW" }, eval: 1 },
      AW: A_WINS,
      BW: B_WINS,
    };
    const all = await collect(
      treeEngine(nodes, tableBytes).analyze("root", {}),
    );
    // 1/4 * 100 + 3/4 * -100 = -50 for "a".
    assertEquals(all, [
      { depth: 1, lines: [], score: { kind: "value", value: -50 }, seat: "a" },
    ]);
  },
);

const race = (
  a: number,
  b: number,
  turn: "a" | "b",
  roll: DiceRacePosition["roll"],
): DiceRacePosition => ({ a, b, turn, roll });

/** Progress difference from `seat`'s perspective. */
const raceEval = (p: DiceRacePosition, seat: Seat) =>
  seat === "a" ? p.a - p.b : p.b - p.a;

const raceEngineWith = (tableBytes: number) =>
  createExpectiminimaxEngine({
    rules: diceRace,
    evaluate: raceEval,
    name: "expectiminimax",
    winValue: 100,
    tableBytes,
  });
const raceEngine = raceEngineWith(DEFAULT_TABLE_BYTES);

testEachBudget(
  "dice race: forced results through the dice",
  async (tableBytes) => {
    // a at 5 wins with any roll.
    assertEquals(
      await collect(
        raceEngineWith(tableBytes).analyze(race(5, 0, "a", null), {}),
      ),
      [
        { depth: 1, lines: [], score: { kind: "win-in", plies: 1 }, seat: "a" },
      ],
    );
    // a at 4 cannot reach the goal; then b, at 5, wins with any roll.
    const lost = await collect(
      raceEngineWith(tableBytes).analyze(race(4, 5, "a", 1), {}),
    );
    assertEquals(lost.at(-1)!.lines[0]!.score, { kind: "loss-in", plies: 2 });
  },
);

testEachBudget(
  "dice race: exact expected values per depth",
  async (tableBytes) => {
    // a at 3, b at 5, a to roll. A 3 (p 1/4) wins at once; a 1 or 2 leaves b,
    // at 5, to win with any roll.
    const all = await collect(
      raceEngineWith(tableBytes).analyze(race(3, 5, "a", null), {}),
    );
    // Depth 1 evaluates after a's Move (progress difference, a's view):
    // 1/2 * (4 - 5) + 1/4 * (5 - 5) + 1/4 * 100 = 24.5.
    // Depth 2 is exact: 3/4 * -100 + 1/4 * 100 = -50.
    assertEquals(all, [
      { depth: 1, lines: [], score: { kind: "value", value: 24.5 }, seat: "a" },
      { depth: 2, lines: [], score: { kind: "value", value: -50 }, seat: "a" },
    ]);
  },
);

testEachBudget(
  "dice race: Lines never continue past the next roll",
  async (tableBytes) => {
    const all = await collect(
      raceEngineWith(tableBytes).analyze(race(1, 1, "a", 2), {
        maxDepth: 4,
        lines: 2,
      }),
    );
    assertEquals(all.map((a) => a.depth), [1, 2, 3, 4]);
    for (const a of all) {
      // Both Moves are reported, and every Line stops at b's roll.
      assertEquals(a.lines.map((l) => l.moves.length), [1, 1]);
    }
  },
);

/**
 * Plain expectiminimax without pruning, straight from the definition, as a
 * reference for the pruned search: value of `p` for `seat` with `depth` Moves
 * left (Infinity: exhaustive), `ply` Moves after the root. With `memo`, each
 * (Position, Seat, depth, ply) is valued once, so a Game on a graph can be
 * searched exhaustively.
 */
function reference<P, M, C>(
  rules: ChanceGameRules<P, M, C>,
  evaluate: (p: P, seat: Seat) => number,
  winValue: number,
  p: P,
  seat: Seat,
  depth: number,
  ply: number,
  memo?: Map<string, number>,
): number {
  const key = memo &&
    `${rules.notation.encodePosition(p)} ${seat} ${depth} ${ply}`;
  const known = key === undefined ? undefined : memo!.get(key);
  if (known !== undefined) return known;
  const v = referenceOf(rules, evaluate, winValue, p, seat, depth, ply, memo);
  if (key !== undefined) memo!.set(key, v);
  return v;
}

function referenceOf<P, M, C>(
  rules: ChanceGameRules<P, M, C>,
  evaluate: (p: P, seat: Seat) => number,
  winValue: number,
  p: P,
  seat: Seat,
  depth: number,
  ply: number,
  memo: Map<string, number> | undefined,
): number {
  const ref = (q: P, s: Seat, d: number, pl: number) =>
    reference(rules, evaluate, winValue, q, s, d, pl, memo);
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
  tableBytes = DEFAULT_TABLE_BYTES,
): Promise<void> {
  const engine = createExpectiminimaxEngine({
    rules,
    evaluate,
    winValue,
    name: "pruned",
    tableBytes,
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

testEachBudget(
  "matches an unpruned reference on sampled dice races",
  async (tableBytes) => {
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
              tableBytes,
            );
          }
        }
      }
    }
  },
);

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

testEachBudget(
  "matches an unpruned reference on random trees with consecutive Moves",
  async (tableBytes) => {
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
          tableBytes,
        );
      }
    }
  },
);

/**
 * An endless Game with chance: a coin is tossed (`x` or `y`) before every
 * third Move; Seats alternate and each has the Moves 0-4. A Position is the
 * list of Moves and tosses, so it never repeats.
 */
type TripleItem = number | "x" | "y";
const tripleMoves = (p: readonly TripleItem[]) =>
  p.filter((i): i is number => typeof i === "number");
const triple: ChanceGameRules<readonly TripleItem[], number, "x" | "y"> = {
  id: "triple",
  name: "Triple",
  seats: ["a", "b"],
  initialPosition: () => [],
  toMove(p) {
    const moves = tripleMoves(p).length;
    if (moves % 3 === 0 && typeof (p.at(-1) ?? 0) === "number") {
      return undefined; // the coin is due
    }
    return moves % 2 === 0 ? "a" : "b";
  },
  legalMoves: (p) => (triple.toMove(p) ? [0, 1, 2, 3, 4] : []),
  play: (p, m) => [...p, m],
  outcome: () => undefined,
  chanceEvents: (p) =>
    triple.toMove(p)
      ? []
      : [{ chance: "x", probability: 0.5 }, { chance: "y", probability: 0.5 }],
  resolveChance: (p, c) => [...p, c],
  notation: {
    encodePosition: (p) => p.join(""),
    decodePosition: (t) =>
      [...t].map((c) => (c === "x" || c === "y" ? c : Number(c))),
    encodeMove: String,
    decodeMove: Number,
    encodeChance: String,
    decodeChance: (t) => (t === "x" ? "x" : "y"),
  },
};

Deno.test("hash Moves from the previous depth save nodes", async () => {
  // `seat`'s Moves minus the other Seat's: the largest Move is best at every
  // depth, but the Game lists it last.
  const sum = (p: readonly TripleItem[], seat: Seat) =>
    tripleMoves(p).reduce((s, m, i) => s + (i % 2 === 0 ? m : -m), 0) *
    (seat === "a" ? 1 : -1);
  /** Nodes (Moves played) to search `triple` to depth 6. */
  async function nodes(tableBytes: number) {
    let played = 0;
    const counting = {
      ...triple,
      play: (p: readonly TripleItem[], m: number) => (
        played++, triple.play(p, m)
      ),
    };
    const e = createExpectiminimaxEngine({
      rules: counting,
      name: "t",
      evaluate: sum,
      winValue: 100,
      tableBytes,
    });
    const all = await collect(e.analyze(["x"], { maxDepth: 6 }));
    // The Line ends at the next coin toss.
    assertEquals(all.at(-1)!.lines[0]!.moves, [4, 4, 4]);
    return played;
  }
  const withTable = await nodes(DEFAULT_TABLE_BYTES);
  const withoutTable = await nodes(0); // a budget of 0 stores nothing
  assert(withTable < withoutTable / 4, `${withTable} vs ${withoutTable}`);
});

testEachBudget(
  "alpha-beta cuts off a refuted Move above Chance events",
  async (tableBytes) => {
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
      tableBytes,
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
        tableBytes,
      }).analyze("root", { lines: 2 }),
    );
    assertEquals(both.at(-1)!.lines, [
      { moves: ["M1", "p"], score: { kind: "value", value: 50 } },
      { moves: ["M2", "q1"], score: { kind: "value", value: -50 } },
    ]);
  },
);

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

testEachBudget(
  "a terminal Position yields one empty Analysis",
  async (tableBytes) => {
    assertEquals(
      await collect(
        raceEngineWith(tableBytes).analyze(
          race(DICE_RACE_GOAL, 0, "b", null),
          {},
        ),
      ),
      [{ depth: 0, lines: [] }],
    );
  },
);

testEachBudget(
  "the horizon may be a pending Chance event, evaluated from the searching Seat",
  async (tableBytes) => {
    const seen: [string, Seat][] = [];
    const engine = createExpectiminimaxEngine({
      rules: diceRace,
      evaluate: (p, seat) => {
        seen.push([diceRace.notation.encodePosition(p), seat]);
        return raceEval(p, seat);
      },
      name: "probe",
      winValue: 100,
      tableBytes,
    });
    const [analysis] = await collect(
      engine.analyze(race(0, 0, "a", 3), { maxDepth: 1 }),
    );
    assertEquals(seen, [["3:0:b:-", "a"], ["1:0:b:-", "a"]]);
    assertEquals(analysis!.lines[0], {
      moves: ["f"],
      score: { kind: "value", value: 3 },
    });
  },
);

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
  for (const tableBytes of [-1, 1.5, NaN, Infinity, 2 ** 32 + 1]) {
    assertThrows(
      () =>
        createExpectiminimaxEngine({
          rules: diceRace,
          evaluate: () => 0,
          name: "x",
          winValue: 1,
          tableBytes,
        }),
      RangeError,
      "tableBytes",
    );
  }
});

Deno.test("a stored Move index out of range counts as no hash Move", async () => {
  // Breaks the key requirement on purpose: "three" and "one" share a key but
  // not their Moves. "three" is searched first and stores its best Move,
  // index 2; "one" has a single Move.
  const nodes: Record<string, Node> = {
    root: { seat: "a", moves: { three: "T", one: "O" } },
    T: { seat: "b", moves: { t1: "D", t2: "D", t3: "BW" } },
    O: { seat: "b", moves: { o1: "D" } },
    D: DRAW,
    BW: B_WINS,
  };
  const tree = treeGame(nodes);
  const shared = (p: string) => (p === "T" || p === "O" ? "shared" : p);
  const rules = {
    ...tree,
    notation: { ...tree.notation, encodePosition: shared },
  };
  const e = createExpectiminimaxEngine({
    rules,
    evaluate: treeEval(nodes),
    name: "broken key",
    winValue: 100,
  });
  const all = await collect(e.analyze("root", { lines: 2 }));
  assertEquals(all.at(-1)!.lines, [
    { moves: ["one", "o1"], score: { kind: "value", value: 0 } },
    { moves: ["three", "t3"], score: { kind: "loss-in", plies: 2 } },
  ]);
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

// --- Transposition table ---------------------------------------------------

/** A table budget with three slots: Positions share them, entries are replaced. */
const THREE_SLOTS = 600;

/** Replays a Line; `play` throws if any Move is illegal. */
function replay<P, M>(
  rules: ChanceGameRules<P, M, unknown>,
  position: P,
  moves: readonly M[],
): P {
  return moves.reduce((p, m) => rules.play(p, m), position);
}

/**
 * A random Game with chance on a directed acyclic graph of `size` nodes
 * ("root", "1", "2", ...; the last 6 are terminal): decision nodes with a
 * random Seat to move and, with probability about `chanceShare`, Chance
 * events with 2-3 results, each Move or result leading to one of the next
 * few nodes (a Move is named after it).
 * Paths of different lengths meet at the same node: Positions recur at
 * different plies, and Chance events are reached from either Seat's
 * perspective. Evaluations are random, so horizons mislead.
 */
function randomChanceGraph(
  seed: number,
  size: number,
  chanceShare: number,
): Record<string, Node> {
  const random = seededRandom(seed);
  const name = (i: number) => (i === 0 ? "root" : String(i));
  const nodes: Record<string, Node> = {};
  for (let i = 0; i < size; i++) {
    const r = random();
    if (i >= size - 6) {
      nodes[name(i)] = { winner: r < 0.4 ? "a" : r < 0.8 ? "b" : null };
      continue;
    }
    const evaluation = Math.round(random() * 120 - 60);
    const targets = new Set<string>();
    const count = 1 + Math.floor(random() * 3);
    for (let k = 0; k < count; k++) {
      targets.add(
        name(i + 1 + Math.floor(random() * Math.min(4, size - 1 - i))),
      );
    }
    if (r < chanceShare && targets.size >= 2) {
      const ps = targets.size === 2 ? [0.5, 0.5] : [0.25, 0.25, 0.5];
      const chance: Record<string, readonly [number, string]> = {};
      [...targets].forEach((t, k) => (chance[`r${t}`] = [ps[k]!, t]));
      nodes[name(i)] = { chance, eval: evaluation };
    } else {
      const moves: Record<string, string> = {};
      for (const t of targets) moves[`m${t}`] = t;
      const seat = random() < 0.5 ? "a" : "b";
      nodes[name(i)] = { seat, moves, eval: evaluation };
    }
  }
  return nodes;
}

/**
 * Asserts that `score`, found by a search to some depth, is `exact` if the
 * search was `solved`. Otherwise, where a plain search of that depth finds a
 * forced result (`plain`), it is that result: every branch it rests on ends
 * within the horizon, and stored deeper results only add to what the search
 * sees. Where the plain search finds a value, a forced result must be real,
 * but it may be slower than the exact one: a stored result from a deeper
 * search lets the depth see past its horizon on one path, while a faster
 * result one Move past the horizon on another path waits for the next depth
 * (with chance also a roll at the horizon that wins whatever the dice, as a
 * pending Chance event is evaluated there, not rolled).
 */
function assertScore(
  score: Score | undefined,
  exact: number,
  plain: number,
  solved: boolean,
  where: string,
) {
  const want = toScore(exact);
  if (solved) return assertEquals(score, want, where);
  if (Math.abs(plain) > MATE_BOUND) {
    return assertEquals(score, toScore(plain), `${where} (plain search)`);
  }
  if (score === undefined || score.kind === "value") return;
  assertEquals(want.kind, score.kind, where);
  assert(want.kind !== "value" && want.plies <= score.plies, where);
}

/**
 * Checks Analysis `a` of `root` against `value` (of a Position for a Seat,
 * searching a number of Moves, Infinity: exhaustive, a number of Moves after
 * the root): every Score against the exhaustive value if the search was
 * `solved` (it ran without limits), else the forced results, against a plain
 * search of `a`'s depth too ({@link assertScore}). In a solved search every Line is complete: it ends
 * at an Outcome or at the next Chance event, and a forced result's plies
 * count its Moves.
 */
function assertExact<P, M, C>(
  rules: ChanceGameRules<P, M, C>,
  value: (p: P, seat: Seat, depth: number, ply: number) => number,
  root: P,
  a: Analysis<M>,
  label: string,
  solved: boolean,
) {
  const seat = rules.toMove(root);
  if (seat === undefined) {
    assertEquals(a.lines, [], label);
    const [exact, plain] = [Infinity, a.depth].map((d) =>
      value(root, a.seat!, d, 0)
    );
    assertScore(a.score, exact!, plain!, solved, label);
    return;
  }
  const values = rules.legalMoves(root).map((m) =>
    value(rules.play(root, m), seat, Infinity, 1)
  );
  if (solved) {
    assertEquals(a.lines[0]!.score, toScore(Math.max(...values)), label);
  }
  for (const line of a.lines) {
    const where = `${label}: ${line.moves.map(rules.notation.encodeMove)}`;
    const next = rules.play(root, line.moves[0]!);
    const exact = value(next, seat, Infinity, 1);
    const plain = value(next, seat, a.depth - 1, 1);
    assertScore(line.score, exact, plain, solved, where);
    if (!solved) continue;
    const end = replay(rules, root, line.moves);
    const outcome = rules.outcome(end);
    assert(
      outcome !== undefined || rules.toMove(end) === undefined,
      `${where}: the Line stops before the next Chance event`,
    );
    if (line.score.kind !== "value") {
      if (outcome) assertEquals(line.moves.length, line.score.plies, where);
      else assert(line.moves.length <= line.score.plies, where);
    }
  }
}

Deno.test("transpositions at different plies and perspectives keep results and mate distances exact", async () => {
  for (let seed = 1; seed <= 60; seed++) {
    // Few Chance events leave long runs of decision nodes, where narrow
    // windows make stored bounds matter; many put more Chance events at
    // transpositions.
    const nodes = randomChanceGraph(seed, 32, [0.1, 0.25, 0.4][seed % 3]!);
    const rules = treeGame(nodes);
    const evaluate = treeEval(nodes);
    const memo = new Map<string, number>();
    const value = (p: string, seat: Seat, depth: number, ply: number) =>
      reference(rules, evaluate, 100, p, seat, depth, ply, memo);
    const budgets = [DEFAULT_TABLE_BYTES, THREE_SLOTS, ONE_SLOT, 0];
    for (const tableBytes of budgets) {
      const e = createExpectiminimaxEngine({
        rules,
        evaluate,
        name: "graph",
        winValue: 100,
        tableBytes,
      });
      for (const root of ["root", "1", "2", "3"]) {
        if (rules.outcome(root)) continue;
        const count = rules.legalMoves(root).length;
        for (const lines of new Set([1, Math.max(count, 1)])) {
          const label =
            `seed ${seed} from ${root} tableBytes ${tableBytes} lines ${lines}`;
          const all = await collect(e.analyze(root, { lines }));
          all.forEach((a, i) =>
            assertExact(
              rules,
              value,
              root,
              a,
              `${label} depth ${a.depth}`,
              i === all.length - 1,
            )
          );
          // Depth-limited: the forced results found so far are real, and
          // those a plain search of that depth finds are exact.
          for (const maxDepth of [2, 4]) {
            const [a] = (await collect(e.analyze(root, { maxDepth, lines })))
              .slice(-1);
            assertExact(
              rules,
              value,
              root,
              a!,
              `${label} max ${maxDepth}`,
              false,
            );
          }
        }
      }
    }
  }
});

/**
 * A random Game with chance on a layered graph: layer k holds the Positions
 * after k Moves, `width` decision nodes (random Seat to move, 1-3 Moves into
 * layer k + 1, sometimes terminal) and `chances` Chance events (1-3 results
 * among layer k's decision nodes, as a roll is no Move). Paths meet only at
 * the same ply, so each depth is exactly a plain search of that depth, while
 * transpositions bring the same Position with different windows and from
 * either Seat's perspective.
 */
function layeredGraph(
  seed: number,
  layers: number,
  width: number,
  chances: number,
): Record<string, Node> {
  const random = seededRandom(seed);
  const pick = <T>(xs: readonly T[]): T =>
    xs[Math.floor(random() * xs.length)]!;
  const some = (xs: readonly string[], max: number) => {
    const chosen = new Set<string>();
    const count = 1 + Math.floor(random() * max);
    for (let k = 0; k < count; k++) chosen.add(pick(xs));
    return [...chosen];
  };
  const decisions = (k: number) =>
    Array.from({ length: width }, (_, i) => `d${k}.${i}`);
  const chanceEvents = (k: number) =>
    Array.from({ length: chances }, (_, i) => `c${k}.${i}`);
  const nodes: Record<string, Node> = {};
  for (let k = 0; k <= layers; k++) {
    const next = [...decisions(k + 1), ...chanceEvents(k + 1)];
    for (const id of decisions(k)) {
      const r = random();
      const evaluation = Math.round(random() * 120 - 60);
      if (k === layers || (k > 0 && r < 0.1)) {
        nodes[id] = { winner: pick(["a", "b", null] as const) };
        continue;
      }
      const moves: Record<string, string> = {};
      for (const t of some(next, 3)) moves[`m${t}`] = t;
      nodes[id] = { seat: pick(["a", "b"]), moves, eval: evaluation };
    }
    for (const id of chanceEvents(k)) {
      const results = some(decisions(k), 3);
      const ps = [[1], [0.5, 0.5], [0.25, 0.25, 0.5]][results.length - 1]!;
      const chance: Record<string, readonly [number, string]> = {};
      results.forEach((t, i) => (chance[`r${t}`] = [ps[i]!, t]));
      nodes[id] = { chance, eval: Math.round(random() * 120 - 60) };
    }
  }
  nodes.root = nodes["d0.0"]!;
  return nodes;
}

Deno.test("matches an unpruned reference at every depth on layered graphs with transpositions", async () => {
  // Stored bounds go wrong only now and then: many small Games, with 0-2
  // Chance events per layer (fewer leave longer runs of decision nodes).
  for (let seed = 1; seed <= 300; seed++) {
    const nodes = layeredGraph(seed, 8, 6, seed % 3);
    for (const tableBytes of [DEFAULT_TABLE_BYTES, THREE_SLOTS, ONE_SLOT]) {
      for (const limits of [{ lines: 1 }, { lines: 2 }]) {
        await assertMatchesReference(
          treeGame(nodes),
          treeEval(nodes),
          100,
          "root",
          limits,
          tableBytes,
        );
      }
    }
  }
});

/**
 * An evaluation that is not zero-sum: an independent random value per
 * (Position, Seat), so `evaluate(p, "a")` is not `-evaluate(p, "b")`.
 */
function lopsidedEval(nodes: Readonly<Record<string, Node>>, seed: number) {
  const random = seededRandom(seed);
  const values = new Map<string, number>();
  for (const id of Object.keys(nodes).sort()) {
    for (const seat of ["a", "b"]) {
      values.set(`${id} ${seat}`, Math.round(random() * 120 - 60));
    }
  }
  return (p: string, seat: Seat) => values.get(`${p} ${seat}`)!;
}

Deno.test("a Chance event's stored value needs no zero-sum evaluation", async () => {
  // The table stores a Chance event's value for one Seat and negates it for
  // the other. That holds for any evaluation, as no horizon below a Chance
  // event is evaluated for the Seat whose perspective it is valued from:
  // the plain search agrees at every depth, from Chance and decision roots.
  for (let seed = 1; seed <= 100; seed++) {
    const nodes = layeredGraph(seed, 8, 6, 1 + (seed % 2));
    const rules = treeGame(nodes);
    const evaluate = lopsidedEval(nodes, seed);
    for (const root of ["root", "c1.0", "d1.1", "c2.0"]) {
      if (rules.outcome(root)) continue;
      for (const tableBytes of [DEFAULT_TABLE_BYTES, THREE_SLOTS, ONE_SLOT]) {
        for (const limits of [{ lines: 1 }, { lines: 2 }]) {
          await assertMatchesReference(
            rules,
            evaluate,
            100,
            root,
            limits,
            tableBytes,
          );
        }
      }
    }
  }
});

Deno.test("forced results through a Chance event keep their distance at another ply", async () => {
  // C is a win for a whatever the dice: at once, or after one more Move. It
  // is reached at ply 1 (direct) and at ply 2 (detour). Depth 2 solves and
  // stores it from ply 1; depth 3 reuses it at ply 2.
  const nodes: Record<string, Node> = {
    root: { seat: "a", moves: { detour: "D", direct: "C" } },
    D: { seat: "a", moves: { d: "C" } },
    C: { chance: { r1: [0.5, "AW"], r2: [0.5, "Y"] } },
    Y: { seat: "a", moves: { y: "AW" } },
    AW: A_WINS,
  };
  for (const [label, tableBytes] of BUDGETS) {
    const all = await collect(
      treeEngine(nodes, tableBytes).analyze("root", { lines: 2 }),
    );
    assertEquals(all.at(-1), {
      depth: 3,
      lines: [
        { moves: ["direct"], score: { kind: "win-in", plies: 2 } },
        { moves: ["detour", "d"], score: { kind: "win-in", plies: 3 } },
      ],
    }, label);
  }
});

Deno.test("a stored result that hit the horizon keeps a depth from being solved", async () => {
  // Only a moves. "draw" ends level at once; "detour" and "direct" reach x,
  // which takes 3 more Moves to end (a loses) and looks bad (-5) at the
  // horizon; x is reached at ply 2 via "detour" (searched first) and at
  // ply 1 via "direct". Depth 3 searches x at ply 1 for 2 Moves and stores
  // the result. Depth 4 reaches x first at ply 2, needing 2 Moves: the
  // stored result answers (x cannot beat the draw), so x is not searched
  // there. Then x at ply 1 is searched to its end. Depth 4 evaluates
  // nothing, yet it is not solved: the stored result hit the horizon.
  const chain = (x: Node): Record<string, Node> => ({
    root: { seat: "a", moves: { draw: "DRAW", detour: "D", direct: "X" } },
    DRAW: DRAW,
    D: { seat: "a", moves: { d: "X" }, eval: -5 },
    X: x,
    X1: { seat: "a", moves: { x1: "X2" }, eval: -5 },
    X2: { seat: "a", moves: { x2: "X3" }, eval: -5 },
    X3: { seat: "a", moves: { x3: "LOST" }, eval: -5 },
    LOST: B_WINS,
  });
  const cases = {
    // x is a decision node: a cutoff by its stored upper bound.
    decision: chain({ seat: "a", moves: { x: "X2" }, eval: -5 }),
    // x is a Chance event: its stored expected value answers.
    chance: chain({ chance: { r: [1, "X1"] }, eval: -5 }),
  };
  for (const [kind, nodes] of Object.entries(cases)) {
    let evaluations = 0;
    const evaluate = treeEval(nodes);
    const engine = createExpectiminimaxEngine({
      rules: treeGame(nodes),
      evaluate: (p, seat) => (evaluations++, evaluate(p, seat)),
      name: "chain",
      winValue: 100,
    });
    const perDepth: number[] = [];
    for await (const _ of engine.analyze("root", {})) {
      perDepth.push(evaluations);
      evaluations = 0;
    }
    assertEquals(perDepth.length, 5, kind);
    assertEquals(perDepth[3], 0, kind);
  }
});

/**
 * Seat `me` moves at the root: "mine" rolls the dice at once (C), "theirs"
 * lets the other Seat choose between rolling them (C) and a draw. C is
 * worth 50 to `me` (a win or a draw) and so -50 to the other Seat, who
 * draws instead.
 */
function perspectiveTree(me: Seat, other: Seat): Record<string, Node> {
  return {
    root: { seat: me, moves: { mine: "C", theirs: "T" } },
    T: { seat: other, moves: { c: "C", d: "DRAW" } },
    C: { chance: { r1: [0.5, "WIN"], r2: [0.5, "E"] } },
    E: { seat: me, moves: { e: "DRAW" } },
    WIN: { winner: me },
    DRAW: DRAW,
  };
}

Deno.test("a Chance event's stored value is negated for the other Seat", async () => {
  // Depth 2 solves C for `me` (via "mine") and stores it; depth 3 reuses it
  // for the other Seat (via "theirs"). With "a" as `me`, the table holds a's
  // value and b reads it; with "b", b's value is stored for a to read.
  for (const [me, other] of [["a", "b"], ["b", "a"]] as const) {
    for (const [label, tableBytes] of BUDGETS) {
      const all = await collect(
        treeEngine(perspectiveTree(me, other), tableBytes).analyze("root", {
          lines: 2,
        }),
      );
      assertEquals(all.at(-1), {
        depth: 3,
        lines: [
          { moves: ["mine"], score: { kind: "value", value: 50 } },
          { moves: ["theirs", "d"], score: { kind: "value", value: 0 } },
        ],
      }, `${me} ${label}`);
    }
  }
});
