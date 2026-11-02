import { assert, assertEquals, assertThrows } from "@std/assert";
import type {
  Analysis,
  Engine,
  GameRules,
  Score,
  SearchLimits,
  Seat,
} from "@boardwright/core";
import { MAX_EVALUATION } from "@boardwright/engine-search";
import {
  ticTacToe as ttt,
  type TicTacToePosition,
} from "@boardwright/game-tic-tac-toe";
import { assertEngineContract, seededRandom } from "@boardwright/testing";
import {
  createMinimaxEngine,
  DEFAULT_QUIESCENCE_PLIES,
  type MinimaxOptions,
  type Quiescence,
} from "./mod.ts";
import { quiescenceMoves } from "./quiescence.ts";

// --- Helpers ---------------------------------------------------------------

async function collect<M>(
  iterable: AsyncIterable<Analysis<M>>,
): Promise<Analysis<M>[]> {
  const all: Analysis<M>[] = [];
  for await (const a of iterable) all.push(a);
  return all;
}

async function final<P, M>(
  e: Engine<P, M>,
  position: P,
  limits: SearchLimits = {},
): Promise<Analysis<M>> {
  const all = await collect(e.analyze(position, limits));
  assert(all.length > 0, "no Analysis yielded");
  return all.at(-1)!;
}

/** Orders Scores like the search: a win `p` plies away is 1000 - p. */
function rank(score: Score): number {
  switch (score.kind) {
    case "win-in":
      return 1000 - score.plies;
    case "loss-in":
      return -1000 + score.plies;
    case "value":
      return score.value;
  }
}

/** Replays a Line; `play` throws if any Move is illegal. */
function replay<P, M>(rules: GameRules<P, M>, p: P, moves: readonly M[]): P {
  return moves.reduce((q, m) => rules.play(q, m), p);
}

/** Counts the Moves the search plays (its nodes). */
function counting<P, M>(rules: GameRules<P, M>) {
  const count = { nodes: 0 };
  const counted: GameRules<P, M> = {
    ...rules,
    play: (p, m) => (count.nodes++, rules.play(p, m)),
  };
  return { rules: counted, count };
}

interface GraphNode {
  /** The Seat to move; a node without `moves` is terminal. */
  readonly seat?: Seat;
  /** The nodes it leads to; a name starting with "x" is a capture. */
  readonly moves?: readonly string[];
  /** Winner of a terminal node; none is a draw. */
  readonly winner?: Seat;
  /** Evaluation for the Seat to move (default 0). */
  readonly value?: number;
  /** The Seat to move may not stand pat (like a chess Seat in check). */
  readonly check?: boolean;
}

/**
 * A Game on a directed graph: a Position is a node, a Move the node it
 * leads to. Every node has its own Seat to move. Captures (Moves to nodes
 * named "x...") are tactical; `check` nodes refuse stand pat.
 */
function graphGame(nodes: Readonly<Record<string, GraphNode>>) {
  const node = (p: string) => {
    const n = nodes[p];
    if (!n) throw new Error(`no node ${p}`);
    return n;
  };
  const rules: GameRules<string, string> = {
    id: "graph",
    name: "Graph",
    seats: ["a", "b"],
    initialPosition: () => "root",
    toMove: (p) => (node(p).moves ? node(p).seat : undefined),
    legalMoves: (p) => node(p).moves ?? [],
    play: (_, m) => m,
    outcome: (p) =>
      node(p).moves
        ? undefined
        : { reason: "end", ...(node(p).winner && { winner: node(p).winner }) },
    notation: {
      encodePosition: String,
      decodePosition: String,
      encodeMove: String,
      decodeMove: String,
    },
  };
  return {
    rules,
    evaluate: (p: string) => node(p).value ?? 0,
    movePriority: (_p: string, m: string) => (m.startsWith("x") ? 1 : 0),
    quiescence: {
      standPat: (p: string) => !node(p).check,
    } as Quiescence<string, string>,
  };
}

/** An engine over `graphGame(nodes)`: plain, or with its quiescence. */
function graphEngine(
  nodes: Readonly<Record<string, GraphNode>>,
  withQuiescence: boolean,
  extra: Partial<MinimaxOptions<string, string>> = {},
) {
  const g = graphGame(nodes);
  return createMinimaxEngine({
    rules: g.rules,
    evaluate: g.evaluate,
    movePriority: g.movePriority,
    name: "graph",
    ...(withQuiescence ? { quiescence: g.quiescence } : {}),
    ...extra,
  });
}

