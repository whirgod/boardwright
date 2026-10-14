import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { fileURLToPath } from "node:url";
import { type Analysis, chancePending } from "@boardwright/core";
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
  MAX_LINE_BYTES,
  MAX_NAME_LENGTH,
  parseEngineMessage,
  readAnalysis,
  shutdownHandler,
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
const LAUNCHER = fileURLToPath(
  new URL("./test-engines/external-launcher.sh", import.meta.url),
);
const ENV_ENGINE = fileURLToPath(
  new URL("./test-engines/env-engine.sh", import.meta.url),
);
const START = ".........:x";
const ttt = ticTacToe as unknown as AnyGameRules;
const bg = backgammon as unknown as AnyGameRules;
const GAMES = new GameRegistry([ttt, bg]);

const random = (gameId = "tic-tac-toe"): ExternalEngineEntry => ({
  id: "random",
  name: "Random mover",
  gameId,
  external: { command: RANDOM_ENGINE },
});
/** The test Engine (`test-engines/external.ts`) in `mode`. */
const testEngine = (mode: string, ...more: string[]): ExternalEngineEntry => ({
  id: [mode, ...more].join(" "),
  name: mode,
  gameId: "tic-tac-toe",
  external: { command: TEST_ENGINE, args: [mode, ...more] },
});

