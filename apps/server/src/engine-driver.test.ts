import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import { buildApp } from "./app.ts";
import {
  DEFAULT_SEARCH_TIME_MS,
  EngineDriver,
  type EngineDriverOptions,
} from "./engine-driver.ts";
import { SearchError, searchInWorker } from "./engine-search.ts";
import { type EngineEntry, EngineRegistry } from "./engines.ts";
import { GameMaster, type MatchView } from "./game-master.ts";
import { GameRegistry } from "./games.ts";
import { InMemoryMatchStore } from "./match-store.ts";
import type { PlayerSpec } from "./players.ts";

const minimaxModule = import.meta.resolve(
  "@boardwright/engine-tic-tac-toe-minimax",
);
const testEngine = (name: string): EngineEntry => ({
  id: name,
  name,
  gameId: "tic-tac-toe",
  module: import.meta.resolve(`./test-engines/${name}.ts`),
});

const ENGINES = new EngineRegistry([
  {
    id: "minimax",
    name: "Minimax",
    gameId: "tic-tac-toe",
    module: minimaxModule,
  },
  ...["crash", "hang", "illegal", "slow", "empty"].map(testEngine),
]);

const human: PlayerSpec = { kind: "human" };
const engine = (engineId: string, limits = {}): PlayerSpec => ({
  kind: "engine",
  engineId,
  limits,
});

function setup(options: EngineDriverOptions = {}) {
  const master = new GameMaster({
    games: new GameRegistry([ticTacToe]),
    store: new InMemoryMatchStore(),
    engines: ENGINES,
  });
  const driver = new EngineDriver(master, options);
  return { master, driver, app: buildApp({ master }) };
}

Deno.test("human vs Engine: a full Match reaches an Outcome", async () => {
  const { master, driver } = setup();
  try {
    const { match, tokens } = await master.createMatch("tic-tac-toe", {
      x: human,
      o: engine("minimax"),
    });
    let view: MatchView = match;
    while (view.outcome === null) {
      assertEquals(view.toMove, "x");
      view = await master.playMove(view.id, view.legalMoves[0]!, tokens.x!);
      await driver.idle();
      view = await master.getMatch(view.id);
    }
    // The first-listed Move each time is no match for a perfect Engine.
    assert(view.outcome.winner !== "x", JSON.stringify(view.outcome));
  } finally {
    await driver.close();
  }
});

Deno.test("Engine moves first when it holds the first Seat", async () => {
  const { master, driver } = setup();
  try {
    const { match } = await master.createMatch("tic-tac-toe", {
      x: engine("minimax"),
      o: human,
    });
    await driver.idle();
    const view = await master.getMatch(match.id);
    assertEquals(view.moves.length, 1);
    assertEquals(view.toMove, "o");
  } finally {
    await driver.close();
  }
});

Deno.test("Engine vs Engine reaches an Outcome (a draw)", async () => {
  const { master, driver } = setup();
  try {
    const { match } = await master.createMatch("tic-tac-toe", {
      x: engine("minimax"),
      o: engine("minimax", { maxDepth: 9 }),
    });
    await driver.idle();
    const view = await master.getMatch(match.id);
    assertEquals(view.outcome, { reason: "board-full" });
    assertEquals(view.moves.length, 9);
  } finally {
    await driver.close();
  }
});

async function failedMatch(
  entry: string,
  options: EngineDriverOptions,
  limits = {},
): Promise<MatchView> {
  const { master, driver } = setup(options);
  try {
    const { match, tokens } = await master.createMatch("tic-tac-toe", {
      x: human,
      o: engine(entry, limits),
    });
    await master.playMove(match.id, "a1", tokens.x!);
    await driver.idle();
    return await master.getMatch(match.id);
  } finally {
    await driver.close();
  }
}

