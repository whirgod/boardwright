import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { fileURLToPath } from "node:url";
import type { Analysis } from "@boardwright/core";
import { backgammon } from "@boardwright/game-backgammon";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import { assertEngineContract } from "@boardwright/testing";
import { EngineDriver } from "./engine-driver.ts";
import {
  type EngineAdapter,
  EngineRunner,
  type EngineRunnerOptions,
  routingAdapter,
  SearchError,
  type SearchFailure,
  workerAdapter,
} from "./engine-runner.ts";
import { runnerEngine, testWorkerAdapter } from "./engine-runner.testing.ts";
import { EngineRegistry, type ExternalEngineEntry } from "./engines.ts";
import {
  type EngineMessage,
  type ExternalAdapter,
  externalAdapter,
  type ExternalAdapterOptions,
  MAX_LINE_LENGTH,
  parseEngineMessage,
  pickAnalysis,
} from "./external-engine.ts";
import {
  readExternalEngineConfig,
  registerExternalEngines,
} from "./external-engine-config.ts";
import { GameMaster } from "./game-master.ts";
import { type AnyGameRules, GameRegistry } from "./games.ts";
import { InMemoryMatchStore } from "./match-store.ts";

const EXAMPLE_DIR = fileURLToPath(
  new URL("../../../examples/random-engine/", import.meta.url),
);
const RANDOM_ENGINE = `${EXAMPLE_DIR}random-engine.ts`;
const TEST_ENGINE = fileURLToPath(
  new URL("./test-engines/external.ts", import.meta.url),
);
const START = ".........:x";

const random = (gameId = "tic-tac-toe"): ExternalEngineEntry => ({
  id: "random",
  name: "Random mover",
  gameId,
  external: { command: RANDOM_ENGINE },
});
/** The test Engine (`test-engines/external.ts`) in `mode`. */
const testEngine = (mode: string): ExternalEngineEntry => ({
  id: mode,
  name: mode,
  gameId: "tic-tac-toe",
  external: { command: TEST_ENGINE, args: [mode] },
});

/** Runs `fn` with an external adapter (stderr muted) and a runner on it, then closes. */
async function withRunner(
  fn: (runner: EngineRunner, adapter: ExternalAdapter) => Promise<void>,
  options: ExternalAdapterOptions = {},
  runnerOptions: EngineRunnerOptions = {},
): Promise<void> {
  const adapter = externalAdapter({ stderr: "null", ...options });
  const runner = new EngineRunner({ adapter, ...runnerOptions });
  try {
    await fn(runner, adapter);
  } finally {
    await adapter.close();
  }
}

interface Result {
  readonly seen: Analysis<string>[];
  readonly code: SearchFailure | undefined;
  readonly message?: string;
}

async function search(
  runner: EngineRunner,
  engine: ExternalEngineEntry,
  limits = {},
  signal?: AbortSignal,
): Promise<Result> {
  const seen: Analysis<string>[] = [];
  try {
    const analyses = runner.analyze(
      { engine, position: START, limits },
      signal ? { signal } : {},
    );
    for await (const analysis of analyses) seen.push(analysis);
    return { seen, code: undefined };
  } catch (error) {
    assert(error instanceof SearchError, String(error));
    return { seen, code: error.code, message: error.message };
  }
}

