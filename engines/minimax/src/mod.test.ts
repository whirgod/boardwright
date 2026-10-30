import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type {
  Analysis,
  Engine,
  GameRules,
  Score,
  SearchLimits,
  Seat,
} from "@boardwright/core";
import {
  ticTacToe as ttt,
  type TicTacToeMove,
  type TicTacToePosition,
} from "@boardwright/game-tic-tac-toe";
import {
  assertEngineContract,
  diceRace,
  seededRandom,
} from "@boardwright/testing";
import {
  createMinimaxEngine,
  DEFAULT_TABLE_BYTES,
  MAX_EVALUATION,
} from "./mod.ts";

const engine = createMinimaxEngine({
  rules: ttt,
  evaluate: () => 0,
  name: "minimax",
});
// Table budgets for 1 and 3 slots (and entries with short keys): every
// Position shares a slot or two, so entries are replaced all the time.
const ONE_SLOT = 300;
const THREE_SLOTS = 600;
const tinyTable = createMinimaxEngine({
  rules: ttt,
  evaluate: () => 0,
  name: "minimax",
  tableBytes: ONE_SLOT,
});

const decode = (text: string) => ttt.notation.decodePosition(text);

async function collect<M>(
  iterable: AsyncIterable<Analysis<M>>,
  onEach?: (a: Analysis<M>) => void,
): Promise<Analysis<M>[]> {
  const all: Analysis<M>[] = [];
  for await (const a of iterable) {
    all.push(a);
    onEach?.(a);
  }
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

/** Orders Scores: higher is better for the Seat to move. */
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
function replay<P, M>(
  rules: GameRules<P, M>,
  position: P,
  moves: readonly M[],
) {
  return moves.reduce((p, m) => rules.play(p, m), position);
}

/** Independent reference: plain minimax without pruning, in rank() units. */
function solver<P, M>(rules: GameRules<P, M>) {
  const memo = new Map<string, number>();
  /** Value of non-terminal `p` for its Seat to move. */
  function value(p: P): number {
    const key = rules.notation.encodePosition(p);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let best = -Infinity;
    for (const m of rules.legalMoves(p)) best = Math.max(best, moveValue(p, m));
    memo.set(key, best);
    return best;
  }
  /** Value of Move `m` in `p` for the Seat to move. */
  function moveValue(p: P, m: M): number {
    const seat = rules.toMove(p);
    const child = rules.play(p, m);
    const outcome = rules.outcome(child);
    if (outcome) {
      return outcome.winner === undefined
        ? 0
        : outcome.winner === seat
        ? 999
        : -999;
    }
    const r = rules.toMove(child) === seat ? value(child) : -value(child);
    // A forced result one ply further away.
    return r > 0 ? r - 1 : r < 0 ? r + 1 : 0;
  }
  return { value, moveValue };
}
const { value: reference, moveValue: referenceMove } = solver<
  TicTacToePosition,
  TicTacToeMove
>(ttt);

Deno.test("neutral Scores are +0, never -0", async () => {
  const a = await final(engine, ttt.initialPosition(), { maxDepth: 1 });
  const score = a.lines[0]!.score;
  assert(score.kind === "value" && Object.is(score.value, 0));
});

Deno.test("engine identity", () => {
  assertEquals(engine.name, "minimax");
  assertEquals(engine.gameId, "tic-tac-toe");
});

Deno.test("perfect play from the start is a draw", async () => {
  const all = await collect(engine.analyze(ttt.initialPosition(), {}));
  const last = all.at(-1)!;
  assertEquals(last.lines.length, 1);
  assertEquals(last.lines[0]!.score, { kind: "value", value: 0 });
  // The search stops by itself once the tree is solved.
  assertEquals(last.depth, 9);
  assertEquals(all.map((a) => a.depth), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const end = replay(ttt, ttt.initialPosition(), last.lines[0]!.moves);
  assertEquals(ttt.outcome(end), { reason: "board-full" });
});

Deno.test("finds an immediate win", async () => {
  const a = await final(engine, decode("xx.oo....:x"), { maxDepth: 1 });
  assertEquals(a.lines[0], {
    moves: ["c1"],
    score: { kind: "win-in", plies: 1 },
  });
});

Deno.test("prefers the faster win", async () => {
  // x wins with c1 now, or later via several slower routes.
  const a = await final(engine, decode("xx.oo....:x"), { lines: 3 });
  assertEquals(a.lines[0]!.score, { kind: "win-in", plies: 1 });
  assertEquals(a.lines[0]!.moves, ["c1"]);
});

Deno.test("blocks an immediate loss", async () => {
  const a = await final(engine, decode("xx.o.....:o"), { lines: 9 });
  assertEquals(a.lines[0]!.moves[0], "c1");
  // Every other Move lets x win on the next ply.
  for (const line of a.lines.slice(1)) {
    assertEquals(line.score, { kind: "loss-in", plies: 2 });
    assertEquals(line.moves.length, 2);
    assertEquals(line.moves[1], "c1");
  }
});

Deno.test("Score kinds and ply counts in won and lost positions", async () => {
  // o to move; x threatens both a2 and b3: o is lost.
  const lost = await final(engine, decode("x.o.o.x.x:o"), { lines: 9 });
  for (const line of lost.lines) {
    assertEquals(line.score, { kind: "loss-in", plies: 2 });
  }

  // x to move with a fork available: win in 3.
  const win3 = decode("x...o.o.x:x");
  const w = await final(engine, win3);
  assertEquals(w.lines[0]!.score, { kind: "win-in", plies: 3 });
  const end = replay(ttt, win3, w.lines[0]!.moves);
  assertEquals(ttt.outcome(end)?.winner, "x");
  assertEquals(w.lines[0]!.moves.length, 3);
});

/** All reachable non-terminal Positions, deterministically sampled. */
function samplePositions(): TicTacToePosition[] {
  const seen = new Map<string, TicTacToePosition>();
  const stack = [ttt.initialPosition()];
  while (stack.length) {
    const p = stack.pop()!;
    const key = ttt.notation.encodePosition(p);
    if (seen.has(key) || ttt.outcome(p)) continue;
    seen.set(key, p);
    for (const m of ttt.legalMoves(p)) stack.push(ttt.play(p, m));
  }
  const sample = [...seen.values()].filter((_, i) => i % 97 === 0);
  assert(sample.length > 30);
  return sample;
}

/**
 * Multi-PV with fewer Lines than legal Moves: every reported Line must carry
 * the exact Score of its root Move, and the Lines must be the best ones.
 */
async function assertExactMultiPv<P, M>(
  e: Engine<P, M>,
  position: P,
  limits: SearchLimits,
  moves: readonly M[],
  exact: (move: M) => number,
  label: string,
) {
  const best = moves.map(exact).sort((a, b) => b - a);
  for (let k = 1; k < moves.length; k++) {
    const a = await final(e, position, { ...limits, lines: k });
    assertEquals(a.lines.length, k, label);
    a.lines.forEach((line, i) => {
      const value = rank(line.score);
      assertEquals(value, exact(line.moves[0]!), `${label} lines=${k} #${i}`);
      assertEquals(value, best[i], `${label} lines=${k} #${i} not i-th best`);
    });
  }
}

Deno.test("multi-PV Lines below the first are exact (solved)", async () => {
  for (const e of [engine, tinyTable]) {
    for (const p of samplePositions()) {
      const moves = ttt.legalMoves(p);
      await assertExactMultiPv(
        e,
        p,
        {},
        moves,
        (m) => referenceMove(p, m),
        ttt.notation.encodePosition(p),
      );
    }
  }
});

/** Endless Game with 5 Moves per Position, for depth-limited searches. */
const wide: GameRules<readonly number[], number> = {
  id: "wide",
  name: "Wide",
  seats: ["a", "b"],
  initialPosition: () => [],
  toMove: (p) => (p.length % 2 === 0 ? "a" : "b"),
  legalMoves: () => [0, 1, 2, 3, 4],
  play: (p, m) => [...p, m],
  outcome: () => undefined,
  notation: {
    encodePosition: (p) => p.join(""),
    decodePosition: (t) => [...t].map(Number),
    encodeMove: String,
    decodeMove: Number,
  },
};

/** Pseudo-random value of a Position for its Seat to move (FNV-1a hash). */
function hashValue(p: readonly number[]): number {
  let h = 2166136261;
  for (const m of p) h = Math.imul(h ^ (m + 1), 16777619);
  return ((h >>> 0) % 2001) - 1000;
}

/** Depth-limited negamax without pruning: value of `p` for its Seat to move. */
function wideReference(p: readonly number[], depth: number): number {
  if (depth === 0) return hashValue(p);
  return Math.max(
    ...wide.legalMoves(p).map((m) => -wideReference([...p, m], depth - 1)),
  );
}

Deno.test("multi-PV Lines below the first are exact (depth-limited)", async () => {
  for (const tableBytes of [DEFAULT_TABLE_BYTES, ONE_SLOT]) {
    const e = createMinimaxEngine({
      rules: wide,
      name: "w",
      evaluate: hashValue,
      tableBytes,
    });
    for (const root of [[], [0], [3, 1], [4, 4, 2]]) {
      for (const maxDepth of [1, 2, 3, 4]) {
        await assertExactMultiPv(
          e,
          root,
          { maxDepth },
          wide.legalMoves(root),
          (m) => -wideReference([...root, m], maxDepth - 1),
          `${root.join("")} depth=${maxDepth} tableBytes=${tableBytes}`,
        );
      }
    }
  }
});

Deno.test("hash Moves from the previous depth save nodes", async () => {
  // The Seat to move's Moves minus the other Seat's: the largest Move is
  // best at every depth, but the Game lists it last.
  const sum = (p: readonly number[]) =>
    p.reduce((s, m, i) => s + (i % 2 === p.length % 2 ? m : -m), 0);
  /** Nodes (Moves played) to search `wide` to depth 6. */
  async function nodes(tableBytes: number) {
    let played = 0;
    const counting = {
      ...wide,
      play: (p: readonly number[], m: number) => (played++, wide.play(p, m)),
    };
    const e = createMinimaxEngine({
      rules: counting,
      name: "w",
      evaluate: sum,
      tableBytes,
    });
    const a = await final(e, [], { maxDepth: 6 });
    assertEquals(a.lines[0]!.moves, [4, 4, 4, 4, 4, 4]);
    return played;
  }
  const withTable = await nodes(DEFAULT_TABLE_BYTES);
  const withoutTable = await nodes(0); // a budget of 0 stores nothing
  assert(withTable < withoutTable / 2, `${withTable} vs ${withoutTable}`);
});

Deno.test("matches an exhaustive reference on sampled positions", async () => {
  const sample = samplePositions();
  const runs = [engine, tinyTable].flatMap((e) => sample.map((p) => [e, p]));
  for (const [e, p] of runs as [typeof engine, TicTacToePosition][]) {
    const key = ttt.notation.encodePosition(p);
    const moves = ttt.legalMoves(p);
    const a = await final(e, p, { lines: moves.length });
    assertEquals(a.lines.length, moves.length, key);
    for (const line of a.lines) {
      const move = line.moves[0]!;
      assertEquals(rank(line.score), referenceMove(p, move), `${key} ${move}`);
      // The principal variation is legal and realises its Score.
      const end = replay(ttt, p, line.moves);
      const outcome = ttt.outcome(end);
      assert(outcome, `${key}: PV does not reach the end of a solved tree`);
      if (line.score.kind === "value") assertEquals(outcome.winner, undefined);
      else {
        assertEquals(line.moves.length, line.score.plies, key);
        const winnerToMove = line.score.kind === "win-in";
        assertEquals(outcome.winner === p.turn, winnerToMove, key);
      }
    }
    assertEquals(rank(a.lines[0]!.score), reference(p), key);
  }
});

Deno.test("multi-PV returns distinct root Moves ordered by Score", async () => {
  const p = ttt.play(ttt.initialPosition(), "a1");
  const a = await final(engine, p, { lines: 8 });
  assertEquals(a.lines.length, 8);
  const roots = a.lines.map((l) => l.moves[0]);
  assertEquals(new Set(roots).size, 8);
  // Only the centre holds the draw against a corner opening.
  assertEquals(a.lines[0], {
    moves: a.lines[0]!.moves,
    score: { kind: "value", value: 0 },
  });
  assertEquals(roots[0], "b2");
  for (let i = 1; i < a.lines.length; i++) {
    assert(rank(a.lines[i - 1]!.score) >= rank(a.lines[i]!.score));
    assertEquals(a.lines[i]!.score.kind, "loss-in");
  }
});

Deno.test("multi-PV is capped by the number of legal Moves", async () => {
  const a = await final(engine, decode("xx.oo....:x"), { lines: 50 });
  assertEquals(a.lines.length, 5);
  const b = await final(engine, decode("xx.oo....:x"), { lines: 2 });
  assertEquals(b.lines.length, 2);
  assertEquals(
    b.lines.map((l) => l.moves[0]),
    a.lines.slice(0, 2).map((l) => l.moves[0]),
  );
});

Deno.test("depth limit is respected", async () => {
  const all = await collect(
    engine.analyze(ttt.initialPosition(), { maxDepth: 3, lines: 9 }),
  );
  assertEquals(all.map((a) => a.depth), [1, 2, 3]);
  for (const a of all) {
    assertEquals(a.lines.length, 9);
    for (const line of a.lines) assert(line.moves.length <= a.depth);
  }
});

Deno.test("terminal position yields one empty Analysis", async () => {
  const all = await collect(engine.analyze(decode("xxxoo....:o"), {}));
  assertEquals(all, [{ depth: 0, lines: [] }]);
});

Deno.test("uses the evaluation at the horizon, from the mover's view", async () => {
  // Value for the Seat to move: x likes the centre, o dislikes x there.
  const centre = createMinimaxEngine({
    rules: ttt,
    name: "centre",
    evaluate: (p) => (p.cells[4] === "x" ? 5 : 0) * (p.turn === "x" ? 1 : -1),
  });
  const a = await final(centre, ttt.initialPosition(), { maxDepth: 1 });
  assertEquals(a.lines[0], {
    moves: ["b2"],
    score: { kind: "value", value: 5 },
  });
});

Deno.test("clamps huge evaluations below forced wins", async () => {
  const huge = createMinimaxEngine({
    rules: ttt,
    name: "huge",
    evaluate: (p) => (p.turn === "o" ? -Infinity : Infinity),
  });
  const a = await final(huge, decode("xx.oo....:x"), { maxDepth: 2, lines: 2 });
  assertEquals(a.lines[0]!.score, { kind: "win-in", plies: 1 });
  const b = await final(huge, ttt.initialPosition(), { maxDepth: 1 });
  assertEquals(b.lines[0]!.score, { kind: "value", value: MAX_EVALUATION });
});

Deno.test("rejects NaN evaluations", async () => {
  const bad = createMinimaxEngine({
    rules: ttt,
    name: "bad",
    evaluate: () => NaN,
  });
  await assertRejects(
    () => collect(bad.analyze(ttt.initialPosition(), { maxDepth: 1 })),
    TypeError,
    "NaN",
  );
});

Deno.test("rejects an invalid tableBytes", () => {
  for (const tableBytes of [-1, 1.5, NaN, Infinity, 2 ** 32 + 1]) {
    assertThrows(
      () =>
        createMinimaxEngine({
          rules: ttt,
          evaluate: () => 0,
          name: "m",
          tableBytes,
        }),
      RangeError,
      "tableBytes",
    );
  }
});

Deno.test("rejects invalid limits", () => {
  const p = ttt.initialPosition();
  for (
    const limits of [
      { maxDepth: 0 },
      { maxDepth: 1.5 },
      { maxTimeMs: -1 },
      { maxTimeMs: NaN },
      { lines: 0 },
      { lines: 2.5 },
    ]
  ) {
    assertThrows(() => engine.analyze(p, limits), RangeError);
  }
});

Deno.test("never plays an illegal Move in engine-vs-engine Matches", async () => {
  for (const maxDepth of [1, 2, 3, undefined]) {
    let p = ttt.initialPosition();
    while (!ttt.outcome(p)) {
      const limits = maxDepth === undefined ? {} : { maxDepth };
      const a = await final(engine, p, limits);
      const move = a.lines[0]!.moves[0]!;
      assert(ttt.legalMoves(p).includes(move));
      p = ttt.play(p, move);
    }
    // Two perfect (unlimited) players draw.
    if (maxDepth === undefined) {
      assertEquals(ttt.outcome(p)?.winner, undefined);
    }
  }
});

// --- Synthetic Games -------------------------------------------------------

/**
 * Endless binary Game: the Position is the Move list so far, Seats alternate,
 * there is never an Outcome. Each depth doubles the tree.
 */
const endless: GameRules<readonly number[], number> = {
  id: "endless",
  name: "Endless",
  seats: ["a", "b"],
  initialPosition: () => [],
  toMove: (p) => (p.length % 2 === 0 ? "a" : "b"),
  legalMoves: () => [0, 1],
  play: (p, m) => [...p, m],
  outcome: () => undefined,
  notation: {
    encodePosition: (p) => p.join(""),
    decodePosition: (t) => [...t].map(Number),
    encodeMove: String,
    decodeMove: Number,
  },
};
const endlessEngine = createMinimaxEngine({
  rules: endless,
  name: "endless",
  // From the perspective of the Seat to move, as `evaluate` requires.
  evaluate: (p) =>
    p.reduce((s, m, i) => s + (i % 2 ? -m : m), 0) * (p.length % 2 ? -1 : 1),
});

function assertComplete(all: Analysis<number>[]) {
  all.forEach((a, i) => {
    assertEquals(a.depth, i + 1);
    // A partial depth would have a shorter principal variation.
    assertEquals(a.lines[0]!.moves.length, a.depth);
  });
}

Deno.test("abort signal stops a long search promptly", async () => {
  const controller = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), 50);
  const all = await collect(endlessEngine.analyze([], {}, controller.signal));
  clearTimeout(timer);
  const elapsed = performance.now() - started;
  assert(elapsed < 1000, `took ${elapsed}ms`);
  assert(all.length >= 1);
  assertComplete(all);
});

