import { assert, assertEquals, assertThrows } from "@std/assert";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import { diceRace } from "@boardwright/testing";
import { buildApp } from "./app.ts";
import { EngineDriver } from "./engine-driver.ts";
import {
  type AnalysisRequest,
  DEFAULT_SEARCH_TIME_MS,
  EngineRunner,
  SearchError,
} from "./engine-runner.ts";
import { type EngineEntry, EngineRegistry } from "./engines.ts";
import { GameMaster, type MatchView } from "./game-master.ts";
import { type AnyGameRules, GameRegistry } from "./games.ts";
import { InMemoryMatchStore } from "./match-store.ts";
import type { Player } from "./players.ts";
import { testWorkerAdapter } from "./engine-runner.testing.ts";

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

const X_A1 = { kind: "move", move: "a1" } as const;

/** The Moves of the Move list, in Notation. */
const played = (match: MatchView) =>
  match.moves.map((e) => e.kind === "move" ? e.move : `[${e.chance}]`);

const human: Player = { kind: "human" };
const engine = (engineId: string, limits = {}): Player => ({
  kind: "engine",
  engineId,
  limits,
});

interface SetupOptions {
  readonly graceMs?: number;
  readonly maxConcurrent?: number;
  readonly attempts?: number;
  readonly maxMatches?: number;
  /**
   * Replaces the Engine: each search answers with this Move (as one
   * Analysis) instead of running a worker.
   */
  readonly search?: (request: AnalysisRequest) => Promise<string>;
}

function setup(options: SetupOptions = {}) {
  const master = new GameMaster({
    games: new GameRegistry([ticTacToe]),
    store: new InMemoryMatchStore(),
    engines: ENGINES,
  });
  const driver = newDriver(master, options);
  return { master, driver, app: buildApp({ master }) };
}

function newDriver(master: GameMaster, options: SetupOptions): EngineDriver {
  const { search, attempts, maxMatches, ...runnerOptions } = options;
  const runner = new EngineRunner({
    adapter: testWorkerAdapter(),
    ...runnerOptions,
    ...search && {
      adapter: {
        async *analyze(request: AnalysisRequest) {
          const move = await search(request);
          yield {
            depth: 1,
            lines: [{ moves: [move], score: { kind: "value", value: 0 } }],
          };
        },
      },
    },
  });
  return new EngineDriver(master, {
    runner,
    ...attempts !== undefined && { attempts },
    ...maxMatches !== undefined && { maxMatches },
  });
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
      view = await master.apply(view.id, { token: tokens.x! }, {
        kind: "move",
        move: view.legalMoves[0]!,
      });
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
    assertEquals(view.outcome, { kind: "rules", reason: "board-full" });
    assertEquals(view.moves.length, 9);
  } finally {
    await driver.close();
  }
});

async function failedMatch(
  entry: string,
  options: SetupOptions,
  limits = {},
): Promise<MatchView> {
  const { master, driver } = setup(options);
  try {
    const { match, tokens } = await master.createMatch("tic-tac-toe", {
      x: human,
      o: engine(entry, limits),
    });
    await master.apply(match.id, { token: tokens.x! }, X_A1);
    await driver.idle();
    return await master.getMatch(match.id);
  } finally {
    await driver.close();
  }
}

Deno.test("an Engine that throws forfeits after a retry", async () => {
  const view = await failedMatch("crash", {});
  assertEquals(view.outcome, {
    kind: "forfeit",
    winner: "x",
    seat: "o",
    reason: "engine-error",
  });
  assertEquals(view.toMove, null);
  assertEquals(view.legalMoves, []);
});

Deno.test("an Engine that hangs is cut off at the deadline and forfeits", async () => {
  const view = await failedMatch("hang", { graceMs: 150 }, { maxTimeMs: 0 });
  assertEquals(view.outcome, {
    kind: "forfeit",
    winner: "x",
    seat: "o",
    reason: "timeout",
  });
});

Deno.test("an Engine proposing an illegal Move forfeits", async () => {
  const view = await failedMatch("illegal", {});
  assertEquals(view.outcome, {
    kind: "forfeit",
    winner: "x",
    seat: "o",
    reason: "illegal-move",
  });
  assertEquals(played(view), ["a1"]);
});