Deno.test("an Engine that throws forfeits after a retry", async () => {
  const view = await failedMatch("crash", {});
  assertEquals(view.outcome?.winner, "x");
  assertMatch(
    view.outcome!.reason,
    /^engine-failure: crash for o: engine-error$/,
  );
  assertEquals(view.toMove, null);
  assertEquals(view.legalMoves, []);
});

Deno.test("an Engine that hangs is cut off at the deadline and forfeits", async () => {
  const view = await failedMatch("hang", { graceMs: 150 }, { maxTimeMs: 0 });
  assertEquals(view.outcome?.winner, "x");
  assertMatch(view.outcome!.reason, /^engine-failure: hang for o: timeout$/);
});

Deno.test("an Engine proposing an illegal Move forfeits", async () => {
  const view = await failedMatch("illegal", {});
  assertEquals(view.outcome?.winner, "x");
  assertMatch(
    view.outcome!.reason,
    /^engine-failure: illegal for o: illegal-move$/,
  );
  assertEquals(view.moves, ["a1"]);
});

Deno.test("an Engine proposing no Move forfeits", async () => {
  const view = await failedMatch("empty", { attempts: 1 });
  assertMatch(
    view.outcome!.reason,
    /^engine-failure: empty for o: engine-error$/,
  );
});

Deno.test("an unregistered Engine forfeits (registry changed under a stored Match)", async () => {
  const store = new InMemoryMatchStore();
  const games = new GameRegistry([ticTacToe]);
  const before = new GameMaster({ games, store, engines: ENGINES });
  const { match, tokens } = await before.createMatch("tic-tac-toe", {
    x: human,
    o: engine("minimax"),
  });
  // The same store, served by a master that no longer offers the Engine.
  const after = new GameMaster({ games, store });
  const driver = new EngineDriver(after);
  try {
    await after.playMove(match.id, "a1", tokens.x!);
    await driver.idle();
    const view = await after.getMatch(match.id);
    assertEquals(view.outcome?.winner, "x");
    assertMatch(
      view.outcome!.reason,
      /^engine-failure: minimax for o: not-registered$/,
    );
  } finally {
    await driver.close();
  }
});

Deno.test("a failed search is retried with a fresh attempt", async () => {
  let calls = 0;
  const { master, driver } = setup({
    search: (request) => {
      calls++;
      return calls === 1
        ? Promise.reject(new SearchError("worker-error", "flaky"))
        : Promise.resolve(
          ticTacToe.legalMoves(
            ticTacToe.notation.decodePosition(request.position),
          )[0]!,
        );
    },
  });
  try {
    const { match, tokens } = await master.createMatch("tic-tac-toe", {
      x: human,
      o: engine("minimax"),
    });
    await master.playMove(match.id, "a1", tokens.x!);
    await driver.idle();
    const view = await master.getMatch(match.id);
    assertEquals(calls, 2);
    assertEquals(view.outcome, null);
    assertEquals(view.moves.length, 2);
  } finally {
    await driver.close();
  }
});

Deno.test("retries are exhausted by an always failing search, then the Seat forfeits", async () => {
  let calls = 0;
  const { master, driver } = setup({
    search: () => {
      calls++;
      return Promise.reject(new Error("/secret/path/boom"));
    },
  });
  try {
    const { match, tokens } = await master.createMatch("tic-tac-toe", {
      x: human,
      o: engine("minimax"),
    });
    await master.playMove(match.id, "a1", tokens.x!);
    await driver.idle();
    const view = await master.getMatch(match.id);
    assertEquals(calls, 2);
    assertEquals(view.outcome, {
      winner: "x",
      reason: "engine-failure: minimax for o: engine-error",
    });
  } finally {
    await driver.close();
  }
});

