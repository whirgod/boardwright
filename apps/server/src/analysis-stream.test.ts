import { assert, assertEquals } from "@std/assert";
import type { Analysis } from "@boardwright/core";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import { buildApp } from "./app.ts";
import {
  AnalysisSession,
  type AnalysisStreamMessage,
  MAX_MESSAGE_CHARS,
} from "./analysis-stream.ts";
import {
  type AnalysisRequest,
  type EngineAdapter,
  EngineRunner,
  type EngineRunnerOptions,
} from "./engine-runner.ts";
import { inProcessAdapter } from "./engine-runner.testing.ts";
import { type EngineEntry, EngineRegistry } from "./engines.ts";
import { GameMaster } from "./game-master.ts";
import { GameRegistry } from "./games.ts";
import { InMemoryMatchStore } from "./match-store.ts";
import { serve, TestClient, until } from "./stream.testing.ts";

const START = ".........:x";

const entry = (name: string): EngineEntry => ({
  id: name,
  name,
  gameId: "tic-tac-toe",
  module: import.meta.resolve(`./test-engines/${name}.ts`),
});
const ENGINES = new EngineRegistry(
  ["stream", "expected", "crash"].map(entry),
);
const GAMES = new GameRegistry([ticTacToe]);

const START_MSG = {
  type: "start",
  gameId: "tic-tac-toe",
  engineId: "stream",
  position: START,
};

/** An Engine that yields one Analysis, then runs until aborted; records both. */
function endless() {
  const state = { started: 0, aborted: 0, limits: [] as unknown[] };
  const adapter: EngineAdapter = {
    async *analyze(request: AnalysisRequest, signal: AbortSignal) {
      state.started++;
      state.limits.push(request.limits);
      signal.addEventListener("abort", () => state.aborted++);
      yield {
        depth: 1,
        lines: [{ moves: ["a1"], score: { kind: "value", value: 0 } }],
      } as Analysis<string>;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve())
      );
    },
  };
  return { state, adapter };
}

function session(runnerOptions: EngineRunnerOptions = {}) {
  const sent: AnalysisStreamMessage[] = [];
  const runner = new EngineRunner({
    adapter: inProcessAdapter(),
    ...runnerOptions,
  });
  const s = new AnalysisSession({
    games: GAMES,
    engines: ENGINES,
    runner,
    send: (m) => sent.push(m),
  });
  return { s, sent, runner };
}

const types = (sent: AnalysisStreamMessage[]) => sent.map((m) => m.type);

Deno.test("analysis streams successive Analyses with increasing depth, then done", async () => {
  const { s, sent } = session();
  s.handle(
    JSON.stringify({
      ...START_MSG,
      id: "a",
      limits: { maxDepth: 3, lines: 2 },
    }),
  );
  await until(() => sent.at(-1)?.type === "done");
  assertEquals(types(sent), ["analysis", "analysis", "analysis", "done"]);
  const depths = sent.flatMap((m) =>
    m.type === "analysis" ? [m.analysis.depth] : []
  );
  assertEquals(depths, [1, 2, 3]);
  assert(sent.every((m) => m.type === "done" || m.id === "a"));
  const first = sent[0];
  assert(first?.type === "analysis");
  assertEquals(first.analysis.lines[0]?.moves, ["a1"]); // Moves in Notation
});

Deno.test("analysis of a Position with a pending Chance event has no Lines but an expected Score", async () => {
  const { s, sent } = session();
  s.handle(JSON.stringify({ ...START_MSG, engineId: "expected" }));
  await until(() => sent.at(-1)?.type === "done");
  assertEquals(sent[0], {
    type: "analysis",
    analysis: { depth: 2, lines: [], score: { kind: "value", value: 0.25 } },
  });
});

Deno.test("stop cancels the search, tells the Engine to stop and frees the slot", async () => {
  const { state, adapter } = endless();
  const { s, sent } = session({
    adapter,
    maxConcurrent: 2,
    reservedForMatches: 1,
    maxQueued: 0,
  });
  s.handle(JSON.stringify({ ...START_MSG, id: "one" }));
  await until(() => sent.length === 1);
  s.handle(JSON.stringify({ type: "stop" }));
  assertEquals(sent.at(-1), { type: "stopped", id: "one" });
  await until(() => state.aborted === 1);

  // The slot is free again: a new search starts instead of failing `busy`.
  s.handle(JSON.stringify({ ...START_MSG, id: "two" }));
  await until(() => state.started === 2);
  assertEquals(sent.filter((m) => m.type === "error").length, 0);
  s.close();
  await until(() => state.aborted === 2);
});