// --- quiescenceMoves -------------------------------------------------------

const MOVES = ["a", "xb", "c", "xd", "e"] as const;
const PRIORITY: Record<string, number> = { a: 0, xb: 1, c: -1, xd: 5, e: 2 };
const byPriority = (_p: null, m: string) => PRIORITY[m]!;
const capture = (_p: null, m: string) => m.startsWith("x");

Deno.test("quiescenceMoves: without stand pat, every Move, by priority", () => {
  assertEquals(
    quiescenceMoves(null, MOVES, true, capture, byPriority, []),
    ["xd", "e", "xb", "a", "c"],
  );
  assertEquals(
    quiescenceMoves(null, MOVES, true, undefined, undefined, []),
    MOVES,
  );
});

Deno.test("quiescenceMoves: with stand pat, the tactical Moves", () => {
  // By default those ranked above 0, by priority.
  assertEquals(
    quiescenceMoves(null, MOVES, false, undefined, byPriority, []),
    ["xd", "e", "xb"],
  );
  // An explicit test, ordered by priority if there is one.
  assertEquals(
    quiescenceMoves(null, MOVES, false, capture, byPriority, []),
    ["xd", "xb"],
  );
  assertEquals(
    quiescenceMoves(null, MOVES, false, capture, undefined, []),
    ["xb", "xd"],
  );
  // Neither: no Move is tactical.
  assertEquals(
    quiescenceMoves(null, MOVES, false, undefined, undefined, []),
    [],
  );
  // All priorities equal (and > 0): every Move, in the Game's order.
  assertEquals(
    quiescenceMoves(null, MOVES, false, undefined, () => 3, []),
    MOVES,
  );
});

Deno.test("quiescenceMoves: a priority that is not finite is a RangeError", () => {
  assertThrows(
    () => quiescenceMoves(null, MOVES, false, undefined, () => NaN, []),
    RangeError,
    "finite",
  );
});

Deno.test("rejects an invalid quiescence.maxPlies", () => {
  for (const maxPlies of [-1, 1.5, NaN, Infinity]) {
    assertThrows(
      () =>
        createMinimaxEngine({
          rules: ttt,
          evaluate: () => 0,
          name: "m",
          quiescence: { standPat: () => true, maxPlies },
        }),
      RangeError,
      "quiescence.maxPlies",
    );
  }
});

// --- The horizon effect ----------------------------------------------------

// a can grab material (a capture) at the horizon of depth 1, but b recaptures
// more; the quiet Move keeps the balance.
const GRAB: Record<string, GraphNode> = {
  root: { seat: "a", moves: ["quiet", "xgrab"] },
  quiet: { seat: "b", moves: ["end"] },
  // b to move: a is a pawn up.
  xgrab: { seat: "b", moves: ["xrecapture", "end"], value: -1 },
  // a to move: b won the queen back.
  xrecapture: { seat: "a", moves: ["end"], value: -8 },
  end: {},
};

Deno.test("quiescence fixes the horizon effect: a capture that loses to a recapture", async () => {
  const plain = await final(graphEngine(GRAB, false), "root", {
    maxDepth: 1,
    lines: 2,
  });
  assertEquals(plain.lines[0], {
    moves: ["xgrab"],
    score: { kind: "value", value: 1 },
  });
  const quiet = await final(graphEngine(GRAB, true), "root", {
    maxDepth: 1,
    lines: 2,
  });
  // The Lines include the quiescence Moves, beyond the nominal depth 1.
  assertEquals(quiet.lines, [
    { moves: ["quiet"], score: { kind: "value", value: 0 } },
    { moves: ["xgrab", "xrecapture"], score: { kind: "value", value: -8 } },
  ]);
  assertEquals(quiet.depth, 1);
});

Deno.test("an explicit tactical test replaces movePriority > 0", async () => {
  const g = graphGame(GRAB);
  // The priority marks nothing tactical; the test marks the captures.
  const e = createMinimaxEngine({
    rules: g.rules,
    evaluate: g.evaluate,
    movePriority: () => 0,
    name: "g",
    quiescence: {
      standPat: () => true,
      tactical: (_p, m) => m.startsWith("x"),
    },
  });
  const a = await final(e, "root", { maxDepth: 1 });
  assertEquals(a.lines[0]!.moves, ["quiet"]);
  // Without movePriority and without a test, nothing is tactical.
  const none = createMinimaxEngine({
    rules: g.rules,
    evaluate: g.evaluate,
    name: "g",
    quiescence: { standPat: () => true },
  });
  const b = await final(none, "root", { maxDepth: 1 });
  assertEquals(b.lines[0]!.moves, ["xgrab"]);
});