Deno.test("aborting between yields stops before the next depth", async () => {
  const controller = new AbortController();
  const all = await collect(
    endlessEngine.analyze([], {}, controller.signal),
    (a) => a.depth === 2 && controller.abort(),
  );
  assertEquals(all.map((a) => a.depth), [1, 2]);
});

Deno.test("an already aborted signal yields nothing", async () => {
  const all = await collect(
    engine.analyze(ttt.initialPosition(), {}, AbortSignal.abort()),
  );
  assertEquals(all, []);
});

Deno.test("time limit stops the search but always completes depth 1", async () => {
  const started = performance.now();
  const all = await collect(endlessEngine.analyze([], { maxTimeMs: 50 }));
  const elapsed = performance.now() - started;
  assert(elapsed < 1000, `took ${elapsed}ms`);
  assert(all.length >= 1);
  assertComplete(all);

  const zero = await collect(endlessEngine.analyze([], { maxTimeMs: 0 }));
  assertEquals(zero.map((a) => a.depth), [1]);
});

Deno.test("handles a Seat moving several times in a row", async () => {
  // a moves twice, then b once. a wins with 1,1; otherwise b wins by playing 1.
  const twice: GameRules<readonly number[], number> = {
    ...endless,
    id: "twice",
    toMove: (p) => (p.length < 2 ? "a" : p.length === 2 ? "b" : undefined),
    legalMoves: (p) => (p.length < 3 ? [0, 1] : []),
    outcome(p) {
      if (p.length < 3) return undefined;
      if (p[0] === 1 && p[1] === 1) return { winner: "a", reason: "ones" };
      return p[2] === 1
        ? { winner: "b", reason: "spoiler" }
        : { reason: "none" };
    },
  };
  const e = createMinimaxEngine({ rules: twice, name: "t", evaluate: () => 0 });
  const a = await final(e, [], { lines: 2 });
  assertEquals(a.depth, 3);
  assertEquals(a.lines[0], {
    moves: [1, 1, 0],
    score: { kind: "win-in", plies: 3 },
  });
  assertEquals(a.lines[1], {
    moves: [0, 0, 1],
    score: { kind: "loss-in", plies: 3 },
  });
  // From b's view after a played 1, 0: b wins in 1.
  const b = await final(e, [1, 0]);
  assertEquals(b.lines[0], { moves: [1], score: { kind: "win-in", plies: 1 } });
  // Horizon evaluation for the same Seat is not negated.
  const h = createMinimaxEngine({
    rules: twice,
    name: "h",
    evaluate: (p) => (p[0] === 1 ? 7 : 0),
  });
  const c = await final(h, [], { maxDepth: 1 });
  assertEquals(c.lines[0], { moves: [1], score: { kind: "value", value: 7 } });
});

