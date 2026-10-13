import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { Analysis } from "@boardwright/core";
import {
  type AnalysisRequest,
  DEFAULT_SEARCH_TIME_MS,
  type EngineAdapter,
  EngineRunner,
  type EngineRunnerOptions,
  SearchError,
  type SearchFailure,
  type SearchPurpose,
  workerAdapter,
} from "./engine-runner.ts";
import { inProcessAdapter } from "./engine-runner.testing.ts";
import type { EngineEntry } from "./engines.ts";

const START = ".........:x";
/** The first legal Move in turn from START, as `test-engines/stream.ts` plays them. */
const FIRST_MOVES = ["a1", "b1", "c1", "a2", "b2"];

const entry = (name: string): EngineEntry => ({
  id: name,
  name,
  gameId: "tic-tac-toe",
  module: import.meta.resolve(`./test-engines/${name}.ts`),
});
const MINIMAX: EngineEntry = {
  id: "minimax",
  name: "Minimax",
  gameId: "tic-tac-toe",
  module: import.meta.resolve("@boardwright/engine-tic-tac-toe-minimax"),
};

const request = (
  engine: EngineEntry,
  limits = {},
  position = START,
): AnalysisRequest => ({ engine, position, limits });

const streamed = (depth: number): Analysis<string> => ({
  depth,
  lines: [{
    moves: FIRST_MOVES.slice(0, depth),
    score: { kind: "value", value: depth },
  }],
});

async function collect(
  analyses: AsyncIterable<Analysis<string>>,
): Promise<Analysis<string>[]> {
  const seen: Analysis<string>[] = [];
  for await (const analysis of analyses) seen.push(analysis);
  return seen;
}

/** Runs `analyses` to its end; resolves with what it yielded and its failure code. */
async function outcome(
  analyses: AsyncIterable<Analysis<string>>,
): Promise<{ seen: Analysis<string>[]; code: SearchFailure | undefined }> {
  const seen: Analysis<string>[] = [];
  try {
    for await (const analysis of analyses) seen.push(analysis);
    return { seen, code: undefined };
  } catch (error) {
    assert(error instanceof SearchError, String(error));
    return { seen, code: error.code };
  }
}