// --- Stand pat ---------------------------------------------------------------

// "check" looks bad for a statically (b is fine), but b may not stand pat
// there, and both of b's (quiet) replies lose.
const CHECK: Record<string, GraphNode> = {
  root: { seat: "a", moves: ["safe", "check"] },
  safe: { seat: "b", moves: ["end"] },
  check: { seat: "b", moves: ["e1", "e2"], value: 5, check: true },
  e1: { seat: "a", moves: ["end"], value: 4 },
  e2: { seat: "a", moves: ["end"], value: 6 },
  end: {},
};

Deno.test("stand pat is refused where the Engine says so: every Move is searched", async () => {
  const asked: string[] = [];
  const g = graphGame(CHECK);
  const e = createMinimaxEngine({
    rules: g.rules,
    evaluate: g.evaluate,
    name: "g",
    quiescence: {
      standPat: (p) => (asked.push(p), g.quiescence.standPat(p)),
    },
  });
  const a = await final(e, "root", { maxDepth: 1 });
  assertEquals(a.lines[0], {
    moves: ["check", "e1"],
    score: { kind: "value", value: 4 },
  });
  // Asked once per quiescence node, never for the root or a terminal node.
  assertEquals(asked.sort(), ["check", "e1", "e2", "safe"]);
  // Where stand pat is allowed, b stands pat after "check".
  const lax = createMinimaxEngine({
    rules: g.rules,
    evaluate: g.evaluate,
    name: "g",
    quiescence: { standPat: () => true },
  });
  const b = await final(lax, "root", { maxDepth: 1 });
  assertEquals(b.lines[0], {
    moves: ["safe"],
    score: { kind: "value", value: 0 },
  });
});

Deno.test("a Seat moving twice in a row keeps its perspective in quiescence", async () => {
  // After "xa", a moves again (a stand pat of 3 for a), and may capture on.
  const e = graphEngine({
    root: { seat: "a", moves: ["quiet", "xa"] },
    quiet: { seat: "b", moves: ["end"], value: -2 },
    xa: { seat: "a", moves: ["xb", "end"], value: 3 },
    xb: { seat: "b", moves: ["end"], value: -7 },
    end: {},
  }, true);
  const a = await final(e, "root", { maxDepth: 1 });
  assertEquals(a.lines[0], {
    moves: ["xa", "xb"],
    score: { kind: "value", value: 7 },
  });
});

Deno.test("stand pat never yields a forced result: evaluations are clamped", async () => {
  const e = graphEngine({
    root: { seat: "a", moves: ["xa"] },
    xa: { seat: "b", moves: ["end"], value: -Infinity },
    end: {},
  }, true);
  const a = await final(e, "root", { maxDepth: 1 });
  assertEquals(a.lines[0]!.score, { kind: "value", value: MAX_EVALUATION });
});

// --- Forced results and `solved` -----------------------------------------

// a's capture checks b; every reply lets a capture into a win. a's other Move
// leads to a draw. With `refuse`, no node past the horizon allows stand pat.
function mateNodes(refuse: boolean): Record<string, GraphNode> {
  return {
    root: { seat: "a", moves: ["quiet", "xcheck"] },
    quiet: { seat: "b", moves: ["draw"], check: refuse },
    draw: {},
    xcheck: { seat: "b", moves: ["r1", "r2"], value: 3, check: true },
    r1: { seat: "a", moves: ["xmate1", "z"], check: refuse },
    r2: { seat: "a", moves: ["xmate2", "z"], check: refuse },
    xmate1: { winner: "a" },
    xmate2: { winner: "a" },
    z: {},
  };
}

Deno.test("a forced win found in quiescence counts its plies from the root", async () => {
  const plain = await final(graphEngine(mateNodes(false), false), "root", {
    maxDepth: 1,
  });
  assertEquals(plain.lines[0]!.score, { kind: "value", value: 0 });
  const e = graphEngine(mateNodes(false), true);
  const a = await final(e, "root", { maxDepth: 1, lines: 2 });
  assertEquals(a.depth, 1);
  assertEquals(a.lines, [
    {
      moves: ["xcheck", "r1", "xmate1"],
      score: { kind: "win-in", plies: 3 },
    },
    { moves: ["quiet"], score: { kind: "value", value: 0 } },
  ]);
  // From b's side after the capture: lost in 2.
  const b = await final(e, "xcheck", { maxDepth: 1 });
  assertEquals(b.lines[0]!.score, { kind: "loss-in", plies: 2 });
});