/** Runs `fn` with an external adapter (stderr muted) and a runner on it, then closes. */
async function withRunner(
  fn: (runner: EngineRunner, adapter: ExternalAdapter) => Promise<void>,
  options: Partial<ExternalAdapterOptions> = {},
  runnerOptions: EngineRunnerOptions = {},
): Promise<void> {
  const adapter = externalAdapter({ stderr: "null", games: GAMES, ...options });
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
  position = START,
): Promise<Result> {
  const seen: Analysis<string>[] = [];
  try {
    const analyses = runner.analyze(
      { engine, position, limits },
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

/** Starts a search and resolves with its iterator once the first Analysis arrived. */
async function firstAnalysis(
  runner: EngineRunner,
  engine: ExternalEngineEntry,
  limits = {},
) {
  const it = runner.analyze({ engine, position: START, limits })
    [Symbol.asyncIterator]();
  const first = await it.next();
  assert(!first.done, "no first Analysis");
  return { it, first: first.value };
}

/** Generous slack for slow CI runners (2 cores, cold caches). */
const SLACK = { slackMs: 3000, stepTimeoutMs: 30_000 };

Deno.test("the example random Engine passes the Engine contract (tic-tac-toe)", async () => {
  await withRunner(async (runner) => {
    await assertEngineContract(
      runnerEngine(runner, random(), ticTacToe),
      ticTacToe,
      SLACK,
    );
  });
});

Deno.test("the example random Engine passes the Engine contract (backgammon, with chance)", async () => {
  await withRunner(async (runner) => {
    await assertEngineContract(
      runnerEngine(runner, random("backgammon"), backgammon),
      backgammon,
      { positions: 4, ...SLACK },
    );
  });
});

Deno.test("a full Match between two external Engines, registered from the example config", async () => {
  const adapter = externalAdapter({ stderr: "null", games: GAMES });
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
      games: new GameRegistry([ttt]),
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
  ["bad-analysis", "unreadable-reply", /malformed Analysis: depth/],
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
  await withRunner(async (runner, adapter) => {
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
    await adapter.settled(); // The process answered `stop` with `done`.
    // Breaking out of the loop stops a search the same way.
    for await (
      const _ of runner.analyze({ engine, position: START, limits: {} })
    ) break;
    await adapter.settled();
    const { it, first } = await firstAnalysis(runner, engine);
    assertEquals(first.lines[0]!.score, { kind: "value", value: 3 });
    await it.return?.();
    await adapter.settled();
  });
});

Deno.test("a search past its deadline times out; a process ignoring stop is killed and replaced", async () => {
  await withRunner(
    async (runner, adapter) => {
      const engine = testEngine("deaf");
      await adapter.connect(engine); // Start-up outside the deadline.
      const result = await search(runner, engine, { maxTimeMs: 300 });
      assertEquals(result.code, "timeout");
      assert(result.seen.length > 0);
      await adapter.settled(); // No `done` within stopTimeoutMs: killed.
      const { it, first } = await firstAnalysis(runner, engine);
      assertEquals(first.lines[0]!.score, { kind: "value", value: 1 });
      await it.return?.();
      await adapter.settled();
    },
    { stopTimeoutMs: 100 },
    { graceMs: 300 },
  );
});

Deno.test("an aborted handshake completes in the background; the process is used next", async () => {
  await withRunner(async (runner, adapter) => {
    const engine = testEngine("ok");
    const controller = new AbortController();
    const pending = search(runner, engine, {}, controller.signal);
    await pause(0); // The search takes its slot and starts the process.
    controller.abort();
    assertEquals((await pending).code, "aborted");
    await adapter.settled();
    // The process the aborted search started: this is its first search.
    assertEquals(searchCount(await search(runner, engine)), 1);
    assertEquals(searchCount(await search(runner, engine)), 2);
  });
});

Deno.test("a launcher that does not exec cannot hold up close()", async () => {
  const adapter = externalAdapter({ stderr: "null", games: GAMES });
  const runner = new EngineRunner({ adapter });
  const engine: ExternalEngineEntry = {
    ...testEngine("deaf"),
    external: { command: LAUNCHER, args: ["deaf"] },
  };
  const { it } = await firstAnalysis(runner, engine);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    adapter.close().then(() => true),
    new Promise<false>((r) => timer = setTimeout(() => r(false), 10_000)),
  ]);
  clearTimeout(timer);
  assert(closed, "close() did not finish");
  let rest: unknown;
  try {
    while (!(await it.next()).done);
  } catch (error) {
    rest = error;
  }
  assert(rest instanceof SearchError && rest.code === "worker-error");
});

Deno.test("Engine processes get a cleared environment plus their configured env", async () => {
  await withRunner(async (_, adapter) => {
    const error = await assertRejects(
      () =>
        adapter.connect({
          ...testEngine("env"),
          external: { command: ENV_ENGINE, env: { ENGINE_KEY: "1" } },
        }),
      SearchError,
    );
    const names = error.message.split("handshake: ")[1]!.trim().split(" ");
    assert(names.includes("ENGINE_KEY"), names.join(" "));
    assert(names.includes("PATH"), names.join(" "));
    // Only the inherited allowlist, the Engine's own and what sh sets itself.
    const allowed = ["PATH", "HOME", "LANG", "ENGINE_KEY", "PWD", "SHLVL", "_"];
    assertEquals(names.filter((n) => !allowed.includes(n)), []);
  });
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

Deno.test("Analyses are rebuilt: extra fields go, Moves are re-encoded", async () => {
  await withRunner(async (runner) => {
    const sent = {
      depth: 1,
      x: 1,
      lines: [{
        moves: ["a1", "b2"],
        note: "x",
        score: { kind: "value", value: 1, leak: "y" },
      }],
    };
    const result = await search(
      runner,
      testEngine("send", JSON.stringify(sent)),
    );
    assertEquals(result.seen, [{
      depth: 1,
      lines: [{ moves: ["a1", "b2"], score: { kind: "value", value: 1 } }],
    }]);
  });
});

const BAD_LINES: [string, Record<string, unknown>, RegExp][] = [
  ["an illegal Move", { moves: ["a1", "a1"] }, /illegal Move a1/],
  ["an undecodable Move", { moves: ["zz9"] }, /undecodable Move zz9/],
  ["a markup Move", { moves: ["<img src=x>"] }, /undecodable Move <img/],
  ["a bad Score", {
    moves: ["a1"],
    score: { kind: "value", value: "1" },
  }, /Line score/],
];

for (const [what, line, message] of BAD_LINES) {
  Deno.test(`an Analysis with ${what} fails with 'unreadable-reply'`, async () => {
    await withRunner(async (runner) => {
      const analysis = {
        depth: 1,
        lines: [{ score: { kind: "value", value: 0 }, ...line }],
      };
      const result = await search(
        runner,
        testEngine("send", JSON.stringify(analysis)),
      );
      assertEquals(result.code, "unreadable-reply");
      assertMatch(result.message!, message);
    });
  });
}

Deno.test("readAnalysis checks Lines, Scores and the pending-chance shape", () => {
  const p = ttt.notation.decodePosition(START);
  const v = { kind: "value", value: 0 };
  const bad = (value: unknown, rules = ttt, position: unknown = p) =>
    assertThrows(
      () => readAnalysis(value, rules, position),
      SearchError,
      "malformed Analysis",
    );
  const line = (moves: unknown, score: unknown = v) => ({
    depth: 1,
    lines: [{ moves, score }],
  });
  for (
    const value of [
      7,
      [],
      { depth: -1, lines: [] },
      { depth: 1.5, lines: [] },
      { depth: 1, lines: {} },
      { depth: 1, lines: [null] },
      line([]),
      line([1]),
      line(["a1"], { kind: "win-in", plies: -1 }),
      line(["a1"], { kind: "draw" }),
      line(["a1"], null),
      { depth: 1, lines: [], score: v, seat: "x" }, // No Chance event pending.
    ]
  ) bad(value);
  // Moves after the Game ended.
  bad(line(["a1", "a2", "b1", "b2", "c1", "c2"]));
  assertEquals(
    readAnalysis(line(["a1"], { kind: "win-in", plies: 3, z: 1 }), ttt, p),
    {
      depth: 1,
      lines: [{ moves: ["a1"], score: { kind: "win-in", plies: 3 } }],
    },
  );
  // Backgammon at the start: the opening roll is pending.
  const roll = bg.initialPosition();
  assert(chancePending(bg, roll));
  const seat = bg.seats[0]!;
  const expected = { kind: "loss-in", plies: 2 };
  assertEquals(
    readAnalysis({ depth: 1, lines: [], score: expected, seat }, bg, roll),
    { depth: 1, lines: [], score: { kind: "loss-in", plies: 2 }, seat },
  );
  bad({ depth: 1, lines: [], score: v, seat: { evil: 1 } }, bg, roll);
  bad({ depth: 1, lines: [], score: v, seat: "nobody" }, bg, roll);
  bad({ depth: 1, lines: [], score: { kind: "value" }, seat }, bg, roll);
  bad(line(["24/23"]), bg, roll);
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
  const adapter = externalAdapter({ stderr: "null", games: GAMES });
  const runner = new EngineRunner({ adapter });
  const { it } = await firstAnalysis(runner, testEngine("stream"));
  await adapter.close();
  let rest: unknown;
  try {
    while (!(await it.next()).done); // Analyses already sent may still come.
  } catch (error) {
    rest = error;
  }
  assert(rest instanceof SearchError && rest.code === "worker-error");
  const later = await search(runner, testEngine("ok"));
  assertEquals(later.code, "worker-error");
  assertMatch(later.message!, /shut down/);
});

Deno.test("the external adapter refuses module Engines; the worker adapter external ones", async () => {
  const adapter = externalAdapter({ games: GAMES });
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
  assertThrows(
    () =>
      adapter.analyze(
        {
          engine: { ...testEngine("ok"), gameId: "go" },
          position: START,
          limits: {},
        },
        new AbortController().signal,
      ),
    SearchError,
    'no Game "go"',
  );
  const undecodable = await search(
    new EngineRunner({ adapter }),
    testEngine("ok"),
    {},
    undefined,
    "nope",
  );
  assertEquals(undecodable.code, "engine-error");
  assertMatch(undecodable.message!, /undecodable Position/);
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
    '{"type":"ready","protocol":1,"gameId":"g","name":" \\u0007\\n "}',
    '{"type":"ready","protocol":"1","gameId":"g","name":"N"}',
    '{"type":"analysis","id":1}',
    '{"type":"analysis","id":1.5,"analysis":{}}',
    '{"type":"done"}',
    '{"type":"error","id":1}',
    '{"type":"error","id":"1","message":"m"}',
    '{"type":"bestmove","id":1}',
  ];
  for (const line of invalid) assertEquals(parseEngineMessage(line), undefined);
  assertEquals(MAX_LINE_BYTES, 1 << 20);
  const long = parseEngineMessage(JSON.stringify({
    type: "ready",
    protocol: 1,
    gameId: "g",
    name: "Bad\u0000\nName " + "x".repeat(500),
  }));
  assert(long?.type === "ready");
  assertEquals(long.name.length, MAX_NAME_LENGTH);
  assert(long.name.startsWith("BadName x"), long.name);
});

Deno.test("the announced name is cleaned before clients see it", async () => {
  await withRunner(async (_, adapter) => {
    assertEquals(
      await adapter.connect(testEngine("name", "\u001b[31mRed\tEngine")),
      "[31mRedEngine",
    );
  });
});

Deno.test("shutdownHandler closes once, then exits", async () => {
  const calls: string[] = [];
  const handler = shutdownHandler(
    () => {
      calls.push("close");
      return Promise.resolve();
    },
    (code) => {
      calls.push(`exit ${code}`);
    },
  );
  await handler();
  await handler();
  assertEquals(calls, ["close", "exit 0"]);
});