/** Lets in-process Engines notice an abort and wind down their timers. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

const ADAPTERS: [string, () => EngineAdapter][] = [
  ["worker", workerAdapter],
  ["in-process", inProcessAdapter],
];

for (const [label, adapter] of ADAPTERS) {
  const runner = (options: Omit<EngineRunnerOptions, "adapter"> = {}) =>
    new EngineRunner({ ...options, adapter: adapter() });

  Deno.test(`${label}: streams every Analysis in the Engine's order, in Notation`, async () => {
    const seen = await collect(runner().analyze(request(entry("stream"))));
    assertEquals(seen, [1, 2, 3, 4, 5].map(streamed));
  });

  Deno.test(`${label}: a real Engine's last Analysis holds its best Move`, async () => {
    const seen = await collect(
      runner().analyze(request(MINIMAX, {}, "xx.oo....:x")),
    );
    assert(seen.length > 0);
    assertEquals(seen.at(-1)!.lines[0]!.moves[0], "c1");
  });

  Deno.test(`${label}: an Analysis without Lines and with extra fields passes through`, async () => {
    const seen = await collect(runner().analyze(request(entry("expected"))));
    assertEquals(seen, [
      { depth: 2, lines: [], score: { kind: "value", value: 0.25 } },
    ] as unknown[]);
  });

  Deno.test(`${label}: aborting mid-stream stops the stream with 'aborted'`, async () => {
    const abort = new AbortController();
    const seen: Analysis<string>[] = [];
    const error = await assertRejects(async () => {
      const analyses = runner().analyze(request(entry("stream")), {
        signal: abort.signal,
      });
      for await (const analysis of analyses) {
        seen.push(analysis);
        if (analysis.depth === 2) abort.abort();
      }
    }, SearchError);
    assertEquals(error.code, "aborted");
    assertEquals(seen, [streamed(1), streamed(2)]);
    await settle();
  });

  Deno.test(`${label}: an already aborted signal never starts the Engine`, async () => {
    let started = false;
    const spy: EngineAdapter = {
      analyze(req, signal) {
        started = true;
        return adapter().analyze(req, signal);
      },
    };
    const result = await outcome(
      new EngineRunner({ adapter: spy }).analyze(request(MINIMAX), {
        signal: AbortSignal.abort(),
      }),
    );
    assertEquals(result, { seen: [], code: "aborted" });
    assertEquals(started, false);
  });

  Deno.test(`${label}: a stalled Engine is cut off at maxTimeMs + grace`, async () => {
    const started = performance.now();
    const result = await outcome(
      runner({ graceMs: 100 }).analyze(
        request(entry("stall"), { maxTimeMs: 50 }),
      ),
    );
    const took = performance.now() - started;
    assertEquals(result, { seen: [], code: "timeout" });
    assert(took >= 140 && took < 1000, `cut off after ${took} ms`);
  });

  Deno.test(`${label}: an Engine that throws fails with 'engine-error'`, async () => {
    const result = await outcome(runner().analyze(request(entry("crash"))));
    assertEquals(result, { seen: [], code: "engine-error" });
  });

  Deno.test(`${label}: an undecodable Position fails with 'engine-error'`, async () => {
    const result = await outcome(
      runner().analyze(request(MINIMAX, {}, "not a position")),
    );
    assertEquals(result, { seen: [], code: "engine-error" });
  });

  Deno.test(`${label}: searches beyond maxConcurrent wait for a slot`, async () => {
    const shared = runner({ maxConcurrent: 1 });
    const order: string[] = [];
    const run = async (name: string) => {
      for await (
        const analysis of shared.analyze(
          request(entry("stream"), { maxDepth: 2 }),
        )
      ) order.push(`${name}${analysis.depth}`);
    };
    await Promise.all([run("a"), run("b"), run("c")]);
    assertEquals(order, ["a1", "a2", "b1", "b2", "c1", "c2"]);
  });

  Deno.test(`${label}: aborting while queued gives up the wait, not the slot`, async () => {
    const shared = runner({ maxConcurrent: 1 });
    const abort = new AbortController();
    const first = collect(
      shared.analyze(request(entry("stream"), { maxDepth: 2 })),
    );
    const queued = outcome(
      shared.analyze(request(entry("stream")), { signal: abort.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort();
    assertEquals(await queued, { seen: [], code: "aborted" });
    assertEquals(await first, [streamed(1), streamed(2)]);
    // The slot is free again for the next search.
    assertEquals(
      await collect(shared.analyze(request(entry("stream"), { maxDepth: 1 }))),
      [streamed(1)],
    );
  });

  Deno.test(`${label}: breaking out of the stream stops the search and frees its slot`, async () => {
    const shared = runner({ maxConcurrent: 1 });
    for await (const _ of shared.analyze(request(entry("stream")))) break;
    assertEquals(
      await collect(shared.analyze(request(entry("stream"), { maxDepth: 1 }))),
      [streamed(1)],
    );
    await settle();
  });
}

Deno.test("worker: a busy (blocking) Engine is cut off at the deadline", async () => {
  const result = await outcome(
    new EngineRunner({ graceMs: 150 }).analyze(
      request(entry("hang"), { maxTimeMs: 0 }),
    ),
  );
  assertEquals(result, { seen: [], code: "timeout" });
});

Deno.test("worker: a crashing worker fails with 'worker-error' after what it streamed", async () => {
  const result = await outcome(
    new EngineRunner().analyze(request(entry("crash-worker"))),
  );
  assertEquals(result.code, "worker-error");
  assertEquals(result.seen.map((a) => a.lines[0]!.moves), [["a1"]]);
});

Deno.test("worker: a message outside the protocol fails with 'unreadable-reply'", async () => {
  const result = await outcome(
    new EngineRunner().analyze(request(entry("junk"))),
  );
  assertEquals(result, { seen: [], code: "unreadable-reply" });
});

/**
 * An adapter yielding `items` in order, recording the requests it gets and
 * the signals it is given (to check that the Engine is told to stop).
 */
function scripted(items: unknown[]) {
  const requests: AnalysisRequest[] = [];
  const signals: AbortSignal[] = [];
  return {
    requests,
    signals,
    adapter: {
      async *analyze(req: AnalysisRequest, signal: AbortSignal) {
        requests.push(req);
        signals.push(signal);
        for (const item of items) {
          await Promise.resolve();
          yield item as Analysis<string>;
        }
      },
    } satisfies EngineAdapter,
  };
}