Deno.test("standing pat is a horizon: the depth is not solved", async () => {
  // a may stand pat after b's reply, so depth 1 skipped a's quiet Moves; so
  // did depth 2. Depth 3 searches every Move to its end.
  const e = graphEngine(mateNodes(false), true);
  const all = await collect(e.analyze("root", {}));
  assertEquals(all.map((a) => a.depth), [1, 2, 3]);
  for (const a of all) {
    assertEquals(a.lines[0]!.score, { kind: "win-in", plies: 3 });
  }
});

Deno.test("a quiescence subtree that ends only in Outcomes is solved", async () => {
  // Stand pat refused on every node past the horizon: depth 1 is exact.
  const e = graphEngine(mateNodes(true), true);
  const all = await collect(e.analyze("root", { lines: 2 }));
  assertEquals(all.map((a) => a.depth), [1]);
  assertEquals(all[0]!.lines, [
    {
      moves: ["xcheck", "r1", "xmate1"],
      score: { kind: "win-in", plies: 3 },
    },
    { moves: ["quiet", "draw"], score: { kind: "value", value: 0 } },
  ]);
});

// --- The cap -----------------------------------------------------------------

/** An endless Game with one Move per Position (the plies so far). */
const chain: GameRules<number, number> = {
  id: "chain",
  name: "Chain",
  seats: ["a", "b"],
  initialPosition: () => 0,
  toMove: (p) => (p % 2 === 0 ? "a" : "b"),
  legalMoves: (p) => [p + 1],
  play: (_, m) => m,
  outcome: () => undefined,
  notation: {
    encodePosition: String,
    decodePosition: Number,
    encodeMove: String,
    decodeMove: Number,
  },
};

/** Deepest Position searched from the start of `chain` to depth 1. */
async function chainDepth(quiescence: Quiescence<number, number>) {
  let deepest = 0;
  const e = createMinimaxEngine({
    // One Move per Position: past 1,000 plies the cap did not hold.
    rules: budgeted(
      { ...chain, play: (_, m) => (deepest = Math.max(deepest, m), m) },
      1000,
    ),
    // Worse the longer it goes, so standing pat never cuts the chain short.
    evaluate: (p) => -p,
    name: "chain",
    quiescence,
  });
  const a = await final(e, 0, { maxDepth: 1 });
  assertEquals(a.depth, 1);
  return { deepest, line: a.lines[0]!.moves.length };
}

Deno.test("the quiescence cap holds, with and without stand pat", async () => {
  // Every Move is tactical, so only the cap ends the search.
  const tactical = () => true;
  for (const standPat of [() => true, () => false]) {
    const { deepest } = await chainDepth({ standPat, tactical });
    assertEquals(deepest, 1 + DEFAULT_QUIESCENCE_PLIES);
    for (const maxPlies of [0, 1, 5]) {
      const { deepest } = await chainDepth({ standPat, tactical, maxPlies });
      assertEquals(deepest, 1 + maxPlies);
    }
  }
  // Without stand pat the Line runs to the cap, where the Position is
  // evaluated anyway.
  assertEquals(
    await chainDepth({ standPat: () => false, maxPlies: 4 }),
    { deepest: 5, line: 5 },
  );
});

/** Endless Game with 3 Moves per Position, for depth-limited searches. */
const wide: GameRules<readonly number[], number> = {
  id: "wide",
  name: "Wide",
  seats: ["a", "b"],
  initialPosition: () => [],
  toMove: (p) => (p.length % 2 === 0 ? "a" : "b"),
  legalMoves: () => [0, 1, 2],
  play: (p, m) => [...p, m],
  outcome: () => undefined,
  notation: {
    encodePosition: (p) => p.join(""),
    decodePosition: (t) => [...t].map(Number),
    encodeMove: String,
    decodeMove: Number,
  },
};

/** Pseudo-random value of a Position (FNV-1a hash), in -100..100. */
function hashValue(p: readonly number[], salt = 0): number {
  let h = 2166136261 ^ salt;
  for (const m of p) h = Math.imul(h ^ (m + 1), 16777619);
  return ((h >>> 0) % 201) - 100;
}

