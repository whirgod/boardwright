import { assert, assertEquals, assertThrows } from "@std/assert";
import type { Analysis, GameRules, Seat } from "@boardwright/core";
import { createMinimaxEngine, type MinimaxOptions } from "./mod.ts";

// --- Helpers ---------------------------------------------------------------

async function final<P, M>(
  options: MinimaxOptions<P, M>,
  position: P,
  limits: { maxDepth: number; lines?: number },
): Promise<Analysis<M>> {
  let last: Analysis<M> | undefined;
  for await (
    const a of createMinimaxEngine(options).analyze(position, limits)
  ) {
    last = a;
  }
  assert(last, "no Analysis yielded");
  return last;
}

/** `rules` whose `play` throws after `max` Moves, so a runaway search fails. */
function budgeted<P, M>(rules: GameRules<P, M>, max: number) {
  const count = { nodes: 0 };
  const counted: GameRules<P, M> = {
    ...rules,
    play(p, m) {
      if (++count.nodes > max) {
        throw new Error(`played more than ${max} Moves: the search went on`);
      }
      return rules.play(p, m);
    },
  };
  return { rules: counted, count };
}

interface GraphNode {
  readonly seat?: Seat;
  readonly moves?: readonly string[];
  readonly winner?: Seat;
}

/** A Game on a directed graph: a Position is a node, a Move its target. */
function graph(nodes: Readonly<Record<string, GraphNode>>) {
  const node = (p: string) => nodes[p]!;
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
  return rules;
}

/** Positions whose name starts with "c" are "checks". */
const isCheck = (p: string) => p.startsWith("c");

// A forced sequence: the check "c1" has one reply, then "r" wins by "w".
// "quiet" has no such thing. Nominal depth 2 ends at "r" (value 0).
const FORCED = {
  root: { seat: "a", moves: ["quiet", "c1"] },
  quiet: { seat: "b", moves: ["q2"] },
  q2: { seat: "a", moves: ["q3"] },
  q3: { seat: "b", moves: ["q4"] },
  q4: { seat: "a", moves: ["q5"] },
  q5: { seat: "b", moves: ["q6"] },
  q6: { seat: "a", moves: ["q7"] },
  q7: { seat: "b", moves: [] },
  c1: { seat: "b", moves: ["r"] },
  r: { seat: "a", moves: ["w"] },
  w: { winner: "a" },
} as const;

Deno.test("a forced check sequence just past the nominal depth is found", async () => {
  const base = { rules: graph(FORCED), evaluate: () => 0, name: "g" };
  const plain = await final(base, "root", { maxDepth: 2 });
  assertEquals(plain.lines[0]!.score, { kind: "value", value: 0 });
  const extended = await final({ ...base, extend: isCheck }, "root", {
    maxDepth: 2,
  });
  assertEquals(extended.depth, 2);
  assertEquals(extended.lines[0], {
    moves: ["c1", "r", "w"],
    score: { kind: "win-in", plies: 3 },
  });
});

Deno.test("without the option, or when it never fires, the search is unchanged", async () => {
  const run = async (extra: Partial<MinimaxOptions<string, string>>) => {
    const { rules, count } = budgeted(graph(FORCED), 10_000);
    const a = await final(
      { rules, evaluate: () => 0, name: "g", ...extra },
      "root",
      { maxDepth: 3, lines: 2 },
    );
    return { a, nodes: count.nodes };
  };
  const plain = await run({});
  assertEquals(await run({ extend: () => false }), plain);
  assertEquals(await run({ extend: isCheck, maxExtensions: 0 }), plain);
});

// Endless checks: from every Position, two Moves, all leading to a "check".
const endless: GameRules<number, number> = {
  id: "endless",
  name: "Endless checks",
  seats: ["a", "b"],
  initialPosition: () => 0,
  toMove: (p) => (p % 2 === 0 ? "a" : "b"),
  legalMoves: () => [0, 1],
  play: (p, m) => p * 2 + m + 1, // all distinct: no transpositions
  outcome: () => undefined,
  notation: {
    encodePosition: String,
    decodePosition: Number,
    encodeMove: String,
    decodeMove: Number,
  },
};

// Nodes searched (alpha-beta prunes some of the full tree), deterministic:
// no table, all Positions distinct.
const EXACT: Record<string, number> = {
  "0/3": 17,
  "1/3": 35,
  "2/3": 70,
  "3/1": 28,
};

Deno.test("the bound holds on a Game with endless checks", async () => {
  for (
    const [maxExtensions, depth] of [[0, 3], [1, 3], [2, 3], [3, 1]] as const
  ) {
    const { rules, count } = budgeted(endless, 100_000);
    const a = await final(
      {
        rules,
        evaluate: (p) => p % 7,
        name: "e",
        extend: () => true,
        maxExtensions,
        tableBytes: 0,
      },
      0,
      { maxDepth: depth },
    );
    assertEquals(a.lines[0]!.moves.length, depth + maxExtensions);
    // Each iteration is at most a full binary tree of depth + maxExtensions plies.
    let expected = 0;
    for (let d = 1; d <= depth; d++) {
      expected += 2 ** (d + maxExtensions + 1) - 2;
    }
    assert(count.nodes <= expected, `${count.nodes} > ${expected}`);
    assertEquals(count.nodes, EXACT[`${maxExtensions}/${depth}`]);
  }
  const { rules } = budgeted(endless, 100_000);
  // The default bound applies without an explicit one.
  const d = await final(
    { rules, evaluate: (p) => p % 7, name: "e", extend: () => true },
    0,
    { maxDepth: 1 },
  );
  assertEquals(d.lines[0]!.moves.length, 1 + 4);
});

Deno.test("an invalid maxExtensions is a RangeError", () => {
  for (const maxExtensions of [-1, 1.5, NaN]) {
    assertThrows(
      () =>
        createMinimaxEngine({
          rules: endless,
          evaluate: () => 0,
          name: "e",
          maxExtensions,
        }),
      RangeError,
    );
  }
});

// "t" is reached by "x" (normal) first and by "c2" (a check, extended) after:
// the same ply, searched one ply deeper the second time, which sees the win.
const TRANSPOSED = {
  root: { seat: "a", moves: ["x", "c2"] },
  x: { seat: "b", moves: ["t"] },
  c2: { seat: "b", moves: ["t"] },
  t: { seat: "a", moves: ["t1"] },
  t1: { seat: "b", moves: ["t2"] },
  t2: { seat: "a", moves: ["w"] },
  w: { winner: "a" },
} as const;

Deno.test("an entry stored by a shallower visit never answers a probe needing more depth", async () => {
  for (const tableBytes of [0, 1 << 20]) {
    const a = await final(
      {
        rules: graph(TRANSPOSED),
        evaluate: () => 0,
        name: "g",
        extend: isCheck,
        tableBytes,
      },
      "root",
      { maxDepth: 4 },
    );
    assertEquals(a.lines[0], {
      moves: ["c2", "t", "t1", "t2", "w"],
      score: { kind: "win-in", plies: 5 },
    });
  }
});