Deno.test("an Engine proposing no Move forfeits", async () => {
  const view = await failedMatch("empty", { attempts: 1 });
  assertEquals(view.outcome, {
    kind: "forfeit",
    winner: "x",
    seat: "o",
    reason: "engine-error",
  });
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
  const driver = new EngineDriver(after, {
    runner: new EngineRunner({ adapter: testWorkerAdapter() }),
  });
  try {
    await after.apply(match.id, { token: tokens.x! }, X_A1);
    await driver.idle();
    const view = await after.getMatch(match.id);
    assertEquals(view.outcome, {
      kind: "forfeit",
      winner: "x",
      seat: "o",
      reason: "not-registered",
    });
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
    await master.apply(match.id, { token: tokens.x! }, X_A1);
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
    await master.apply(match.id, { token: tokens.x! }, X_A1);
    await driver.idle();
    const view = await master.getMatch(match.id);
    assertEquals(calls, 2);
    assertEquals(view.outcome, {
      kind: "forfeit",
      winner: "x",
      seat: "o",
      reason: "engine-error",
    });
  } finally {
    await driver.close();
  }
});

Deno.test("the Engine plays the best Line's first Move of the last Analysis that has one", async () => {
  const line = (move: string) => ({
    moves: [move],
    score: { kind: "value", value: 0 } as const,
  });
  const runner = new EngineRunner({
    adapter: {
      async *analyze() {
        await Promise.resolve();
        yield { depth: 1, lines: [line("a1"), line("b1")] };
        yield { depth: 2, lines: [line("c1"), line("a1")] };
        yield { depth: 3, lines: [] };
      },
    },
  });
  const master = new GameMaster({
    games: new GameRegistry([ticTacToe]),
    store: new InMemoryMatchStore(),
    engines: ENGINES,
  });
  const driver = new EngineDriver(master, { runner });
  try {
    const { match } = await master.createMatch("tic-tac-toe", {
      x: engine("minimax", { lines: 2 }),
      o: human,
    });
    await driver.idle();
    assertEquals(played(await master.getMatch(match.id)), ["c1"]);
  } finally {
    await driver.close();
  }
});

Deno.test("an unset maxTimeMs gets the default time limit, not none", async () => {
  const seen: unknown[] = [];
  const { master, driver } = setup({
    search: (request) => {
      seen.push(request.limits);
      return Promise.resolve("a1");
    },
  });
  try {
    await master.createMatch("tic-tac-toe", {
      x: engine("minimax", { maxDepth: 3 }),
      o: human,
    });
    await driver.idle();
    assertEquals(seen, [{ maxDepth: 3, maxTimeMs: DEFAULT_SEARCH_TIME_MS }]);
  } finally {
    await driver.close();
  }
});