Deno.test("a cap of 0 searches exactly like no quiescence", async () => {
  for (const tableBytes of [0, undefined]) {
    const run = async (quiescence?: Quiescence<readonly number[], number>) => {
      const { rules, count } = counting(wide);
      const e = createMinimaxEngine({
        rules,
        evaluate: hashValue,
        name: "w",
        movePriority: (_p, m) => m,
        ...(tableBytes === undefined ? {} : { tableBytes }),
        ...(quiescence ? { quiescence } : {}),
      });
      const a = await final(e, [], { maxDepth: 4, lines: 3 });
      return { lines: a.lines, nodes: count.nodes };
    };
    const plain = await run();
    const zero = await run({ standPat: () => false, maxPlies: 0 });
    assertEquals(zero, plain);
  }
});

// --- Limits ------------------------------------------------------------------

/**
 * `rules` whose `play` throws after `max` Moves, so a search that should
 * stop (e.g. one that no longer yields to the driver, or searches every Move
 * where stand pat is allowed) fails instead of hanging.
 */
function budgeted<P, M>(rules: GameRules<P, M>, max: number): GameRules<P, M> {
  let played = 0;
  return {
    ...rules,
    play(p, m) {
      if (++played > max) {
        throw new Error(`played more than ${max} Moves: the search went on`);
      }
      return rules.play(p, m);
    },
  };
}

// Depth 1 is cheap: at ply 1 nothing is tactical. From ply 2 on, stand pat is
// refused and every Move searched, with a cap far too deep to finish. A 50 ms
// search plays some 30,000 Moves.
const exploding = () =>
  createMinimaxEngine({
    rules: budgeted(wide, 1_000_000),
    evaluate: hashValue,
    name: "explode",
    quiescence: { standPat: (p) => p.length < 2, maxPlies: 60 },
  });

Deno.test("a time limit interrupts quiescence", async () => {
  const started = performance.now();
  const all = await collect(exploding().analyze([], { maxTimeMs: 50 }));
  const elapsed = performance.now() - started;
  assert(elapsed < 1000, `took ${elapsed}ms`);
  assertEquals(all.map((a) => a.depth), [1]);
});

Deno.test("aborting interrupts quiescence", async () => {
  const controller = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), 50);
  const all = await collect(exploding().analyze([], {}, controller.signal));
  clearTimeout(timer);
  const elapsed = performance.now() - started;
  assert(elapsed < 1000, `took ${elapsed}ms`);
  assertEquals(all.map((a) => a.depth), [1]);
});

// --- Exact against brute force -------------------------------------------

/**
 * A random finite Game tree (no transpositions): a Position is its Move
 * list. Per Position, from a hash: terminal or not (always at length 6), its
 * Seat to move (sometimes twice in a row), winner, 1-3 Moves, which of them
 * are captures, whether stand pat is refused, and its evaluation.
 */
function randomTree(seed: number) {
  const h = (p: readonly number[], salt: number) =>
    hashValue(p, seed * 7919 + salt) + 100; // 0..200
  const terminal = (p: readonly number[]) =>
    p.length >= 6 || (p.length > 0 && h(p, 1) < 30);
  const rules: GameRules<readonly number[], number> = {
    ...wide,
    id: "tree",
    toMove: (p) => (terminal(p) ? undefined : h(p, 2) < 100 ? "a" : "b"),
    legalMoves: (p) => terminal(p) ? [] : [0, 1, 2].slice(0, 1 + (h(p, 3) % 3)),
    outcome: (p) => {
      if (!terminal(p)) return undefined;
      const r = h(p, 4);
      return r < 80
        ? { winner: "a", reason: "end" }
        : r < 160
        ? { winner: "b", reason: "end" }
        : { reason: "end" };
    },
  };
  return {
    rules,
    evaluate: (p: readonly number[]) => h(p, 5) - 100,
    // Captures first; some Moves are captures.
    movePriority: (p: readonly number[], m: number) =>
      h([...p, m], 6) < 80 ? 1 + m : -m,
    standPat: (p: readonly number[]) => h(p, 7) >= 50,
  };
}

/**
 * Brute force without pruning or table, in `rank` units from the root:
 * nominal plies while `depth` > 0, then quiescence (stand pat where allowed,
 * tactical Moves `priority` > 0, evaluated at the cap). `depth` Infinity is
 * the exact value of the Game.
 */