Deno.test("stop with nothing running is harmless", () => {
  const { s, sent } = session();
  s.handle(JSON.stringify({ type: "stop" }));
  assertEquals(sent, [{ type: "stopped" }]);
});

Deno.test("a new start replaces the running search without messages from the old one", async () => {
  const { state, adapter } = endless();
  const { s, sent } = session({ adapter });
  s.handle(JSON.stringify({ ...START_MSG, id: "old" }));
  await until(() => sent.length === 1);
  s.handle(JSON.stringify({ ...START_MSG, id: "new" }));
  await until(() => state.started === 2);
  await until(() => sent.length === 2);
  assertEquals(state.aborted, 1);
  assertEquals(sent.map((m) => m.id), ["old", "new"]);
  assertEquals(types(sent), ["analysis", "analysis"]);
  s.close();
});

Deno.test("closing the session cancels the search and ignores later messages", async () => {
  const { state, adapter } = endless();
  const { s, sent } = session({ adapter });
  s.handle(JSON.stringify(START_MSG));
  await until(() => sent.length === 1);
  s.close();
  await until(() => state.aborted === 1);
  s.handle(JSON.stringify(START_MSG));
  assertEquals(state.started, 1);
  assertEquals(sent.length, 1);
});

Deno.test("runner `busy` becomes a clear error and the socket stays usable", async () => {
  const { state, adapter } = endless();
  const options = {
    adapter,
    maxConcurrent: 2,
    reservedForMatches: 1,
    maxQueued: 0,
  };
  const runner = new EngineRunner(options);
  const mk = () => {
    const sent: AnalysisStreamMessage[] = [];
    const s = new AnalysisSession({
      games: GAMES,
      engines: ENGINES,
      runner,
      send: (m) => sent.push(m),
    });
    return { s, sent };
  };
  const a = mk();
  const b = mk();
  a.s.handle(JSON.stringify(START_MSG));
  await until(() => a.sent.length === 1);
  b.s.handle(JSON.stringify({ ...START_MSG, id: "late" }));
  await until(() => b.sent.length === 1);
  assertEquals(b.sent[0], {
    type: "error",
    id: "late",
    error: {
      code: "busy",
      message: "Too many Analysis requests are waiting; try again later",
    },
  });
  assertEquals(state.started, 1);

  // Once the first client stops, the second can try again.
  a.s.handle(JSON.stringify({ type: "stop" }));
  await until(() => state.aborted === 1);
  b.s.handle(JSON.stringify(START_MSG));
  await until(() => b.sent.length === 2 && b.sent[1]!.type === "analysis");
  a.s.close();
  b.s.close();
});