/** The Score value of a test Engine's Analysis: its process's search count. */
const searchCount = (result: Result) => {
  const score = result.seen[0]?.lines[0]?.score;
  return score?.kind === "value" ? score.value : undefined;
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("the example random Engine passes the Engine contract (tic-tac-toe)", async () => {
  await withRunner(async (runner) => {
    await assertEngineContract(
      runnerEngine(runner, random(), ticTacToe),
      ticTacToe,
    );
  });
});

Deno.test("the example random Engine passes the Engine contract (backgammon, with chance)", async () => {
  await withRunner(async (runner) => {
    await assertEngineContract(
      runnerEngine(runner, random("backgammon"), backgammon),
      backgammon,
      { positions: 4 },
    );
  });
});

Deno.test("a full Match between two external Engines, registered from the example config", async () => {
  const adapter = externalAdapter({ stderr: "null" });
  const runner = new EngineRunner({
    adapter: routingAdapter({ module: testWorkerAdapter(), external: adapter }),
  });
  try {
    const configs = await readExternalEngineConfig(
      `${EXAMPLE_DIR}external-engines.json`,
    );
    const entries = await registerExternalEngines(
      configs,
      adapter,
      new Set(["tic-tac-toe", "backgammon"]),
    );
    assertEquals(
      entries.map(({ gameId, id, name }) => ({ gameId, id, name })),
      [
        { gameId: "tic-tac-toe", id: "random", name: "Random mover" },
        { gameId: "backgammon", id: "random", name: "Random mover" },
      ],
    );
    const master = new GameMaster({
      games: new GameRegistry([ticTacToe as unknown as AnyGameRules]),
      store: new InMemoryMatchStore(),
      engines: new EngineRegistry(entries),
    });
    const driver = new EngineDriver(master, { runner });
    try {
      const player = {
        kind: "engine",
        engineId: "random",
        limits: {},
      } as const;
      const { match } = await master.createMatch("tic-tac-toe", {
        x: player,
        o: player,
      });
      await driver.idle();
      const view = await master.getMatch(match.id);
      assert(view.outcome !== null, "the Match has no Outcome");
      assertEquals(view.outcome.kind, "rules");
      assert(view.moves.length >= 5, `${view.moves.length} Moves`);
    } finally {
      await driver.close();
    }
  } finally {
    await adapter.close();
  }
});

Deno.test("a process is reused for search after search", async () => {
  await withRunner(async (runner) => {
    const counts = [];
    for (let i = 0; i < 3; i++) {
      counts.push(searchCount(await search(runner, testEngine("ok"))));
    }
    assertEquals(counts, [1, 2, 3]);
  });
});

Deno.test("concurrent searches of one Engine run on separate processes", async () => {
  await withRunner(async (runner) => {
    const results = await Promise.all(
      [1, 2, 3].map(() => search(runner, testEngine("ok"))),
    );
    assertEquals(results.map(searchCount), [1, 1, 1]);
  });
});

const PROTOCOL_ERRORS: [string, SearchFailure, RegExp][] = [
  ["exit-at-start", "worker-error", /exited with code 3/],
  ["silent", "timeout", /no ready within 300 ms/],
  ["refuse", "engine-error", /refused the handshake: not today/],
  ["wrong-game", "engine-error", /ready for Game "chess"/],
  ["wrong-protocol", "engine-error", /speaks protocol 2/],
  ["junk-hello", "unreadable-reply", /not a protocol message: hello there/],
  ["early-analysis", "unreadable-reply", /analysis message before ready/],
  ["junk", "unreadable-reply", /not a protocol message: bestmove a1/],
  ["unknown-type", "unreadable-reply", /not a protocol message/],
  ["wrong-id", "unreadable-reply", /unexpected analysis message/],
  ["long-line", "unreadable-reply", /line too long/],
  ["unterminated", "unreadable-reply", /line too long/],
  ["bad-analysis", "unreadable-reply", /malformed Analysis/],
];

for (const [mode, code, message] of PROTOCOL_ERRORS) {
  Deno.test(`protocol error: '${mode}' fails with '${code}'`, async () => {
    await withRunner(async (runner) => {
      const result = await search(runner, testEngine(mode));
      assertEquals(result.code, code);
      assertMatch(result.message!, message);
    }, { handshakeTimeoutMs: 300 });
  });
}

Deno.test("a command the server may not run fails with 'worker-error'", async () => {
  await withRunner(async (runner) => {
    const engine = {
      ...testEngine("ok"),
      external: { command: "/bin/true" },
    };
    const result = await search(runner, engine);
    assertEquals(result.code, "worker-error");
    assertMatch(result.message!, /did not start/);
  });
});

Deno.test("an error message fails the search with 'engine-error' and keeps the process", async () => {
  await withRunner(async (runner) => {
    const engine = testEngine("error");
    assertEquals(searchCount(await search(runner, engine)), 1);
    const failed = await search(runner, engine);
    assertEquals(failed.code, "engine-error");
    assertMatch(failed.message!, /cannot analyze/);
    assertEquals(searchCount(await search(runner, engine)), 3);
  });
});

Deno.test("a crash mid-search fails with 'worker-error' after what was streamed; a fresh process follows", async () => {
  await withRunner(async (runner) => {
    const engine = testEngine("exit-mid-search");
    const crashed = await search(runner, engine);
    assertEquals(crashed.code, "worker-error");
    assertEquals(crashed.seen.length, 1);
    assertMatch(crashed.message!, /exited with code 4/);
    assertEquals(searchCount(await search(runner, engine)), 1);
  });
});

Deno.test("an aborted search sends stop; the process finishes it and is reused", async () => {
  await withRunner(async (runner) => {
    const engine = testEngine("stream");
    const controller = new AbortController();
    const seen: Analysis<string>[] = [];
    const error = await assertRejects(async () => {
      const analyses = runner.analyze(
        { engine, position: START, limits: {} },
        { signal: controller.signal },
      );
      for await (const analysis of analyses) {
        seen.push(analysis);
        if (seen.length === 2) controller.abort();
      }
    }, SearchError);
    assertEquals(error.code, "aborted");
    await pause(200); // The process answers `stop` with `done`.
    // Breaking out of the loop stops a search the same way.
    for await (
      const _ of runner.analyze({ engine, position: START, limits: {} })
    ) break;
    await pause(200);
    const reused = runner.analyze({ engine, position: START, limits: {} });
    for await (const analysis of reused) {
      assertEquals(analysis.lines[0]!.score, { kind: "value", value: 3 });
      break;
    }
  });
});

Deno.test("a search past its deadline times out; a process ignoring stop is killed and replaced", async () => {
  await withRunner(
    async (runner) => {
      const engine = testEngine("deaf");
      const result = await search(runner, engine, { maxTimeMs: 50 });
      assertEquals(result.code, "timeout");
      assert(result.seen.length > 0);
      await pause(300); // stopTimeoutMs: the process is killed.
      const again = runner.analyze({ engine, position: START, limits: {} });
      for await (const analysis of again) {
        assertEquals(analysis.lines[0]!.score, { kind: "value", value: 1 });
        break;
      }
    },
    { stopTimeoutMs: 100 },
    { graceMs: 50 },
  );
});

Deno.test("restart policy: after maxFailures failures in a row the Engine cools down, then retries", async () => {
  await withRunner(async (runner) => {
    const engine = testEngine("exit-at-start");
    for (let i = 0; i < 2; i++) {
      assertMatch((await search(runner, engine)).message!, /exited/);
    }
    const refused = await search(runner, engine);
    assertEquals(refused.code, "worker-error");
    assertMatch(refused.message!, /failed 2 times in a row; cooling down/);
    await pause(350);
    assertMatch((await search(runner, engine)).message!, /exited/);
    assertMatch((await search(runner, engine)).message!, /cooling down/);
  }, { maxFailures: 2, cooldownMs: 300 });
});

Deno.test("a successful search resets the failure count", async () => {
  await withRunner(async (runner) => {
    const engine = testEngine("error");
    // `error` fails every second search, but the process works: no cool-down.
    for (let i = 0; i < 4; i++) {
      assertEquals((await search(runner, engine)).seen.length, 1 - (i % 2));
    }
  }, { maxFailures: 1 });
});

Deno.test("fields outside the Analysis shape are dropped", async () => {
  await withRunner(async (runner) => {
    const result = await search(runner, testEngine("extra-fields"));
    assertEquals(result.seen, [{
      depth: 1,
      lines: [{ moves: ["a1"], score: { kind: "value", value: 1 } }],
    }]);
  });
});

Deno.test("connect handshakes once and keeps the process for the first search", async () => {
  await withRunner(async (runner, adapter) => {
    assertEquals(await adapter.connect(testEngine("ok")), "External test");
    assertEquals(searchCount(await search(runner, testEngine("ok"))), 1);
    const aborted = new AbortController();
    aborted.abort();
    const error = await assertRejects(
      () => adapter.connect(testEngine("silent"), aborted.signal),
      SearchError,
    );
    assertEquals(error.code, "aborted");
  });
});

Deno.test("close() kills busy processes and refuses later searches", async () => {
  const adapter = externalAdapter({ stderr: "null" });
  const runner = new EngineRunner({ adapter });
  const busy = search(runner, testEngine("stream"));
  await pause(300);
  await adapter.close();
  const result = await busy;
  assertEquals(result.code, "worker-error");
  assert(result.seen.length > 0);
  const later = await search(runner, testEngine("ok"));
  assertEquals(later.code, "worker-error");
  assertMatch(later.message!, /shut down/);
});

Deno.test("the external adapter refuses module Engines; the worker adapter external ones", async () => {
  const adapter = externalAdapter();
  const moduleEntry = {
    id: "m",
    name: "M",
    gameId: "tic-tac-toe",
    module: "file:///unused.ts",
  };
  assertThrows(
    () =>
      adapter.analyze(
        { engine: moduleEntry, position: START, limits: {} },
        new AbortController().signal,
      ),
    SearchError,
    "not an external Engine",
  );
  await adapter.close();
  const runner = new EngineRunner({ adapter: workerAdapter() });
  const result = await search(runner, testEngine("ok"));
  assertEquals(result.code, "engine-error");
  assertMatch(result.message!, /not a module Engine/);
});

Deno.test("routingAdapter sends each search to the adapter of its Engine's kind", async () => {
  const tagged = (tag: number): EngineAdapter => ({
    async *analyze() {
      yield { depth: tag, lines: [] };
    },
  });
  const runner = new EngineRunner({
    adapter: routingAdapter({ module: tagged(1), external: tagged(2) }),
  });
  const depthOf = async (
    engine: Parameters<EngineRunner["analyze"]>[0]["engine"],
  ) => {
    for await (
      const a of runner.analyze({ engine, position: START, limits: {} })
    ) {
      return a.depth;
    }
  };
  assertEquals(
    await depthOf({ id: "m", name: "M", gameId: "tic-tac-toe", module: "x:" }),
    1,
  );
  assertEquals(await depthOf(testEngine("ok")), 2);
});

Deno.test("parseEngineMessage accepts protocol messages only", () => {
  const valid: EngineMessage[] = [
    { type: "ready", protocol: 1, gameId: "g", name: "N" },
    { type: "analysis", id: 1, analysis: { depth: 1 } },
    { type: "done", id: 2 },
    { type: "error", message: "m" },
    { type: "error", id: 3, message: "m" },
  ];
  for (const message of valid) {
    assertEquals(parseEngineMessage(JSON.stringify(message)), message);
  }
  assertEquals(
    parseEngineMessage('{"type":"done","id":1,"extra":true}'),
    { type: "done", id: 1 },
  );
  const invalid = [
    "not json",
    "null",
    "[1]",
    '{"type":"ready","protocol":1,"gameId":"g","name":""}',
    '{"type":"ready","protocol":"1","gameId":"g","name":"N"}',
    '{"type":"analysis","id":1}',
    '{"type":"analysis","id":1.5,"analysis":{}}',
    '{"type":"done"}',
    '{"type":"error","id":1}',
    '{"type":"error","id":"1","message":"m"}',
    '{"type":"bestmove","id":1}',
  ];
  for (const line of invalid) assertEquals(parseEngineMessage(line), undefined);
  assert(MAX_LINE_LENGTH >= 1 << 20);
});

Deno.test("pickAnalysis keeps the Analysis fields and passes odd shapes on", () => {
  assertEquals(pickAnalysis(7), 7 as unknown as Analysis<string>);
  assertEquals(
    pickAnalysis({
      depth: 1,
      lines: "x",
      score: { kind: "value", value: 1 },
      seat: "x",
      z: 1,
    }),
    {
      depth: 1,
      lines: "x",
      score: { kind: "value", value: 1 },
      seat: "x",
    } as unknown as Analysis<string>,
  );
  assertEquals(
    pickAnalysis({ depth: 1, lines: [null] }),
    { depth: 1, lines: [null] } as unknown as Analysis<string>,
  );
});
