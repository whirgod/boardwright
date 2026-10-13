import { assertEquals, assertThrows } from "@std/assert";
import { EngineRegistry } from "./engines.ts";

const entry = (gameId: string, id: string) => ({
  id,
  name: id.toUpperCase(),
  gameId,
  module: "file:///x.ts",
});

Deno.test("EngineRegistry looks Engines up per Game", () => {
  const registry = new EngineRegistry([
    entry("a", "one"),
    entry("a", "two"),
    entry("b", "one"),
  ]);
  assertEquals(registry.list("a").map((e) => e.id), ["one", "two"]);
  assertEquals(registry.list("b").map((e) => e.id), ["one"]);
  assertEquals(registry.list("c"), []);
  assertEquals(registry.get("b", "one")?.gameId, "b");
  assertEquals(registry.get("b", "two"), undefined);
  assertEquals(new EngineRegistry().list("a"), []);
});

Deno.test("EngineRegistry rejects duplicate ids within a Game", () => {
  assertThrows(
    () => new EngineRegistry([entry("a", "one"), entry("a", "one")]),
    Error,
    "Duplicate Engine",
  );
});