// --- Transposition table ---------------------------------------------------

interface GraphNode {
  /** The Seat to move; a node without `moves` is terminal. */
  readonly seat?: Seat;
  /** The nodes it leads to. */
  readonly moves?: readonly string[];
  /** Winner of a terminal node; none is a draw. */
  readonly winner?: Seat;
}

/**
 * A Game on a directed acyclic graph: a Position is a node, a Move the node
 * it leads to. Every node has its own Seat to move, so a Seat may move
 * several times in a row, and paths of different lengths meet at the same
 * node: transpositions at different plies, with the same Seat to move.
 */
function graphGame(
  nodes: Readonly<Record<string, GraphNode>>,
): GameRules<string, string> {
  const node = (p: string) => nodes[p]!;
  return {
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
}

/** A random `graphGame` on nodes "root", "1", "2", ...; the last 6 are terminal. */
function randomGraph(seed: number, size: number): GameRules<string, string> {
  const random = seededRandom(seed);
  const name = (i: number) => (i === 0 ? "root" : String(i));
  const nodes: Record<string, GraphNode> = {};
  for (let i = 0; i < size; i++) {
    const r = random();
    if (i >= size - 6) {
      nodes[name(i)] = r < 0.4
        ? { winner: "a" }
        : r < 0.8
        ? { winner: "b" }
        : {};
      continue;
    }
    const moves = new Set<string>();
    const count = 1 + Math.floor(random() * 3);
    for (let k = 0; k < count; k++) {
      moves.add(name(i + 1 + Math.floor(random() * Math.min(4, size - 1 - i))));
    }
    nodes[name(i)] = { seat: r < 0.5 ? "a" : "b", moves: [...moves] };
  }
  return graphGame(nodes);
}

/**
 * Checks the Lines of `a` (from `p`) against the reference: all of them if
 * the search was `solved` (ran without limits), else those that claim a
 * forced result.
 */
function assertExactLines<P, M>(
  rules: GameRules<P, M>,
  exact: ReturnType<typeof solver<P, M>>,
  p: P,
  a: Analysis<M>,
  label: string,
  solved: boolean,
) {
  for (const line of a.lines) {
    const where = `${label}: ${line.moves.map(rules.notation.encodeMove)}`;
    if (!solved && line.score.kind === "value") continue;
    assertEquals(rank(line.score), exact.moveValue(p, line.moves[0]!), where);
    // The PV realises the Score: it reaches an Outcome, after exactly as
    // many plies as a forced result claims.
    const outcome = rules.outcome(replay(rules, p, line.moves));
    assert(outcome, `${where}: PV does not reach an Outcome`);
    if (line.score.kind === "value") {
      assertEquals(outcome.winner, undefined, where);
    } else {
      assertEquals(line.moves.length, line.score.plies, where);
      const won = outcome.winner === rules.toMove(p);
      assertEquals(won, line.score.kind === "win-in", where);
    }
  }
}

Deno.test("transpositions at different plies keep results and mate distances exact", async () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rules = randomGraph(seed, 32);
    const exact = solver(rules);
    // A random but fixed evaluation per Position, so horizons mislead.
    const random = seededRandom(seed);
    const values = new Map<string, number>();
    const evaluate = (p: string) => {
      if (!values.has(p)) values.set(p, Math.round(random() * 200 - 100));
      return values.get(p)!;
    };
    // Small tables replace entries all the time.
    for (const tableBytes of [DEFAULT_TABLE_BYTES, THREE_SLOTS, ONE_SLOT]) {
      const e = createMinimaxEngine({ rules, name: "g", evaluate, tableBytes });
      for (const p of ["root", "1", "2"]) {
        if (!rules.toMove(p)) continue;
        for (const lines of [1, rules.legalMoves(p).length]) {
          const label = `seed ${seed} from ${p} tableBytes ${tableBytes}`;
          const solved = await final(e, p, { lines });
          assertExactLines(rules, exact, p, solved, label, true);
          // Depth-limited: the forced results found so far are exact, too.
          for (const maxDepth of [2, 4, 6]) {
            const a = await final(e, p, { maxDepth, lines });
            assertExactLines(
              rules,
              exact,
              p,
              a,
              `${label} depth ${maxDepth}`,
              false,
            );
          }
        }
      }
    }
  }
});

