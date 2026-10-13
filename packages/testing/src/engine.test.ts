import { assertRejects } from "@std/assert";
import type {
  Analysis,
  Engine,
  GameRules,
  Line,
  SearchLimits,
} from "@boardwright/core";
import { assertEngineContract, type EngineContractOptions } from "./mod.ts";

// Toy Game: Nim with a pile of 5; take 1 or 2 stones; taking the last wins.
interface P {
  readonly n: number;
  readonly turn: "a" | "b";
}
type Move = string;

const nim: GameRules<P, Move> = {
  id: "nim",
  name: "Nim",
  seats: ["a", "b"],
  initialPosition: () => ({ n: 5, turn: "a" }),
  toMove: (p) => (p.n === 0 ? undefined : p.turn),
  legalMoves: (p) => ["t1", "t2"].filter((m) => Number(m[1]) <= p.n),
  play(p, m) {
    if (!nim.legalMoves(p).includes(m)) throw new Error(`illegal ${m}`);
    return { n: p.n - Number(m[1]), turn: p.turn === "a" ? "b" : "a" };
  },
  outcome: (p) =>
    p.n === 0
      ? { winner: p.turn === "a" ? "b" : "a", reason: "last-stone" }
      : undefined,
  notation: {
    encodePosition: (p) => `${p.n}:${p.turn}`,
    decodePosition(text) {
      const m = /^([0-5]):([ab])$/.exec(text);
      if (!m) throw new Error("bad position");
      return { n: Number(m[1]), turn: m[2] as "a" | "b" };
    },
    encodeMove: (m) => m,
    decodeMove(text) {
      if (!/^t[12]$/.test(text)) throw new Error("bad move");
      return text;
    },
  },
};

type Bug =
  | "repeated-depth"
  | "hang-after-abort"
  | "empty-stream-time-zero"
  | "empty-lines"
  | "tied-win-order"
  | "illegal-line"
  | "illegal-continuation"
  | "no-range-error"
  | "async-range-error"
  | "ignore-abort"
  | "clock-from-analyze"
  | "terminal-lines"
  | "unsorted-lines"
  | "bad-score"
  | "wrong-game"
  | "too-many-lines"
  | "duplicate-first-move";

/**
 * A small, correct iterative-deepening Engine for the toy Game, with one
 * switchable defect. Scores are heuristic (pile parity) and never exact.
 */
function makeEngine(bug?: Bug): Engine<P, Move> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function* run(
    position: P,
    limits: SearchLimits,
    signal: AbortSignal | undefined,
    created: number,
  ): AsyncGenerator<Analysis<Move>> {
    if (nim.toMove(position) === undefined) {
      yield {
        depth: 0,
        lines: bug === "terminal-lines"
          ? [{ moves: [], score: { kind: "value", value: 0 } }]
          : [],
      };
      return;
    }
    if (signal?.aborted) return; // pre-aborted: every variant honours this
    if (bug === "empty-stream-time-zero" && limits.maxTimeMs === 0) return;
    const start = bug === "clock-from-analyze" ? created : performance.now();
    const maxDepth = limits.maxDepth ?? 5;
    for (let depth = 1; depth <= maxDepth; depth++) {
      if (bug === "hang-after-abort" && signal?.aborted) {
        await new Promise(() => {});
      }
      if (bug !== "ignore-abort" && signal?.aborted) return;
      if (
        limits.maxTimeMs !== undefined &&
        performance.now() - start > limits.maxTimeMs && depth > 1 &&
        bug !== "clock-from-analyze"
      ) return;
      if (
        bug === "clock-from-analyze" && limits.maxTimeMs !== undefined &&
        performance.now() - start > limits.maxTimeMs + 5
      ) return;
      await sleep(2);
      const wanted = limits.lines ?? 1;
      const lines: Line<Move>[] = nim.legalMoves(position).map((m) => ({
        moves: [m],
        score: {
          kind: "value",
          value: Number(m[1]) === position.n % 3 ? 1 : 0,
        },
      }));
      lines.sort((a, b) =>
        (b.score.kind === "value" ? b.score.value : 0) -
        (a.score.kind === "value" ? a.score.value : 0)
      );
      let out = lines.slice(0, wanted);
      if (bug === "empty-lines") out = [];
      if (bug === "tied-win-order" && wanted > 1 && lines.length > 1) {
        // win-in 5 listed before win-in 3: not best first
        out = [
          { moves: lines[0]!.moves, score: { kind: "win-in", plies: 5 } },
          { moves: lines[1]!.moves, score: { kind: "win-in", plies: 3 } },
        ];
      }
      if (bug === "unsorted-lines") out = [...out].reverse();
      if (bug === "illegal-line") {
        out = [{ moves: ["t9"], score: { kind: "value", value: 0 } }];
      }
      if (bug === "illegal-continuation") {
        // after taking all stones the Game is over, yet the Line continues
        out = [{ moves: ["t2", "t2", "t2", "t2"], score: out[0]!.score }];
      }
      if (bug === "bad-score") {
        out = [{ moves: out[0]!.moves, score: { kind: "value", value: NaN } }];
      }
      if (bug === "too-many-lines") out = [...lines, ...lines];
      if (bug === "duplicate-first-move" && wanted > 1) {
        out = [out[0]!, out[0]!];
      }
      yield {
        depth: bug === "repeated-depth" && depth === 2 ? 1 : depth,
        lines: out,
      };
    }
    if (bug === "ignore-abort" && signal?.aborted) {
      for (;;) {
        await Promise.resolve();
        yield { depth: maxDepth, lines: [] };
      }
    }
  }
  return {
    name: "toy",
    gameId: bug === "wrong-game" ? "other" : "nim",
    analyze(position, limits, signal) {
      if (bug !== "no-range-error" && bug !== "async-range-error") {
        validate(limits);
      }
      const created = performance.now();
      const gen = run(position, limits, signal, created);
      if (bug === "async-range-error") {
        return (async function* () {
          validate(limits);
          yield* gen;
        })();
      }
      return gen;
    },
  };
}