function bruteForce<P, M>(
  rules: GameRules<P, M>,
  evaluate: (p: P) => number,
  priority: (p: P, m: M) => number,
  standPat: (p: P) => boolean,
  cap: number,
) {
  const memo = new Map<string, number>();
  /** Value of non-terminal `p` for its Seat to move. */
  function value(p: P, depth: number, ply: number): number {
    const key = `${rules.notation.encodePosition(p)} ${depth} ${ply}`;
    let v = memo.get(key);
    if (v === undefined) memo.set(key, v = search(p, depth, ply));
    return v;
  }
  function search(p: P, depth: number, ply: number): number {
    let moves = rules.legalMoves(p);
    let best = -Infinity;
    if (depth <= 0) {
      const capped = depth <= -cap;
      if (capped || standPat(p)) {
        best = evaluate(p);
        if (capped) return best;
        moves = moves.filter((m) => priority(p, m) > 0);
      }
    }
    for (const m of moves) best = Math.max(best, moveValue(p, m, depth, ply));
    return best;
  }
  /** Value of Move `m` in `p` (at `ply`, `depth` left) for `p`'s Seat to move. */
  function moveValue(p: P, m: M, depth: number, ply: number): number {
    const seat = rules.toMove(p);
    const child = rules.play(p, m);
    const outcome = rules.outcome(child);
    if (outcome) {
      if (outcome.winner === undefined) return 0;
      return outcome.winner === seat ? 1000 - (ply + 1) : -(1000 - (ply + 1));
    }
    const v = value(child, depth - 1, ply + 1);
    return rules.toMove(child) === seat ? v : -v;
  }
  return moveValue;
}

/** Checks every Line of `a` from `root` against `exact` and its own PV. */
function assertLines<P, M>(
  rules: GameRules<P, M>,
  evaluate: (p: P) => number,
  root: P,
  a: Analysis<M>,
  exact: (m: M) => number,
  label: string,
) {
  const seat = rules.toMove(root);
  for (const line of a.lines) {
    const where = `${label}: ${line.moves.map(rules.notation.encodeMove)}`;
    assertEquals(rank(line.score), exact(line.moves[0]!), where);
    // The PV realises its Score: a forced result ends in its Outcome after
    // exactly that many plies, a value at a Position evaluated to it.
    const end = replay(rules, root, line.moves);
    const outcome = rules.outcome(end);
    if (line.score.kind !== "value") {
      assert(outcome, `${where}: a forced result's PV ends in an Outcome`);
      assertEquals(line.moves.length, line.score.plies, where);
      assertEquals(
        outcome.winner === seat,
        line.score.kind === "win-in",
        where,
      );
    } else if (outcome) {
      assertEquals(outcome.winner, undefined, where);
      assertEquals(line.score.value, 0, where);
    } else {
      const v = evaluate(end);
      assertEquals(
        line.score.value,
        rules.toMove(end) === seat ? v : -v,
        where,
      );
    }
  }
}

Deno.test("quiescence results are exact against brute force (random trees)", async () => {
  const roots: (readonly number[])[] = [[], [0], [1], [0, 0]];
  // What the trees exercise, so the test cannot pass vacuously.
  let pastHorizon = 0; // forced results found in quiescence
  let longer = 0; // value Lines that run past the nominal depth
  for (let seed = 1; seed <= 40; seed++) {
    const t = randomTree(seed);
    for (const cap of [1, 2, DEFAULT_QUIESCENCE_PLIES]) {
      const moveValue = bruteForce(
        t.rules,
        t.evaluate,
        t.movePriority,
        t.standPat,
        cap,
      );
      // A one-slot table replaces entries all the time.
      for (const tableBytes of [0, 300, undefined]) {
        const e = createMinimaxEngine({
          rules: t.rules,
          evaluate: t.evaluate,
          movePriority: t.movePriority,
          name: "tree",
          quiescence: { standPat: t.standPat, maxPlies: cap },
          ...(tableBytes === undefined ? {} : { tableBytes }),
        });
        for (const root of roots) {
          if (!t.rules.toMove(root)) continue;
          const lines = t.rules.legalMoves(root).length;
          const label = `seed ${seed} cap ${cap} table ${tableBytes} root ${
            root.join("")
          }`;
          for (const maxDepth of [1, 2, 3]) {
            const a = await final(e, root, { maxDepth, lines });
            assertLines(
              t.rules,
              t.evaluate,
              root,
              a,
              (m) => moveValue(root, m, maxDepth, 0),
              `${label} depth ${maxDepth}`,
            );
            for (const { moves, score } of a.lines) {
              if (moves.length <= maxDepth) continue;
              if (score.kind === "value") longer++;
              else pastHorizon++;
            }
          }
          // Unlimited: deepens until solved, and then it is exact.
          const solved = await final(e, root, { lines });
          assertLines(
            t.rules,
            t.evaluate,
            root,
            solved,
            (m) => moveValue(root, m, Infinity, 0),
            `${label} solved`,
          );
          for (const line of solved.lines) {
            const end = replay(t.rules, root, line.moves);
            assert(t.rules.outcome(end), `${label}: solved PV ends early`);
          }
        }
      }
    }
  }
  assert(
    pastHorizon > 50,
    `only ${pastHorizon} forced results past the horizon`,
  );
  assert(longer > 50, `only ${longer} Lines past the horizon`);
});

