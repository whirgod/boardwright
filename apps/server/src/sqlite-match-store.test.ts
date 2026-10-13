import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { diceRace } from "@boardwright/testing";
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
const SCRATCH = new URL("../../../.test-tmp", import.meta.url).pathname;

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
    await assertMatchStoreContract(t, () => {
      const store = new SqliteMatchStore(`${dir}/matches-${++n}.db`);
      open.push(store);
      return store;
    });
    open.forEach((s) => s.close());
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
    await first.create(record);
    first.close();
    const second = new SqliteMatchStore(path);
    assertEquals(await second.get("m1"), record);
    assertEquals((await second.list({ limit: 5 })).matches, [record]);
    second.close();
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
    other.exec("BEGIN EXCLUSIVE");
    const started = performance.now();
    await assertRejects(() => store.create(sampleRecord()));
    assert(performance.now() - started < 5000);
    other.exec("ROLLBACK");
    other.close();
    store.close();
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
