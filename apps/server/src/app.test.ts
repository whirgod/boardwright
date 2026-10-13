import { assertEquals } from "@std/assert";
import type { GameRules } from "@boardwright/core";
import { buildApp } from "./app.ts";

const fakeGame = {
  id: "fake",
  name: "Fake",
  seats: ["first", "second"],
} as unknown as GameRules<unknown, unknown>;

Deno.test("server reports health", async () => {
  const app = buildApp({ games: [] });
  const res = await app.request("/api/health");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: "ok" });
});

Deno.test("server lists registered games", async () => {
  const app = buildApp({ games: [fakeGame] });
  const res = await app.request("/api/games");
  assertEquals(await res.json(), [
    { id: "fake", name: "Fake", seats: ["first", "second"] },
  ]);
});