/**
 * A random Game on a directed acyclic graph (nodes "root", "1", ...; the
 * last 6 terminal): paths of different lengths meet, so the table answers a
 * Position from a search at another ply. A node named "x..." is reached by
 * a capture; some nodes refuse stand pat.
 */
function randomDag(seed: number, size: number) {
  const random = seededRandom(seed);
  const names = Array.from(
    { length: size },
    (_, i) => (i === 0 ? "root" : `${random() < 0.4 ? "x" : ""}${i}`),
  );
  const nodes: Record<string, GraphNode> = {};
  names.forEach((name, i) => {
    const r = random();
    if (i >= size - 6) {
      nodes[name] = r < 0.4 ? { winner: "a" } : r < 0.8 ? { winner: "b" } : {};
      return;
    }
    const moves = new Set<string>();
    const count = 1 + Math.floor(random() * 3);
    for (let k = 0; k < count; k++) {
      const j = i + 1 + Math.floor(random() * Math.min(4, size - 1 - i));
      moves.add(names[j]!);
    }
    nodes[name] = {
      seat: r < 0.5 ? "a" : "b",
      moves: [...moves],
      value: Math.round(random() * 200 - 100),
      check: random() < 0.3,
    };
  });
  return { ...graphGame(nodes), roots: names.slice(0, 3) };
}

Deno.test("transpositions at different plies keep quiescence results exact", async () => {
  let forced = 0; // forced results found past the horizon
  for (let seed = 1; seed <= 60; seed++) {
    const g = randomDag(seed, 20);
    const exact = bruteForce(
      g.rules,
      g.evaluate,
      g.movePriority,
      g.quiescence.standPat,
      DEFAULT_QUIESCENCE_PLIES,
    );
    // Small tables replace entries all the time.
    for (const tableBytes of [undefined, 600, 300]) {
      const e = createMinimaxEngine({
        rules: g.rules,
        evaluate: g.evaluate,
        movePriority: g.movePriority,
        name: "dag",
        quiescence: g.quiescence,
        ...(tableBytes === undefined ? {} : { tableBytes }),
      });
      for (const root of g.roots) {
        const lines = g.rules.legalMoves(root).length;
        const label = `seed ${seed} table ${tableBytes} root ${root}`;
        const solved = await final(e, root, { lines });
        assertLines(
          g.rules,
          g.evaluate,
          root,
          solved,
          (m) => exact(root, m, Infinity, 0),
          `${label} solved`,
        );
        // Depth-limited: a stored deeper result may see further, so only
        // forced results are checked. Each is real (its PV ends in its
        // Outcome after exactly its plies), and no faster than the fastest:
        // a quiet Move past the horizon may win sooner.
        for (const maxDepth of [1, 2, 3]) {
          const a = await final(e, root, { maxDepth, lines });
          for (const line of a.lines) {
            if (line.score.kind === "value") continue;
            if (line.score.plies > maxDepth) forced++;
            const where = `${label} depth ${maxDepth}: ${line.moves}`;
            const end = replay(g.rules, root, line.moves);
            const outcome = g.rules.outcome(end);
            assert(outcome, `${where}: no Outcome`);
            assertEquals(line.moves.length, line.score.plies, where);
            const won = line.score.kind === "win-in";
            assertEquals(outcome.winner === g.rules.toMove(root), won, where);
            const best = exact(root, line.moves[0]!, Infinity, 0);
            const claimed = rank(line.score);
            assert(won ? best >= claimed : best <= claimed, where);
            assertEquals(best > 0, won, where);
          }
        }
      }
    }
  }
  assert(forced > 150, `only ${forced} forced results past the horizon`);
});

// --- Tic-tac-toe -------------------------------------------------------------