Deno.test("an unset maxTimeMs reaches the adapter as the default", async () => {
  const { adapter, requests } = scripted([]);
  await collect(
    new EngineRunner({ adapter }).analyze(request(MINIMAX, { maxDepth: 3 })),
  );
  assertEquals(requests.map((r) => r.limits), [
    { maxDepth: 3, maxTimeMs: DEFAULT_SEARCH_TIME_MS },
  ]);
});

Deno.test("an invalid maxTimeMs throws a RangeError; a huge one is not cut short", async () => {
  const { adapter, requests } = scripted([streamed(1)]);
  const runner = new EngineRunner({ adapter });
  for (const maxTimeMs of [-1, NaN, "5" as unknown as number]) {
    await assertRejects(
      () => collect(runner.analyze(request(MINIMAX, { maxTimeMs }))),
      RangeError,
    );
  }
  assertEquals(requests, []);
  // 2 ** 31 ms overflows setTimeout; the deadline is clamped, not fired at once.
  assertEquals(
    await collect(runner.analyze(request(MINIMAX, { maxTimeMs: 2 ** 31 }))),
    [streamed(1)],
  );
});

Deno.test("invalid runner options throw a RangeError", () => {
  for (
    const options of [
      { maxConcurrent: 0 },
      { maxConcurrent: NaN },
      { maxConcurrent: 1.5 },
      { maxConcurrent: 2, reservedForMatches: 2 },
      { reservedForMatches: -1 },
      { maxQueued: -1 },
      { graceMs: -1 },
      { graceMs: NaN },
    ]
  ) {
    assertThrows(() => new EngineRunner(options), RangeError);
  }
});

Deno.test("a malformed Analysis from an adapter fails with 'unreadable-reply'", async () => {
  const line = (
    moves: unknown[],
    score: unknown = { kind: "value", value: 0 },
  ) => ({
    moves,
    score,
  });
  for (
    const bad of [
      null,
      { depth: -1, lines: [] },
      { depth: 1.5, lines: [] },
      { depth: 1 },
      { depth: 1, lines: [null] },
      { depth: 1, lines: [line([3])] },
      { depth: 1, lines: [line([])] },
      { depth: 1, lines: [{ moves: ["a1"] }] },
      { depth: 1, lines: [line(["a1"], {})] },
      { depth: 1, lines: [line(["a1"], { kind: "bogus" })] },
      { depth: 1, lines: [line(["a1"], { kind: "value", value: NaN })] },
      { depth: 1, lines: [line(["a1"], { kind: "win-in", plies: 1.5 })] },
      { depth: 1, lines: [line(["a1"], { kind: "loss-in", plies: -1 })] },
      { depth: 1, lines: [], score: { kind: "value" } },
      { depth: 1, lines: [], score: null },
      // More Lines than `limits.lines` (default 1).
      { depth: 1, lines: [line(["a1"]), line(["b1"])] },
    ]
  ) {
    const { adapter } = scripted([streamed(1), bad]);
    const result = await outcome(
      new EngineRunner({ adapter }).analyze(request(MINIMAX)),
    );
    assertEquals(
      result,
      { seen: [streamed(1)], code: "unreadable-reply" },
      JSON.stringify(bad),
    );
  }
});

Deno.test("well-formed Scores, an expected Score and limits.lines Lines pass", async () => {
  const good = [
    {
      depth: 1,
      lines: [
        { moves: ["a1"], score: { kind: "win-in", plies: 1 } },
        { moves: ["b1", "c1"], score: { kind: "loss-in", plies: 0 } },
      ],
    },
    { depth: 2, lines: [], score: { kind: "value", value: -0.5 } },
  ];
  const { adapter } = scripted(good);
  assertEquals(
    await collect(
      new EngineRunner({ adapter }).analyze(request(MINIMAX, { lines: 2 })),
    ),
    good as unknown[],
  );
});

Deno.test("an adapter that never settles is still cut off at the deadline", async () => {
  const adapter: EngineAdapter = {
    analyze: () => ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    }),
  };
  const result = await outcome(
    new EngineRunner({ adapter, graceMs: 20 }).analyze(
      request(MINIMAX, { maxTimeMs: 0 }),
    ),
  );
  assertEquals(result, { seen: [], code: "timeout" });
});

