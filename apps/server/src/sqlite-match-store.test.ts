import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import { diceRace } from "@boardwright/testing";
import { EngineDriver } from "./engine-driver.ts";
import { type AnalysisRequest, EngineRunner } from "./engine-runner.ts";
import { EngineRegistry } from "./engines.ts";
import { buildApp } from "./app.ts";
import { GameMaster, type MatchView } from "./game-master.ts";
import { type AnyGameRules, GameRegistry } from "./games.ts";
import {
  assertMatchStoreContract,
  sampleRecord,
} from "./match-store.contract.ts";
import {
  DATABASE_FILE,
  openMatchStore,
  SqliteMatchStore,
} from "./sqlite-match-store.ts";

/** Scratch directory inside the repo, so tests need write access to it only. */
const SCRATCH = `${import.meta.dirname}/../../../.test-tmp`;

async function withTempDir(
  work: (dir: string) => Promise<void>,
): Promise<void> {
  await Deno.mkdir(SCRATCH, { recursive: true });
  const dir = await Deno.makeTempDir({ dir: SCRATCH });
  try {
    await work(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("SqliteMatchStore (in memory) satisfies the MatchStore contract", (t) => {
  const open: SqliteMatchStore[] = [];
  return assertMatchStoreContract(t, () => {
    const store = new SqliteMatchStore(":memory:");
    open.push(store);
    return store;
  }).finally(() => open.forEach((s) => s.close()));
});

Deno.test("SqliteMatchStore (file) satisfies the MatchStore contract", (t) =>
  withTempDir(async (dir) => {
    let n = 0;
    const open: SqliteMatchStore[] = [];
    try {
      await assertMatchStoreContract(t, () => {
        const store = new SqliteMatchStore(`${dir}/matches-${++n}.db`);
        open.push(store);
        return store;
      });
    } finally {
      open.forEach((s) => s.close());
    }
  }));

Deno.test("records survive closing and reopening the database", () =>
  withTempDir(async (dir) => {
    const path = `${dir}/matches.db`;
    const record = sampleRecord({
      moves: [{ kind: "move", move: "a1" }, { kind: "chance", chance: "3" }],
      seed: "s3cret",
      outcome: { kind: "forfeit", winner: "x", seat: "o", reason: "timeout" },
    });
    const first = new SqliteMatchStore(path);
    try {
      await first.create(record);
    } finally {
      first.close();
    }
    const second = new SqliteMatchStore(path);
    try {
      assertEquals(await second.get("m1"), record);
      assertEquals((await second.list({ limit: 5 })).matches, [record]);
    } finally {
      second.close();
    }
  }));

Deno.test("a restarted Game master continues a Match: Position, seed, tokens", () =>
  withTempDir(async (dir) => {
    const path = `${dir}/matches.db`;
    const humans = { a: { kind: "human" }, b: { kind: "human" } } as const;
    const boot = () => {
      const store = new SqliteMatchStore(path);
      const master = new GameMaster({
        games: new GameRegistry([diceRace as AnyGameRules]),
        store,
        newSeed: () => "fixed-seed",
      });
      return { store, master };
    };

    const before = boot();
    const { match: created, tokens } = await before.master.createMatch(
      "dice-race",
      humans,
    );
    const rolled = await before.master.getMatch(created.id);
    assertEquals(rolled.moves.length > 0, true); // the opening roll
    const mover = rolled.toMove!;
    const played = await before.master.apply(
      created.id,
      { token: tokens[mover]! },
      { kind: "move", move: rolled.legalMoves[0]! },
    );
    before.store.close();

    // "Restart": a new store and a new Game master over the same file.
    const after = boot();
    const restored = await after.master.getMatch(created.id);
    assertEquals(restored, played);
    assertEquals("seed" in restored, false); // still secret: no Outcome yet

    // The seat tokens still work, and play goes on from the stored Position.
    const next = restored.toMove!;
    const continued = await after.master.apply(
      created.id,
      { token: tokens[next]! },
      { kind: "resignation" },
    );
    assertEquals(continued.outcome?.kind, "resignation");
    assertEquals(continued.seed, "fixed-seed"); // revealed with the Outcome
    after.store.close();

    const last = boot();
    const finished: MatchView = await last.master.getMatch(created.id);
    assertEquals(finished, continued);
    last.store.close();
  }));

Deno.test("listings from the API come from the persistent store", () =>
  withTempDir(async (dir) => {
    const path = `${dir}/matches.db`;
    const games = [diceRace as AnyGameRules];
    const humans = { a: { kind: "human" }, b: { kind: "human" } };
    const first = new SqliteMatchStore(path);
    const app1 = buildApp({ games, store: first });
    const res = await app1.request("/api/matches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: "dice-race", seats: humans }),
    });
    const { match } = await res.json();
    first.close();

    const second = new SqliteMatchStore(path);
    const app2 = buildApp({ games, store: second });
    const list = await (await app2.request("/api/matches")).json();
    assertEquals(list.matches.map((m: { id: string }) => m.id), [match.id]);
    assert(!JSON.stringify(list).includes("tokenHash"));
    assert(!JSON.stringify(list).includes("seed"));
    second.close();
  }));

Deno.test("opening refuses a database of a newer schema", () =>
  withTempDir((dir) => {
    const path = `${dir}/matches.db`;
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    assertThrows(() => new SqliteMatchStore(path), Error, "schema version 99");
    return Promise.resolve();
  }));

Deno.test("a locked database rejects within the busy timeout", () =>
  withTempDir(async (dir) => {
    const path = `${dir}/matches.db`;
    const store = new SqliteMatchStore(path, { busyTimeoutMs: 50 });
    const other = new DatabaseSync(path);
    try {
      other.exec("BEGIN EXCLUSIVE");
      const started = performance.now();
      await assertRejects(() => store.create(sampleRecord()));
      assert(performance.now() - started < 1000);
      other.exec("ROLLBACK");
    } finally {
      other.close();
      store.close();
    }
  }));

Deno.test("openMatchStore creates the data directory and its database", () =>
  withTempDir(async (dir) => {
    const store = openMatchStore(`${dir}/nested/data`);
    await store.create(sampleRecord());
    store.close();
    assertEquals(
      (await Deno.stat(`${dir}/nested/data/${DATABASE_FILE}`)).isFile,
      true,
    );
  }));

Deno.test("after a restart the EngineDriver plays Engine turns no event announces", () =>
  withTempDir(async (dir) => {
    const path = `${dir}/matches.db`;
    const engines = new EngineRegistry([{
      id: "fixed",
      name: "Fixed",
      gameId: "tic-tac-toe",
      module: "unused:fixed",
    }]);
    const boot = () => {
      const store = new SqliteMatchStore(path);
      const master = new GameMaster({
        games: new GameRegistry([ticTacToe]),
        store,
        engines,
      });
      return { store, master };
    };
    const engine = { kind: "engine", engineId: "fixed", limits: {} } as const;
    const human = { kind: "human" } as const;

    // First run, no driver: x is an Engine and is to move, but nobody plays.
    const before = boot();
    let waiting: MatchView;
    let humanTurn: MatchView;
    try {
      waiting = (await before.master.createMatch("tic-tac-toe", {
        x: engine,
        o: human,
      })).match;
      humanTurn = (await before.master.createMatch("tic-tac-toe", {
        x: human,
        o: engine,
      })).match;
    } finally {
      before.store.close();
    }

    // Restart: only the Match whose Engine Seat is to move gets a Move.
    const after = boot();
    const runner = new EngineRunner({
      adapter: {
        async *analyze(_request: AnalysisRequest) {
          await Promise.resolve();
          yield {
            depth: 1,
            lines: [{ moves: ["a1"], score: { kind: "value", value: 0 } }],
          };
        },
      },
    });
    const driver = new EngineDriver(after.master, { runner });
    try {
      assertEquals(await driver.resumeAll(), 1);
      await driver.idle();
      const moved = await after.master.getMatch(waiting.id);
      assertEquals(moved.moves, [{ kind: "move", move: "a1" }]);
      assertEquals(moved.toMove, "o");
      assertEquals((await after.master.getMatch(humanTurn.id)).moves, []);
    } finally {
      await driver.close();
      after.store.close();
    }
  }));
