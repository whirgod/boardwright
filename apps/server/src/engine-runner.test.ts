import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Analysis } from "@boardwright/core";
import {
  type AnalysisRequest,
  DEFAULT_SEARCH_TIME_MS,
  type EngineAdapter,
  EngineRunner,
  type EngineRunnerOptions,
  inProcessAdapter,
  SearchError,
  type SearchFailure,
  workerAdapter,
} from "./engine-runner.ts";
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

/** An adapter yielding `items` in order, recording the requests it gets. */
function scripted(items: unknown[], requests: AnalysisRequest[] = []) {
  return {
    requests,
    adapter: {
      async *analyze(req: AnalysisRequest) {
        requests.push(req);
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

Deno.test("a malformed Analysis from an adapter fails with 'unreadable-reply'", async () => {
  for (
    const bad of [
      null,
      { depth: -1, lines: [] },
      { depth: 1.5, lines: [] },
      { depth: 1 },
      { depth: 1, lines: [null] },
      { depth: 1, lines: [{ moves: [3], score: { kind: "value", value: 0 } }] },
      { depth: 1, lines: [{ moves: ["a1"] }] },
    ]
  ) {
    const { adapter } = scripted([streamed(1), bad]);
    const result = await outcome(
      new EngineRunner({ adapter }).analyze(request(MINIMAX)),
    );
    assertEquals(result, { seen: [streamed(1)], code: "unreadable-reply" });
  }
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

Deno.test("an abandoned stream frees its slot at the deadline", async () => {
  const { adapter } = scripted([streamed(1), streamed(2)]);
  const runner = new EngineRunner({ adapter, graceMs: 30, maxConcurrent: 1 });
  const abandoned = runner.analyze(request(MINIMAX, { maxTimeMs: 0 }));
  assertEquals((await abandoned.next()).value, streamed(1));
  // Never resumed nor returned; the next search still gets the slot.
  assertEquals(await collect(runner.analyze(request(MINIMAX))), [
    streamed(1),
    streamed(2),
  ]);
  // Resuming after the deadline reports it.
  const late = await outcome({ [Symbol.asyncIterator]: () => abandoned });
  assertEquals(late, { seen: [], code: "timeout" });
});