function validate(limits: SearchLimits) {
  const { maxDepth, maxTimeMs, lines } = limits;
  if (
    maxDepth !== undefined && !(Number.isInteger(maxDepth) && maxDepth >= 1)
  ) throw new RangeError("maxDepth");
  if (maxTimeMs !== undefined && !(maxTimeMs >= 0)) {
    throw new RangeError("maxTimeMs");
  }
  if (lines !== undefined && !(Number.isInteger(lines) && lines >= 1)) {
    throw new RangeError("lines");
  }
}

const fast = { stepTimeoutMs: 300, slackMs: 150 };

async function expectFailure(
  bug: Bug | undefined,
  message: string,
  options: EngineContractOptions<P> = fast,
) {
  const err = await assertRejects(() =>
    assertEngineContract(makeEngine(bug), nim, options)
  );
  const text = (err as Error).message;
  if (!text.includes(message) || !text.includes("seed=")) {
    throw new Error(`expected "${message}" (with seed) in: ${text}`);
  }
}

Deno.test("engine contract: passes for a correct Engine", async () => {
  await assertEngineContract(makeEngine(), nim, fast);
});

Deno.test("engine contract: catches a repeated depth", async () => {
  await expectFailure("repeated-depth", "strictly increasing");
});

Deno.test("engine contract: catches an illegal Move in a Line", async () => {
  await expectFailure("illegal-line", "Line [t9] has illegal Move t9");
});

Deno.test("engine contract: catches a Line running past the end", async () => {
  await expectFailure(
    "illegal-continuation",
    "Line [t2 t2 t2 t2] has illegal Move",
  );
});

Deno.test("engine contract: catches missing RangeError on bad limits", async () => {
  await expectFailure("no-range-error", "must throw a RangeError");
});

Deno.test("engine contract: catches an asynchronous RangeError", async () => {
  await expectFailure("async-range-error", "synchronously");
});

Deno.test("engine contract: catches an ignored mid-search abort", async () => {
  await expectFailure(
    "ignore-abort",
    "mid-search abort: stream still yielding",
  );
});

Deno.test("engine contract: catches a hang after abort", async () => {
  await expectFailure(
    "hang-after-abort",
    "mid-search abort: stream did not end",
  );
});

Deno.test("engine contract: catches no Analysis under maxTimeMs 0", async () => {
  await expectFailure("empty-stream-time-zero", "no Analysis yielded");
});

Deno.test("engine contract: catches empty Lines for a non-terminal Position", async () => {
  await expectFailure("empty-lines", "0 Lines, expected 1..");
});

Deno.test("engine contract: orders win-in by plies", async () => {
  await expectFailure("tied-win-order", "not best first");
});

Deno.test("engine contract: fails when no terminal Position is found", async () => {
  await expectFailure(undefined, "pass `terminalPositions`", {
    ...fast,
    maxPlies: 2,
  });
});

Deno.test("engine contract: accepts supplied terminalPositions", async () => {
  await assertEngineContract(makeEngine(), nim, {
    ...fast,
    maxPlies: 2,
    terminalPositions: [{ n: 0, turn: "a" }],
  });
});

Deno.test("engine contract: catches time counted from analyze()", async () => {
  await expectFailure("clock-from-analyze", "first next()");
});

Deno.test("engine contract: catches Lines for a terminal Position", async () => {
  await expectFailure("terminal-lines", "terminal Position");
});

Deno.test("engine contract: catches Lines that are not best first", async () => {
  await expectFailure("unsorted-lines", "best first");
});

Deno.test("engine contract: catches a malformed Score", async () => {
  await expectFailure("bad-score", "malformed Score");
});

Deno.test("engine contract: catches a wrong gameId", async () => {
  await expectFailure("wrong-game", "gameId");
});

Deno.test("engine contract: catches more Lines than requested", async () => {
  await expectFailure("too-many-lines", "expected 1..");
});

Deno.test("engine contract: catches duplicate first Moves", async () => {
  await expectFailure("duplicate-first-move", "two Lines start with");
});

Deno.test("engine contract: catches an ignored time limit", async () => {
  // Ignoring maxTimeMs is only observable when the search is long; the toy
  // search is short, so make it long by slowing each depth.
  async function* gen(position: P, limits: SearchLimits) {
    if (nim.toMove(position) === undefined) {
      yield { depth: 0, lines: [] };
      return;
    }
    for (let depth = 1;; depth++) {
      await new Promise((r) => setTimeout(r, 50));
      const m = nim.legalMoves(position)[0] as Move;
      yield {
        depth,
        lines: [{ moves: [m], score: { kind: "value" as const, value: 0 } }],
      };
      if (depth >= (limits.maxDepth ?? 20)) return;
    }
  }
  const slow: Engine<P, Move> = {
    ...makeEngine(),
    analyze(position, limits) {
      validate(limits);
      return gen(position, limits);
    },
  };
  const err = await assertRejects(() =>
    assertEngineContract(slow, nim, {
      stepTimeoutMs: 5000,
      slackMs: 50,
      positions: 2,
    })
  );
  if (!(err as Error).message.includes("maxTimeMs=30 search ran")) throw err;
});
