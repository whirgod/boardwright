import { assertEquals, assertStringIncludes } from "@std/assert";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import { buildApp } from "./app.ts";

const webRoot = `${import.meta.dirname}/test-web`;

Deno.test("web UI: served at non-API paths when webRoot is set", async () => {
  const app = buildApp({ games: [ticTacToe], webRoot });
  for (const path of ["/", "/index.html"]) {
    const res = await app.request(path);
    assertEquals(res.status, 200, path);
    assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
    assertStringIncludes(await res.text(), "test UI");
  }
  const missing = await app.request("/missing.js");
  assertEquals(missing.status, 404);
  await missing.body?.cancel();
});

Deno.test("web UI: API paths keep the API's JSON errors", async () => {
  const app = buildApp({ games: [ticTacToe], webRoot });
  const res = await app.request("/api/nope");
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error.code, "not-found");
  const games = await app.request("/api/games");
  assertEquals((await games.json())[0].id, "tic-tac-toe");
});

Deno.test("web UI: without webRoot only the API is served", async () => {
  const res = await buildApp({ games: [ticTacToe] }).request("/");
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error.code, "not-found");
});