Deno.test("a cutoff from a stored search that hit the horizon is not solved", async () => {
  // Only a moves. "draw" ends level at once; the other root Moves reach x,
  // which takes 3 more plies to end (a loses) and looks bad (-5) at the
  // horizon. x is reached at ply 2 via "detour" (searched first) and at
  // ply 1 directly.
  const rules = graphGame({
    root: { seat: "a", moves: ["draw", "detour", "x"] },
    draw: {},
    detour: { seat: "a", moves: ["x"] },
    x: { seat: "a", moves: ["x1"] },
    x1: { seat: "a", moves: ["x2"] },
    x2: { seat: "a", moves: ["lost"] },
    lost: { winner: "b" },
  });
  let evaluations = 0;
  const e = createMinimaxEngine({
    rules,
    name: "graph",
    evaluate: () => (evaluations++, -5),
  });
  const perDepth: number[] = [];
  const all = await collect(e.analyze("root", {}), () => {
    perDepth.push(evaluations);
    evaluations = 0;
  });
  // Depth 3 searched x (at ply 1) 2 plies deep and stored "<= -5". Depth 4
  // reaches x first at ply 2, needing 2 plies: the stored result settles it
  // (x cannot beat the draw), so x is not searched there. Then x at ply 1 is
  // searched to its end. Depth 4 evaluates nothing, yet it is not solved:
  // the stored result came from a search that hit the horizon.
  assertEquals(perDepth[3], 0);
  assertEquals(all.map((a) => a.depth), [1, 2, 3, 4, 5]);
  assertEquals(all.at(-1)!.lines, [{
    moves: ["draw"],
    score: { kind: "value", value: 0 },
  }]);
});