/** Tic-tac-toe with every Move tactical: quiescence searches on to the cap. */
const tttQuiescence = createMinimaxEngine({
  rules: ttt,
  evaluate: (p: TicTacToePosition) => p.cells.filter((c) => c === ".").length,
  name: "ttt-q",
  movePriority: () => 1,
  quiescence: { standPat: () => true, maxPlies: 2 },
});

Deno.test("quiescence still solves tic-tac-toe as a draw", async () => {
  const a = await final(tttQuiescence, ttt.initialPosition(), { lines: 9 });
  for (const line of a.lines) {
    assert(rank(line.score) <= 0, JSON.stringify(line));
    const end = replay(ttt, ttt.initialPosition(), line.moves);
    assert(ttt.outcome(end), "a solved PV ends in an Outcome");
  }
  assertEquals(a.lines[0]!.score, { kind: "value", value: 0 });
});

Deno.test("honours the Engine contract with quiescence", async () => {
  await assertEngineContract(tttQuiescence, ttt);
});

// --- Delta pruning (`gain`) --------------------------------------------------

// Depth 2: a plays m1 (a quiet 3) or m2. After m2, a is to move at the
// horizon with alpha 3 (from m1): standing pat gives 0, and the captures
// win 9 (xwin) and 1 (xsmall). Only a bound >= 9 may keep xwin.
const DELTA: Record<string, GraphNode> = {
  root: { seat: "a", moves: ["m1", "m2"] },
  m1: { seat: "b", moves: ["c0"] },
  c0: { seat: "a", moves: ["end"], value: 3 },
  m2: { seat: "b", moves: ["c"] },
  c: { seat: "a", moves: ["xsmall", "xwin", "end"], value: 0 },
  xsmall: { seat: "b", moves: ["end"], value: -1 },
  xwin: { seat: "b", moves: ["end"], value: -9 },
  end: {},
};

async function deltaSearch(
  nodes: Record<string, GraphNode>,
  gain: ((p: string, m: string) => number) | undefined,
) {
  const g = graphGame(nodes);
  const counted = counting(g.rules);
  const e = createMinimaxEngine({
    rules: counted.rules,
    evaluate: g.evaluate,
    movePriority: g.movePriority,
    name: "delta",
    quiescence: { ...g.quiescence, ...(gain ? { gain } : {}) },
  });
  const a = await final(e, "root", { maxDepth: 2 });
  return { line: a.lines[0]!, nodes: counted.count.nodes };
}

Deno.test("delta pruning: a bound that holds prunes without changing the result", async () => {
  const plain = await deltaSearch(DELTA, undefined);
  assertEquals(plain.line.moves, ["m2", "c", "xwin"]);
  assertEquals(plain.line.score, { kind: "value", value: 9 });
  const asked: string[] = [];
  const bounded = await deltaSearch(DELTA, (_p, m) => {
    asked.push(m);
    return m === "xwin" ? 9 : 1;
  });
  assertEquals(bounded.line, plain.line);
  // xsmall (0 + 1 <= 3) is skipped, xwin (0 + 9 > 3) is searched.
  assert(bounded.nodes < plain.nodes);
  assert(asked.includes("xwin") && asked.includes("xsmall"));
});

Deno.test("delta pruning: a bound that is too low changes the result (the bound is trusted)", async () => {
  const wrong = await deltaSearch(DELTA, () => 3);
  assertEquals(wrong.line.moves[0], "m1");
  // Infinity never prunes.
  const never = await deltaSearch(DELTA, () => Infinity);
  const plain = await deltaSearch(DELTA, undefined);
  assertEquals(never, plain);
});

Deno.test("delta pruning: never where stand pat is refused", async () => {
  const asked: string[] = [];
  // Every capture would be pruned in c if asked, but c refuses stand pat.
  const checked = { ...DELTA, c: { ...DELTA.c!, check: true } };
  const r = await deltaSearch(checked, (p, m) => (asked.push(p + m), 0));
  assertEquals(r.line.moves, ["m2", "c", "xwin"]);
  assertEquals(asked, []);
});

Deno.test("delta pruning: not at the cap", async () => {
  const asked: string[] = [];
  const g = graphGame(DELTA);
  const e = createMinimaxEngine({
    rules: g.rules,
    evaluate: g.evaluate,
    movePriority: g.movePriority,
    name: "delta",
    quiescence: {
      standPat: g.quiescence.standPat,
      maxPlies: 0,
      gain: (_p, m) => (asked.push(m), 0),
    },
  });
  await final(e, "root", { maxDepth: 2 });
  assertEquals(asked, []);
});
