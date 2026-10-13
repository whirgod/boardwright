import { assertEquals } from "@std/assert";
import { buildApp } from "./app.ts";

Deno.test("server reports health", async () => {
  const app = buildApp({ games: [] });
  const res = await app.request("/api/health");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: "ok" });
});

Deno.test("server lists registered games", async () => {
  const app = buildApp({ games: [] });
  const res = await app.request("/api/games");
  assertEquals(await res.json(), []);
});
