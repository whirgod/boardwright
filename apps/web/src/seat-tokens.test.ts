import { assertEquals } from "@std/assert";
import { type KeyValueStorage, SeatTokens } from "./seat-tokens.ts";

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

Deno.test("holds no Seats for an unknown Match", () => {
  assertEquals(new SeatTokens(memoryStorage()).get("m1"), {});
});

Deno.test("adds tokens per Match, merging Seats, and persists them", () => {
  const storage = memoryStorage();
  const tokens = new SeatTokens(storage);
  tokens.add("m1", { x: "tx" });
  tokens.add("m1", { o: "to" });
  tokens.add("m2", { x: "other" });
  assertEquals(tokens.get("m1"), { x: "tx", o: "to" });
  // A fresh instance (e.g. after a reload) reads them back.
  assertEquals(new SeatTokens(storage).get("m1"), { x: "tx", o: "to" });
  assertEquals(new SeatTokens(storage).get("m2"), { x: "other" });
});

Deno.test("ignores corrupt stored values", () => {
  const storage = memoryStorage();
  const tokens = new SeatTokens(storage);
  for (const raw of ["{not json", "null", "[1]", "42"]) {
    storage.data.set("boardwright:seat-tokens:m1", raw);
    assertEquals(tokens.get("m1"), {});
  }
  storage.data.set("boardwright:seat-tokens:m1", '{"x":"t","o":5}');
  assertEquals(tokens.get("m1"), { x: "t" });
});

Deno.test("keeps tokens in memory when storage is missing or throws", () => {
  const none = new SeatTokens(undefined);
  none.add("m1", { x: "t" });
  assertEquals(none.get("m1"), { x: "t" });

  const failing: KeyValueStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("quota");
    },
  };
  const tokens = new SeatTokens(failing);
  assertEquals(tokens.get("m1"), {});
  tokens.add("m1", { o: "t" });
  assertEquals(tokens.get("m1"), { o: "t" });
});