Deno.test("an adapter's own SearchError code is kept", async () => {
  const adapter: EngineAdapter = {
    // deno-lint-ignore require-yield
    async *analyze() {
      await Promise.resolve();
      throw new SearchError("worker-error", "gone");
    },
  };
  const result = await outcome(
    new EngineRunner({ adapter }).analyze(request(MINIMAX)),
  );
  assertEquals(result, { seen: [], code: "worker-error" });
});

Deno.test("breaking out of the stream tells the adapter to stop the Engine", async () => {
  const { adapter, signals } = scripted([streamed(1), streamed(2)]);
  for await (
    const _ of new EngineRunner({ adapter }).analyze(request(MINIMAX))
  ) {
    assertEquals(signals[0]!.aborted, false);
    break;
  }
  assertEquals(signals[0]!.aborted, true);
});

Deno.test("an abandoned stream stops its Engine and frees its slot at the deadline", async () => {
  const { adapter, signals } = scripted([streamed(1), streamed(2)]);
  const runner = new EngineRunner({ adapter, graceMs: 30, maxConcurrent: 1 });
  const abandoned = runner.analyze(request(MINIMAX, { maxTimeMs: 0 }));
  assertEquals((await abandoned.next()).value, streamed(1));
  // Never resumed nor returned; the next search still gets the slot.
  assertEquals(await collect(runner.analyze(request(MINIMAX))), [
    streamed(1),
    streamed(2),
  ]);
  assertEquals(signals.map((signal) => signal.aborted), [true, true]);
  // Resuming after the deadline reports it.
  const late = await outcome({ [Symbol.asyncIterator]: () => abandoned });
  assertEquals(late, { seen: [], code: "timeout" });
});

/**
 * An adapter whose searches each wait until released, so tests control when
 * slots free up. A search is named by its request's `position`.
 */
function gated() {
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const adapter: EngineAdapter = {
    async *analyze(req) {
      started.push(req.position);
      await new Promise<void>((resolve) => release.set(req.position, resolve));
      yield streamed(1);
    },
  };
  return { started, release: (name: string) => release.get(name)!(), adapter };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function search(
  runner: EngineRunner,
  name: string,
  purpose: SearchPurpose,
) {
  return outcome(runner.analyze(request(MINIMAX, {}, name), { purpose }));
}

Deno.test("Analysis requests leave the reserved slot to Match searches", async () => {
  const { started, release, adapter } = gated();
  const runner = new EngineRunner({ adapter, maxConcurrent: 2 });
  const a1 = search(runner, "a1", "analysis");
  const a2 = search(runner, "a2", "analysis");
  await tick();
  assertEquals(started, ["a1"]); // the second slot is reserved
  const m1 = search(runner, "m1", "match");
  await tick();
  assertEquals(started, ["a1", "m1"]);
  release("m1");
  await m1;
  await tick();
  assertEquals(started, ["a1", "m1"]); // still one Analysis at a time
  release("a1");
  await tick();
  assertEquals(started, ["a1", "m1", "a2"]);
  release("a2");
  assertEquals((await a1).code, undefined);
  assertEquals((await a2).code, undefined);
});

Deno.test("queued Match searches go ahead of queued Analysis requests", async () => {
  const { started, release, adapter } = gated();
  const runner = new EngineRunner({ adapter, maxConcurrent: 1 });
  const all = [
    search(runner, "a1", "analysis"),
    search(runner, "a2", "analysis"),
    search(runner, "m1", "match"),
    search(runner, "m2", "match"),
  ];
  for (const name of ["a1", "m1", "m2", "a2"]) {
    await tick();
    assertEquals(started.at(-1), name);
    release(name);
  }
  assertEquals((await Promise.all(all)).map((r) => r.code), [
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

Deno.test("Analysis requests beyond maxQueued are refused as 'busy'; Matches never", async () => {
  const { started, release, adapter } = gated();
  const runner = new EngineRunner({ adapter, maxConcurrent: 2, maxQueued: 1 });
  const a1 = search(runner, "a1", "analysis");
  const a2 = search(runner, "a2", "analysis");
  assertEquals(await search(runner, "a3", "analysis"), {
    seen: [],
    code: "busy",
  });
  const m1 = search(runner, "m1", "match");
  const m2 = search(runner, "m2", "match");
  await tick();
  assertEquals(started, ["a1", "m1"]);
  for (const name of ["m1", "m2", "a1", "a2"]) {
    await tick();
    release(name);
  }
  assertEquals((await Promise.all([a1, a2, m1, m2])).map((r) => r.code), [
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});
