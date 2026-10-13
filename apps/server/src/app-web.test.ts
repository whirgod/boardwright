import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
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
    assertEquals(res.headers.get("cache-control"), "no-cache", path);
    assertEquals(res.headers.get("referrer-policy"), "no-referrer");
    assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  }
  const asset = await app.request("/app.js");
  assertEquals(asset.status, 200);
  assertEquals(asset.headers.get("cache-control"), null);
  assertEquals(asset.headers.get("referrer-policy"), "no-referrer");
  await asset.body?.cancel();
  const missing = await app.request("/missing.js");
  assertEquals(missing.status, 404);
  await missing.body?.cancel();
});

Deno.test("web UI: API paths keep the API's JSON errors", async () => {
  const app = buildApp({ games: [ticTacToe], webRoot });
  for (const path of ["/api/nope", "/api", "/api?x=1"]) {
    const res = await app.request(path);
    assertEquals(res.status, 404, path);
    assertEquals((await res.json()).error.code, "not-found", path);
  }
  const games = await app.request("/api/games");
  assertEquals((await games.json())[0].id, "tic-tac-toe");
});

Deno.test("web UI: without webRoot only the API is served", async () => {
  const res = await buildApp({ games: [ticTacToe] }).request("/");
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error.code, "not-found");
});

Deno.test("web UI: paths cannot escape webRoot", async () => {
  const app = buildApp({ games: [ticTacToe], webRoot });
  // Both targets exist outside test-web/: src/app.ts and apps/server/deno.json.
  for (
    const path of [
      "/../app.ts",
      "/%2e%2e/app.ts",
      "/..%2fapp.ts",
      "/..%2f..%2fdeno.json",
      "/%2e%2e/%2e%2e/deno.json",
      "/..%5capp.ts",
    ]
  ) {
    const res = await app.request(path);
    const body = await res.text();
    assertNotEquals(res.status, 200, path);
    assert(!body.includes("buildApp"), path);
    assert(!body.includes("@boardwright/server"), path);
  }
});
