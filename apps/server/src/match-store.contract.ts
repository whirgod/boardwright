import { assertEquals, assertRejects } from "@std/assert";
import type { MatchRecord, MatchStore } from "./match-store.ts";

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
      moves: ["a1", "b2"],
      outcome: { winner: "x", reason: "three-in-a-row" },
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
    const next = sampleRecord({ moves: ["a1"], version: 2 });
    assertEquals(await store.update(next), true);
    assertEquals(await store.get("m1"), next);
  });

  await t.step("update rejects a stale or skipped version", async () => {
    const store = await makeStore();
    await store.create(sampleRecord());
    assertEquals(
      await store.update(sampleRecord({ moves: ["a1"], version: 2 })),
      true,
    );
    assertEquals(
      await store.update(sampleRecord({ moves: ["b1"], version: 2 })),
      false,
    );
    assertEquals(
      await store.update(sampleRecord({ moves: ["c1"], version: 4 })),
      false,
    );
    assertEquals((await store.get("m1"))?.moves, ["a1"]);
  });

  await t.step("update of an unknown Match returns false", async () => {
    const store = await makeStore();
    assertEquals(await store.update(sampleRecord({ version: 2 })), false);
    assertEquals(await store.get("m1"), undefined);
  });

  await t.step("records are not shared with callers", async () => {
    const store = await makeStore();
    const record = sampleRecord({ moves: ["a1"] });
    await store.create(record);
    (record.moves as string[]).push("b1");
    const read = await store.get("m1");
    (read!.moves as string[]).push("c1");
    assertEquals((await store.get("m1"))?.moves, ["a1"]);
  });
}
