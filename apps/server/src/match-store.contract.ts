import { assertEquals, assertRejects } from "@std/assert";
import type {
  MatchQuery,
  MatchRecord,
  MatchStore,
  MoveListEntry,
} from "./match-store.ts";

const mv = (move: string): MoveListEntry => ({ kind: "move", move });

/** A valid record for store tests; override fields as needed. */
export function sampleRecord(
  overrides: Partial<MatchRecord> = {},
): MatchRecord {
  return {
    id: "m1",
    gameId: "tic-tac-toe",
    seats: {
      x: { player: { kind: "human" }, tokenHash: "aa" },
      o: { player: { kind: "human" }, tokenHash: "bb" },
    },
    moves: [],
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Behaviour every MatchStore must show. Register it once per implementation:
 * `Deno.test("...", (t) => assertMatchStoreContract(t, () => new MyStore()))`.
 * `makeStore` must return an empty store on every call.
 */
export async function assertMatchStoreContract(
  t: Deno.TestContext,
  makeStore: () => MatchStore | Promise<MatchStore>,
): Promise<void> {
  await t.step("get returns undefined for an unknown id", async () => {
    const store = await makeStore();
    assertEquals(await store.get("nope"), undefined);
  });

  await t.step("create then get round-trips the record", async () => {
    const store = await makeStore();
    const record = sampleRecord({
      moves: [mv("a1"), { kind: "chance", chance: "6-1" }, mv("b2")],
      seed: "s3cret",
      outcome: { kind: "forfeit", winner: "x", seat: "o", reason: "timeout" },
    });
    await store.create(record);
    assertEquals(await store.get("m1"), record);
  });

  await t.step("create rejects a duplicate id", async () => {
    const store = await makeStore();
    await store.create(sampleRecord());
    await assertRejects(() => store.create(sampleRecord()));
  });

  await t.step("update replaces the record at the next version", async () => {
    const store = await makeStore();
    await store.create(sampleRecord());
    const next = sampleRecord({ moves: [mv("a1")], version: 2 });
    assertEquals(await store.update(next), true);
    assertEquals(await store.get("m1"), next);
  });

  await t.step("update rejects a stale or skipped version", async () => {
    const store = await makeStore();
    await store.create(sampleRecord());
    assertEquals(
      await store.update(sampleRecord({ moves: [mv("a1")], version: 2 })),
      true,
    );
    assertEquals(
      await store.update(sampleRecord({ moves: [mv("b1")], version: 2 })),
      false,
    );
    assertEquals(
      await store.update(sampleRecord({ moves: [mv("c1")], version: 4 })),
      false,
    );
    assertEquals((await store.get("m1"))?.moves, [mv("a1")]);
  });

  await t.step("update of an unknown Match returns false", async () => {
    const store = await makeStore();
    assertEquals(await store.update(sampleRecord({ version: 2 })), false);
    assertEquals(await store.get("m1"), undefined);
  });

  await t.step("records are not shared with callers", async () => {
    const store = await makeStore();
    const record = sampleRecord({ moves: [mv("a1")] });
    await store.create(record);
    (record.moves as MoveListEntry[]).push(mv("b1"));
    const read = await store.get("m1");
    (read!.moves as MoveListEntry[]).push(mv("c1"));
    assertEquals((await store.get("m1"))?.moves, [mv("a1")]);
  });

  await t.step("list pages newest first, ties broken by id", async () => {
    const store = await makeStore();
    const at = (n: number) => `2026-01-0${n}T00:00:00.000Z`;
    for (
      const [id, day] of [["a", 2], ["c", 1], ["b", 1], ["d", 3]] as const
    ) {
      await store.create(sampleRecord({ id, createdAt: at(day) }));
    }
    const first = await store.list({ limit: 3 });
    assertEquals(first.matches.map((m) => m.id), ["d", "a", "c"]);
    assertEquals(first.next, { createdAt: at(1), id: "c" });
    const second = await store.list({ limit: 3, after: first.next! });
    assertEquals(second.matches.map((m) => m.id), ["b"]);
    assertEquals(second.next, undefined);
    // An exactly full last page has no next.
    assertEquals((await store.list({ limit: 4 })).next, undefined);
    assertEquals((await store.list({ limit: 50 })).matches.length, 4);
  });

  await t.step("list returns whole records", async () => {
    const store = await makeStore();
    const record = sampleRecord({ moves: [mv("a1")], seed: "s" });
    await store.create(record);
    assertEquals((await store.list({ limit: 10 })).matches, [record]);
  });

  await t.step("list filters by Game and by finished", async () => {
    const store = await makeStore();
    const over: MatchRecord["outcome"] = {
      kind: "resignation",
      winner: "o",
      seat: "x",
    };
    await store.create(sampleRecord({ id: "t1", createdAt: "2026-01-01" }));
    await store.create(
      sampleRecord({ id: "t2", createdAt: "2026-01-02", outcome: over }),
    );
    await store.create(
      sampleRecord({ id: "c1", gameId: "chess", createdAt: "2026-01-03" }),
    );
    const ids = async (q: Partial<MatchQuery>) =>
      (await store.list({ limit: 10, ...q })).matches.map((m) => m.id);
    assertEquals(await ids({ gameId: "tic-tac-toe" }), ["t2", "t1"]);
    assertEquals(await ids({ finished: true }), ["t2"]);
    assertEquals(await ids({ finished: false }), ["c1", "t1"]);
    assertEquals(await ids({ gameId: "tic-tac-toe", finished: false }), ["t1"]);
    assertEquals(await ids({ gameId: "go" }), []);
    // A Match moves between the filters when its Outcome is set.
    await store.update(sampleRecord({
      id: "t1",
      createdAt: "2026-01-01",
      outcome: over,
      version: 2,
    }));
    assertEquals(await ids({ finished: true }), ["t2", "t1"]);
    // Filters and paging combine.
    const page = await store.list({ finished: true, limit: 1 });
    assertEquals(page.matches.map((m) => m.id), ["t2"]);
    assertEquals(
      (await store.list({ finished: true, limit: 1, after: page.next! }))
        .matches.map((m) => m.id),
      ["t1"],
    );
  });
}