Deno.test("an Engine that fails is reported with its public code", async () => {
  const { s, sent } = session();
  const logged: unknown[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  s.handle(JSON.stringify({ ...START_MSG, engineId: "crash", id: "x" }));
  await until(() => sent.length === 1);
  console.error = log;
  assertEquals(logged.length, 1); // the Engine's own text goes to the log
  const message = sent[0]!;
  assert(message.type === "error");
  assertEquals(message.id, "x");
  assertEquals(message.error.code, "engine-error");
  assert(!message.error.message.includes("boom")); // details are only logged
  // A new request still works afterwards.
  s.handle(JSON.stringify({ ...START_MSG, limits: { maxDepth: 1 } }));
  await until(() => sent.at(-1)?.type === "done");
});

Deno.test("an unreadable or unexpected failure is reported as internal", async () => {
  // The runner only throws SearchErrors; stub it to throw something else.
  const runner = new EngineRunner({ adapter: inProcessAdapter() });
  runner.analyze = () => {
    // deno-lint-ignore require-yield
    return (async function* () {
      await Promise.resolve();
      throw new Error("secret detail");
    })();
  };
  const sent: AnalysisStreamMessage[] = [];
  const s = new AnalysisSession({
    games: GAMES,
    engines: ENGINES,
    runner,
    send: (m) => sent.push(m),
  });
  const log = console.error;
  console.error = () => {};
  try {
    s.handle(JSON.stringify(START_MSG));
    await until(() => sent.length === 1);
  } finally {
    console.error = log;
  }
  assertEquals(sent[0], {
    type: "error",
    error: { code: "internal", message: "Internal server error" },
  });
});

Deno.test("bad requests get an error and start nothing", () => {
  const { state, adapter } = endless();
  const { s, sent } = session({ adapter });
  const bad: [unknown, string][] = [
    ["{not json", "invalid-request"],
    ["[]", "invalid-request"],
    ["null", "invalid-request"],
    [JSON.stringify({ type: "go" }), "invalid-request"],
    [JSON.stringify({}), "invalid-request"],
    [JSON.stringify({ ...START_MSG, extra: 1 }), "invalid-request"],
    [JSON.stringify({ ...START_MSG, gameId: 3 }), "invalid-request"],
    [JSON.stringify({ ...START_MSG, engineId: "" }), "invalid-request"],
    [JSON.stringify({ ...START_MSG, position: null }), "invalid-request"],
    [JSON.stringify({ ...START_MSG, id: 5 }), "invalid-request"],
    [JSON.stringify({ ...START_MSG, limits: { lines: 0 } }), "invalid-request"],
    [
      JSON.stringify({ ...START_MSG, limits: { maxTimeMs: 1e9 } }),
      "invalid-request",
    ],
    [JSON.stringify({ ...START_MSG, limits: [] }), "invalid-request"],
    [JSON.stringify({ ...START_MSG, gameId: "go" }), "unknown-game"],
    [JSON.stringify({ ...START_MSG, engineId: "nope" }), "unknown-engine"],
    [JSON.stringify({ ...START_MSG, position: "garbage" }), "invalid-position"],
    [new Uint8Array([1, 2]), "invalid-request"],
    ["x".repeat(MAX_MESSAGE_CHARS + 1), "invalid-request"],
  ];
  for (const [data] of bad) s.handle(data);
  assertEquals(
    sent.map((m) => m.type === "error" ? m.error.code : m.type),
    bad.map(([, code]) => code),
  );
  assertEquals(state.started, 0);
  // A request that names an id gets it echoed even when invalid.
  s.handle(JSON.stringify({ ...START_MSG, id: "q", engineId: "nope" }));
  assertEquals(sent.at(-1)?.id, "q");
});

Deno.test("over a WebSocket: stream, stop and a disconnect that cancels the search", async () => {
  const { state, adapter } = endless();
  const master = new GameMaster({
    games: GAMES,
    store: new InMemoryMatchStore(),
    engines: ENGINES,
  });
  const runner = new EngineRunner({ adapter: inProcessAdapter() });
  const endlessRunner = new EngineRunner({ adapter });
  const real = serve(buildApp({ master, runner }).fetch);
  const hanging = serve(buildApp({ master, runner: endlessRunner }).fetch);
  try {
    const client = await TestClient.connect(
      `${real.wsUrl}/api/analysis/stream`,
    );
    client.send({ ...START_MSG, id: "w", limits: { maxDepth: 2 } });
    const got = [await client.next(), await client.next(), await client.next()];
    assertEquals(got.map((m) => m.type), ["analysis", "analysis", "done"]);
    client.send("nonsense");
    assertEquals(
      ((await client.next()).error as { code: string }).code,
      "invalid-request",
    );
    await client.close();

    const stopper = await TestClient.connect(
      `${hanging.wsUrl}/api/analysis/stream`,
    );
    stopper.send(START_MSG);
    assertEquals((await stopper.next()).type, "analysis");
    stopper.send({ type: "stop" });
    assertEquals((await stopper.next()).type, "stopped");
    await until(() => state.aborted === 1);
    stopper.send(START_MSG);
    assertEquals((await stopper.next()).type, "analysis");
    await stopper.close(); // disconnect while searching
    await until(() => state.aborted === 2);
  } finally {
    await real.shutdown();
    await hanging.shutdown();
  }
});

Deno.test("without a runner there is no Analysis stream", async () => {
  const server = serve(buildApp({ games: [ticTacToe] }).fetch);
  try {
    const res = await fetch(`${server.httpUrl}/api/analysis/stream`);
    assertEquals(res.status, 404);
    await res.body?.cancel();
  } finally {
    await server.shutdown();
  }
});
