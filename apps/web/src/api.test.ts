import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { ApiClient, ApiError, type MatchView } from "./api.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that records calls and answers with `respond`. */
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const MATCH: MatchView = {
  id: "m 1",
  gameId: "tic-tac-toe",
  seats: { x: { kind: "human" }, o: { kind: "engine", engineId: "minimax" } },
  moves: [],
  position: ".........:x",
  toMove: "x",
  legalMoves: ["a1"],
  outcome: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

Deno.test("listGames and listEngines GET the API, ids URL-encoded", async () => {
  const { fetch, calls } = fakeFetch((call) =>
    json(
      call.url.endsWith("/engines") ? [{ id: "e", name: "E" }] : [
        { id: "tic-tac-toe", name: "Tic-tac-toe", seats: ["x", "o"] },
      ],
    )
  );
  const api = new ApiClient({ fetch, baseUrl: "http://host" });
  assertEquals((await api.listGames())[0]?.id, "tic-tac-toe");
  assertEquals(await api.listEngines("a/b"), [{ id: "e", name: "E" }]);
  assertEquals(calls.map((c) => [c.method, c.url]), [
    ["GET", "http://host/api/games"],
    ["GET", "http://host/api/games/a%2Fb/engines"],
  ]);
  assertEquals(calls[0]!.headers["content-type"], undefined);
});

Deno.test("createMatch POSTs JSON and returns the Match with its seat tokens", async () => {
  const { fetch, calls } = fakeFetch(() =>
    json({ match: MATCH, tokens: { x: "t" } }, 201)
  );
  const api = new ApiClient({ fetch });
  const created = await api.createMatch("tic-tac-toe", {
    x: { kind: "human" },
    o: { kind: "engine", engineId: "minimax", limits: { maxTimeMs: 100 } },
  });
  assertEquals(created.tokens, { x: "t" });
  assertEquals(calls[0]!.method, "POST");
  assertEquals(calls[0]!.url, "/api/matches");
  assertEquals(calls[0]!.headers["content-type"], "application/json");
  assertEquals(calls[0]!.body, {
    gameId: "tic-tac-toe",
    seats: {
      x: { kind: "human" },
      o: { kind: "engine", engineId: "minimax", limits: { maxTimeMs: 100 } },
    },
  });
});

Deno.test("getMatch and playMove address the Match by encoded id", async () => {
  const { fetch, calls } = fakeFetch(() => json(MATCH));
  const api = new ApiClient({ fetch });
  assertEquals(await api.getMatch("m 1"), MATCH);
  assertEquals(await api.playMove("m 1", "a1", "secret"), MATCH);
  assertEquals(calls.map((c) => [c.method, c.url, c.body]), [
    ["GET", "/api/matches/m%201", undefined],
    ["POST", "/api/matches/m%201/moves", { move: "a1", token: "secret" }],
  ]);
});

Deno.test("error bodies become ApiErrors with the server's code and status", async () => {
  const { fetch } = fakeFetch(() =>
    json({ error: { code: "not-your-turn", message: "Not x's turn" } }, 403)
  );
  const error = await assertRejects(
    () => new ApiClient({ fetch }).playMove("m", "a1", "t"),
    ApiError,
    "Not x's turn",
  );
  assertEquals([error.code, error.status], ["not-your-turn", 403]);
});

Deno.test("failures without an error body are bad-response errors", async () => {
  const notJson = fakeFetch(() => new Response("<html>", { status: 502 }));
  const e1 = await assertRejects(
    () => new ApiClient({ fetch: notJson.fetch }).listGames(),
    ApiError,
  );
  assertEquals([e1.code, e1.status], ["bad-response", 502]);

  const otherJson = fakeFetch(() => json({ oops: true }, 500));
  const e2 = await assertRejects(
    () => new ApiClient({ fetch: otherJson.fetch }).listGames(),
    ApiError,
    "HTTP 500",
  );
  assertEquals(e2.code, "bad-response");

  const wrongShape = fakeFetch(() => json({ error: { code: 1 } }, 400));
  const e3 = await assertRejects(
    () => new ApiClient({ fetch: wrongShape.fetch }).listGames(),
    ApiError,
  );
  assertEquals(e3.code, "bad-response");
});

Deno.test("network failures are ApiErrors with status 0", async () => {
  const fetch: typeof globalThis.fetch = () =>
    Promise.reject(new TypeError("connection refused"));
  const error = await assertRejects(
    () => new ApiClient({ fetch }).listGames(),
    ApiError,
    "connection refused",
  );
  assertEquals([error.code, error.status], ["network", 0]);
  assertInstanceOf(error, Error);

  const odd: typeof globalThis.fetch = () => Promise.reject("down");
  await assertRejects(
    () => new ApiClient({ fetch: odd }).listGames(),
    ApiError,
    "down",
  );
});

Deno.test("defaults to the global fetch on the same origin", async () => {
  const original = globalThis.fetch;
  const { fetch, calls } = fakeFetch(() => json([]));
  globalThis.fetch = fetch;
  try {
    assertEquals(await new ApiClient().listGames(), []);
    assertEquals(calls[0]!.url, "/api/games");
  } finally {
    globalThis.fetch = original;
  }
});