Deno.test("a stored Move index out of range counts as no hash Move", async () => {
  // Breaks the key requirement on purpose: "three" and "one" share a key but
  // not their Moves. "three" is searched first and stores its best Move,
  // index 2; "one" has a single Move.
  const graph = graphGame({
    root: { seat: "a", moves: ["three", "one"] },
    three: { seat: "b", moves: ["t1", "t2", "t3"] },
    one: { seat: "b", moves: ["o1"] },
    t1: {},
    t2: {},
    t3: { winner: "b" },
    o1: {},
  });
  const shared = (p: string) => (p === "three" || p === "one" ? "shared" : p);
  const rules = {
    ...graph,
    notation: { ...graph.notation, encodePosition: shared },
  };
  const e = createMinimaxEngine({ rules, name: "g", evaluate: () => 0 });
  const a = await final(e, "root", { lines: 2 });
  assertEquals(a.lines, [
    { moves: ["one", "o1"], score: { kind: "value", value: 0 } },
    { moves: ["three", "t3"], score: { kind: "loss-in", plies: 2 } },
  ]);
});

Deno.test("honours the Engine contract", async () => {
  await assertEngineContract(engine, ttt);
});

Deno.test("refuses Games with chance (ADR 0005)", () => {
  assertThrows(
    () =>
      createMinimaxEngine({
        // @ts-expect-error: a ChanceGameRules is refused at compile time
        rules: diceRace,
        evaluate: () => 0,
        name: "minimax",
      }),
    TypeError,
    "Chance events",
  );
  // Also at run time, when the type was widened to plain GameRules.
  const widened = diceRace as GameRules<unknown, unknown>;
  assertThrows(
    () => createMinimaxEngine({ rules: widened, evaluate: () => 0, name: "m" }),
    TypeError,
  );
});
