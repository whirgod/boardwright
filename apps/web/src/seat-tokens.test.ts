import { assertEquals } from "@std/assert";
import {
  type KeyValueStorage,
  playingTokens,
  SeatTokens,
} from "./seat-tokens.ts";

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const KEY = "boardwright:seat-tokens:m1";

Deno.test("holds no Seats for an unknown Match", () => {
  assertEquals(new SeatTokens(memoryStorage()).get("m1"), {
    tokens: {},
    handedOver: [],
  });
});

Deno.test("adds tokens per Match, merging Seats, and persists them", () => {
  const storage = memoryStorage();
  const tokens = new SeatTokens(storage);
  assertEquals(tokens.add("m1", { x: "tx" }), []);
  assertEquals(tokens.add("m1", { o: "to" }), []);
  tokens.add("m2", { x: "other" });
  assertEquals(tokens.get("m1").tokens, { x: "tx", o: "to" });
  // A fresh instance (e.g. after a reload) reads them back.
  assertEquals(new SeatTokens(storage).get("m1").tokens, { x: "tx", o: "to" });
  assertEquals(new SeatTokens(storage).get("m2").tokens, { x: "other" });
});

Deno.test("never replaces a held token: a different one for the same Seat is refused", () => {
  const storage = memoryStorage();
  const tokens = new SeatTokens(storage);
  tokens.add("m1", { x: "mine" });
  assertEquals(tokens.add("m1", { x: "garbage", o: "to" }), ["x"]);
  assertEquals(tokens.get("m1").tokens, { x: "mine", o: "to" });
  assertEquals(new SeatTokens(storage).get("m1").tokens.x, "mine");
  // The same token again is not a conflict.
  assertEquals(tokens.add("m1", { x: "mine" }), []);
});

Deno.test("handing a Seat over keeps its token but stops playing it; it can be taken back", () => {
  const storage = memoryStorage();
  const tokens = new SeatTokens(storage);
  tokens.add("m1", { x: "tx", o: "to" });
  tokens.handOver("m1", "o");
  tokens.handOver("m1", "o");
  const holding = new SeatTokens(storage).get("m1");
  assertEquals(holding, { tokens: { x: "tx", o: "to" }, handedOver: ["o"] });
  assertEquals(playingTokens(holding), { x: "tx" });
  tokens.takeBack("m1", "o");
  assertEquals(playingTokens(tokens.get("m1")), { x: "tx", o: "to" });
});

Deno.test("ignores corrupt stored values", () => {
  const storage = memoryStorage();
  const empty = { tokens: {}, handedOver: [] };
  for (const raw of ["{not json", "null", "42", '{"tokens":[1]}']) {
    storage.data.set(KEY, raw);
    assertEquals(new SeatTokens(storage).get("m1"), empty);
  }
  storage.data.set(
    KEY,
    '{"tokens":{"x":"t","o":5},"handedOver":["o",3]}',
  );
  assertEquals(new SeatTokens(storage).get("m1"), {
    tokens: { x: "t" },
    handedOver: ["o"],
  });
  storage.data.set(KEY, '{"tokens":{"x":"t"},"handedOver":"o"}');
  assertEquals(new SeatTokens(storage).get("m1").handedOver, []);
});

Deno.test("keeps tokens in memory when storage is missing or throws", () => {
  const none = new SeatTokens(undefined);
  none.add("m1", { x: "t" });
  assertEquals(none.get("m1").tokens, { x: "t" });

  const failing: KeyValueStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("quota");
    },
  };
  const tokens = new SeatTokens(failing);
  assertEquals(tokens.get("m1").tokens, {});
  tokens.add("m1", { o: "t" });
  assertEquals(tokens.get("m1").tokens, { o: "t" });
});