Deno.test("closing while the referee judges a Move does not forfeit", async () => {
  const ref: { driver?: EngineDriver } = {};
  const { master, driver } = setup({
    search: () => {
      void ref.driver!.close();
      return Promise.resolve("z9"); // refused by the referee
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
  assertEquals(played(view), []);
});

Deno.test("a Resignation while the Engine searches ends the Match without a forfeit", async () => {
  const ref: { resign?: () => Promise<unknown> } = {};
  const { master, driver } = setup({
    search: async () => {
      await ref.resign!();
      return "b1";
    },
  });
  try {
    const { match, tokens } = await master.createMatch("tic-tac-toe", {
      x: human,
      o: engine("minimax"),
    });
    ref.resign = () =>
      master.apply(match.id, { token: tokens.x! }, { kind: "resignation" });
    await master.apply(match.id, { token: tokens.x! }, X_A1);
    await driver.idle();
    const view = await master.getMatch(match.id);
    assertEquals(view.outcome, { kind: "resignation", winner: "o", seat: "x" });
    assertEquals(played(view), ["a1"]);
  } finally {
    await driver.close();
  }
});

/** An in-memory store whose n-th `get` from now can be held back or failed. */
class GatedStore extends InMemoryMatchStore {
  #countdown = 0;
  #gate: Promise<void> | undefined;
  #afterRead = false;

  /** Gate the `n`-th `get` after this call until `release` or `fail`. */
  hold(
    n: number,
    { afterRead = false } = {},
  ): { release(): void; fail(): void } {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#afterRead = afterRead;
    this.#countdown = n;
    this.#gate = promise;
    promise.catch(() => {}); // Rejected only for the gated `get` to throw.
    return { release: resolve, fail: () => reject(new Error("store down")) };
  }

  /** Number of `get` calls so far. */
  gets = 0;

  override async get(id: string) {
    this.gets++;
    if (this.#gate && --this.#countdown === 0) {
      const gate = this.#gate;
      this.#gate = undefined;
      if (this.#afterRead) {
        // The read is done: the caller gets what the Match was before the gate.
        const record = await super.get(id);
        await gate;
        return record;
      }
      await gate;
    }
    return super.get(id);
  }
}

/**
 * A Match (human x, Engine o) created before the driver subscribes, so the
 * driver must load it on its first event.
 */
async function lateDriver(options: SetupOptions) {
  const store = new GatedStore();
  const master = new GameMaster({
    games: new GameRegistry([ticTacToe]),
    store,
    engines: ENGINES,
  });
  const { match, tokens } = await master.createMatch("tic-tac-toe", {
    x: human,
    o: engine("minimax"),
  });
  const driver = newDriver(master, options);
  const x = { token: tokens.x! };
  return { store, master, driver, id: match.id, x };
}

async function captureErrors<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logged: string[] }> {
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => logged.push(args.join(" "));
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = original;
  }
}

Deno.test("an event that is stale by the time the Match is loaded is skipped", async () => {
  let searches = 0;
  const { store, master, driver, id, x } = await lateDriver({
    search: () => {
      searches++;
      return Promise.resolve("b1");
    },
  });
  try {
    // get #1: the Move's own load; get #2: the driver's load, held back.
    const gate = store.hold(2);
    await master.apply(id, x, X_A1);
    // While the driver waits for the Match, x resigns (version 3).
    await master.apply(id, x, { kind: "resignation" });
    gate.release();
    await driver.idle();
    assertEquals(searches, 0);
    const view = await master.getMatch(id);
    assertEquals(view.outcome?.kind, "resignation");
    assertEquals(played(view), ["a1"]);
  } finally {
    await driver.close();
  }
});

Deno.test("a Match the driver cannot load is logged and left alone", async () => {
  let searches = 0;
  const { store, master, driver, id, x } = await lateDriver({
    search: () => {
      searches++;
      return Promise.resolve("b1");
    },
  });
  try {
    const { logged } = await captureErrors(async () => {
      store.hold(2).fail();
      await master.apply(id, x, X_A1);
      await driver.idle();
    });
    assertEquals(searches, 0);
    assert(logged.some((line) => line.includes("Could not load Match")));
    assertEquals((await master.getMatch(id)).outcome, null);
  } finally {
    await driver.close();
  }
});

Deno.test("a loaded Match is remembered: its later turns need no load", async () => {
  let searches = 0;
  const { store, master, driver, id, x } = await lateDriver({
    search: () => Promise.resolve(++searches === 1 ? "b1" : "b2"),
  });
  try {
    await master.apply(id, x, X_A1);
    await driver.idle();
    const before = store.gets;
    await master.apply(id, x, { kind: "move", move: "c1" });
    await driver.idle();
    // One load each for x's Move and the Engine's Move; none by the driver.
    assertEquals(store.gets - before, 2);
    assertEquals(played(await master.getMatch(id)), ["a1", "b1", "c1", "b2"]);
  } finally {
    await driver.close();
  }
});

Deno.test("a forfeit that comes too late is logged, not applied", async () => {
  const ref: { resign?: () => Promise<unknown> } = {};
  const { master, driver } = setup({
    attempts: 1,
    search: async () => {
      await ref.resign!();
      throw new Error("engine broke");
    },
  });
  try {
    const { match, tokens } = await master.createMatch("tic-tac-toe", {
      x: human,
      o: engine("minimax"),
    });
    ref.resign = () =>
      master.apply(match.id, { token: tokens.x! }, { kind: "resignation" });
    const { logged } = await captureErrors(async () => {
      await master.apply(match.id, { token: tokens.x! }, X_A1);
      await driver.idle();
    });
    assert(logged.some((line) => line.includes("Could not forfeit o")));
    const view = await master.getMatch(match.id);
    assertEquals(view.outcome, { kind: "resignation", winner: "o", seat: "x" });
  } finally {
    await driver.close();
  }
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
  assertEquals(played(view), []);
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

Deno.test("Engine Seats of a Game with chance play after each Chance event", async () => {
  const master = new GameMaster({
    games: new GameRegistry([diceRace as AnyGameRules]),
    store: new InMemoryMatchStore(),
    engines: new EngineRegistry([{
      id: "forward",
      name: "Forward",
      gameId: "dice-race",
      module: "unused:",
    }]),
  });
  const searched: string[] = [];
  const driver = newDriver(master, {
    search: (request) => {
      searched.push(request.position);
      return Promise.resolve("f");
    },
  });
  try {
    const { match } = await master.createMatch("dice-race", {
      a: engine("forward"),
      b: engine("forward"),
    });
    let view = await master.getMatch(match.id);
    while (view.outcome === null) {
      await driver.idle();
      view = await master.getMatch(match.id);
    }
    // Each Move follows a Chance event; Engines never search a pending one.
    const kinds = view.moves.map((e) => e.kind);
    kinds.forEach((kind, i) => assertEquals(kind, i % 2 ? "move" : "chance"));
    assert(searched.every((p) => !p.endsWith(":-")), searched.join(" "));
    assertEquals(searched.length, kinds.filter((k) => k === "move").length);
  } finally {
    await driver.close();
  }
});

Deno.test("the driver forgets the least recently active Match beyond maxMatches", async () => {
  let searches = 0;
  const { store, master, driver, id, x } = await lateDriver({
    maxMatches: 1,
    search: () => Promise.resolve(++searches === 1 ? "b1" : "b2"),
  });
  try {
    await master.apply(id, x, X_A1);
    await driver.idle();
    assertEquals(driver.remembered, 1);
    // A second Match pushes the first out of the cache.
    await master.createMatch("tic-tac-toe", { x: human, o: engine("minimax") });
    assertEquals(driver.remembered, 1);
    const before = store.gets;
    await master.apply(id, x, { kind: "move", move: "c1" });
    await driver.idle();
    // Move load, the driver's reload of the forgotten Match, the Engine's Move load.
    assertEquals(store.gets - before, 3);
    assertEquals(driver.remembered, 1);
    assertEquals((await master.getMatch(id)).moves.length, 4);
  } finally {
    await driver.close();
  }
});

Deno.test("maxMatches must be a positive integer", () => {
  const { master } = setup();
  const runner = new EngineRunner({ adapter: testWorkerAdapter() });
  for (const maxMatches of [0, -1, 1.5, NaN]) {
    assertThrows(
      () => new EngineDriver(master, { runner, maxMatches }),
      RangeError,
    );
  }
});

Deno.test("a finished Match leaves the cache; Matches without Engines count against the bound", async () => {
  const { master, driver } = setup({ maxMatches: 2 });
  try {
    await master.createMatch("tic-tac-toe", { x: human, o: human });
    await master.createMatch("tic-tac-toe", { x: human, o: human });
    await master.createMatch("tic-tac-toe", { x: human, o: human });
    assertEquals(driver.remembered, 2);
    const { match, tokens } = await master.createMatch("tic-tac-toe", {
      x: human,
      o: human,
    });
    await master.apply(match.id, { token: tokens.x! }, {
      kind: "resignation",
    });
    assertEquals(driver.remembered, 1);
  } finally {
    await driver.close();
  }
});

Deno.test("a cache-miss load that a concurrent Resignation outruns is not cached", async () => {
  const { store, master, driver, id, x } = await lateDriver({
    search: () => Promise.resolve("b1"),
  });
  try {
    // The driver reads the running Match (version 2), then waits at the gate.
    const gate = store.hold(2, { afterRead: true });
    await master.apply(id, x, X_A1);
    await master.apply(id, x, { kind: "resignation" });
    gate.release();
    await driver.idle();
    assertEquals(driver.remembered, 0);
  } finally {
    await driver.close();
  }
});