Deno.test("an unset maxTimeMs gets the default time limit, not none", async () => {
  const seen: { limits: unknown; timeoutMs: number }[] = [];
  const { master, driver } = setup({
    graceMs: 100,
    search: (request, options) => {
      seen.push({ limits: request.limits, timeoutMs: options.timeoutMs });
      return Promise.resolve("a1");
    },
  });
  try {
    await master.createMatch("tic-tac-toe", {
      x: engine("minimax", { maxDepth: 3 }),
      o: human,
    });
    await driver.idle();
    assertEquals(seen, [{
      limits: { maxDepth: 3, maxTimeMs: DEFAULT_SEARCH_TIME_MS },
      timeoutMs: DEFAULT_SEARCH_TIME_MS + 100,
    }]);
  } finally {
    await driver.close();
  }
});

Deno.test("closing while the referee judges a Move does not forfeit", async () => {
  const ref: { driver?: EngineDriver } = {};
  const { master, driver } = setup({
    search: () => {
      void ref.driver!.close();
      return Promise.resolve("z9"); // refused by playAs
    },
  });
  ref.driver = driver;
  const { match } = await master.createMatch("tic-tac-toe", {
    x: engine("minimax"),
    o: human,
  });
  await driver.idle();
  const view = await master.getMatch(match.id);
  assertEquals(view.outcome, null);
  assertEquals(view.moves, []);
});

Deno.test("searches beyond maxConcurrent queue instead of running", async () => {
  let running = 0;
  let peak = 0;
  const { master, driver } = setup({
    maxConcurrent: 2,
    search: async (request) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 30));
      running--;
      return ticTacToe.notation.encodeMove(
        ticTacToe.legalMoves(
          ticTacToe.notation.decodePosition(request.position),
        )[0]!,
      );
    },
  });
  try {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { match } = await master.createMatch("tic-tac-toe", {
        x: engine("minimax"),
        o: engine("minimax"),
      });
      ids.push(match.id);
    }
    await driver.idle();
    assertEquals(peak, 2);
    for (const id of ids) {
      assert((await master.getMatch(id)).outcome !== null);
    }
  } finally {
    await driver.close();
  }
});

Deno.test("requests stay responsive while an Engine searches", async () => {
  const { master, driver, app } = setup();
  try {
    const { match } = await master.createMatch("tic-tac-toe", {
      x: engine("slow"),
      o: human,
    });
    let done = false;
    const searching = driver.idle().then(() => done = true);
    const started = performance.now();
    // Give the worker time to start and begin its 600 ms busy loop.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const health = await app.request("/api/health");
    const answeredAfter = performance.now() - started;
    assertEquals(health.status, 200);
    assertEquals(done, false, "the Engine was still searching");
    assert(answeredAfter < 500, `health took ${answeredAfter} ms`);
    await searching;
    assertEquals((await master.getMatch(match.id)).moves.length, 1);
  } finally {
    await driver.close();
  }
});

Deno.test("close() terminates searches in flight without a forfeit", async () => {
  const { master, driver } = setup();
  const { match } = await master.createMatch("tic-tac-toe", {
    x: engine("hang"),
    o: human,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await driver.close();
  const view = await master.getMatch(match.id);
  assertEquals(view.outcome, null);
  assertEquals(view.moves, []);
});

Deno.test("Matches without Engine Seats are left alone", async () => {
  const { master, driver } = setup();
  try {
    await master.createMatch("tic-tac-toe", { x: human, o: human });
    await driver.idle();
  } finally {
    await driver.close();
  }
});

Deno.test("searchInWorker rejects at once for an already aborted signal", async () => {
  const error = await assertRejects(
    () =>
      searchInWorker(
        { module: minimaxModule, position: "........._:x", limits: {} },
        { timeoutMs: 1000, signal: AbortSignal.abort() },
      ),
    SearchError,
  );
  assertMatch(error.message, /aborted/);
});

Deno.test("searchInWorker answers with the best Move in Notation", async () => {
  const move = await searchInWorker(
    { module: minimaxModule, position: "xx.oo....:x", limits: {} },
    { timeoutMs: 5000 },
  );
  assertEquals(move, "c1");
});
