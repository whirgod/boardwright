import { assert, assertEquals, assertMatch } from "@std/assert";
import type { GameRules } from "@boardwright/core";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import { buildApp, type ErrorBody, type ErrorCode } from "./app.ts";
import type { CreatedMatch, MatchView } from "./game-master.ts";
import { InMemoryMatchStore, type MatchStore } from "./match-store.ts";

const fakeGame = {
  id: "fake",
  name: "Fake",
  seats: ["first", "second"],
} as unknown as GameRules<unknown, unknown>;

const HUMANS = { x: { kind: "human" }, o: { kind: "human" } } as const;

function app(store?: MatchStore) {
  return buildApp({
    games: [ticTacToe],
    now: () => new Date("2026-01-01T00:00:00Z"),
    ...(store ? { store } : {}),
  });
}

type App = ReturnType<typeof app>;

function post(a: App, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(a.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

async function create(a: App): Promise<CreatedMatch> {
  const res = await post(a, "/api/matches", {
    gameId: "tic-tac-toe",
    seats: HUMANS,
  });
  assertEquals(res.status, 201);
  return await res.json();
}

async function assertError(
  res: Response | Promise<Response>,
  status: number,
  code: ErrorCode,
): Promise<ErrorBody> {
  const r = await res;
  const body: ErrorBody = await r.json();
  assertEquals(r.status, status, JSON.stringify(body));
  assertEquals(Object.keys(body), ["error"]);
  assertEquals(body.error.code, code);
  assertEquals(typeof body.error.message, "string");
  assert(body.error.message.length > 0);
  return body;
}

Deno.test("server reports health", async () => {
  const res = await buildApp({ games: [] }).request("/api/health");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: "ok" });
});

Deno.test("server lists registered games", async () => {
  const res = await buildApp({ games: [fakeGame] }).request("/api/games");
  assertEquals(await res.json(), [
    { id: "fake", name: "Fake", seats: ["first", "second"] },
  ]);
});

Deno.test("POST /api/matches creates a Match and returns seat tokens", async () => {
  const a = app();
  const res = await post(a, "/api/matches", {
    gameId: "tic-tac-toe",
    seats: HUMANS,
  });
  assertEquals(res.status, 201);
  const { match, tokens }: CreatedMatch = await res.json();
  assertEquals(res.headers.get("location"), `/api/matches/${match.id}`);
  assertMatch(match.id, /^[0-9a-f-]{36}$/);
  assertEquals(match.gameId, "tic-tac-toe");
  assertEquals(match.seats, HUMANS);
  assertEquals(match.moves, []);
  assertEquals(match.position, ".........:x");
  assertEquals(match.toMove, "x");
  assertEquals(match.outcome, null);
  assertEquals(Object.keys(tokens), ["x", "o"]);
});

Deno.test("GET /api/matches/:id shows the Match without tokens", async () => {
  const a = app();
  const { match, tokens } = await create(a);
  const res = await a.request(`/api/matches/${match.id}`);
  assertEquals(res.status, 200);
  const text = await res.text();
  assert(!text.includes(tokens.x!) && !text.includes(tokens.o!));
  assert(!text.includes("token"));
  const view: MatchView = JSON.parse(text);
  assertEquals(view, match);
  assertEquals(Object.keys(view).sort(), [
    "createdAt",
    "gameId",
    "id",
    "legalMoves",
    "moves",
    "outcome",
    "position",
    "seats",
    "toMove",
    "updatedAt",
  ]);
});

Deno.test("POST /api/matches/:id/moves plays a full Match to an Outcome", async () => {
  const a = app();
  const { match, tokens } = await create(a);
  const moves = ["a1", "a2", "b1", "b2", "c1"];
  let view: MatchView | undefined;
  for (const [i, move] of moves.entries()) {
    const token = i % 2 === 0 ? tokens.x : tokens.o;
    const res = await post(a, `/api/matches/${match.id}/moves`, {
      move,
      token,
    });
    assertEquals(res.status, 200);
    view = await res.json();
    assertEquals(view?.moves, moves.slice(0, i + 1));
  }
  assertEquals(view?.outcome, { winner: "x", reason: "three-in-a-row" });
  assertEquals(view?.toMove, null);
  assertEquals(view?.legalMoves, []);
  assertEquals(
    await (await a.request(`/api/matches/${match.id}`)).json(),
    view,
  );

  await assertError(
    post(a, `/api/matches/${match.id}/moves`, { move: "c3", token: tokens.o }),
    409,
    "match-finished",
  );
});

Deno.test("POST /api/matches rejects bad bodies with 400", async () => {
  const a = app();
  const bad: unknown[] = [
    "{not json",
    "",
    "[]",
    "null",
    { seats: HUMANS },
    { gameId: "", seats: HUMANS },
    { gameId: 7, seats: HUMANS },
    { gameId: "tic-tac-toe" },
    { gameId: "tic-tac-toe", seats: [] },
    { gameId: "tic-tac-toe", seats: { x: "human", o: { kind: "human" } } },
    { gameId: "tic-tac-toe", seats: { x: null, o: { kind: "human" } } },
    {
      gameId: "tic-tac-toe",
      seats: { x: { kind: "robot" }, o: { kind: "human" } },
    },
    {
      gameId: "tic-tac-toe",
      seats: { x: { kind: "human", name: "Ann" }, o: { kind: "human" } },
    },
    { gameId: "tic-tac-toe", seats: HUMANS, extra: 1 },
  ];
  for (const body of bad) {
    await assertError(post(a, "/api/matches", body), 400, "invalid-request");
  }
});

Deno.test("POST /api/matches rejects Seats that do not fit the Game with 400", async () => {
  const a = app();
  const res = post(a, "/api/matches", {
    gameId: "tic-tac-toe",
    seats: { x: { kind: "human" } },
  });
  const body = await assertError(res, 400, "invalid-seats");
  assertMatch(body.error.message, /missing Seat\(s\): o/);
  await assertError(
    post(a, "/api/matches", {
      gameId: "tic-tac-toe",
      seats: { ...HUMANS, white: { kind: "human" } },
    }),
    400,
    "invalid-seats",
  );
});

Deno.test("POST /api/matches with an unknown Game is 404", async () => {
  await assertError(
    post(app(), "/api/matches", { gameId: "chess", seats: HUMANS }),
    404,
    "unknown-game",
  );
});

Deno.test("unknown Matches are 404", async () => {
  const a = app();
  await assertError(a.request("/api/matches/nope"), 404, "unknown-match");
  await assertError(
    post(a, "/api/matches/nope/moves", { move: "a1", token: "t" }),
    404,
    "unknown-match",
  );
});

Deno.test("POST /api/matches/:id/moves rejects bad bodies with 400", async () => {
  const a = app();
  const { match, tokens } = await create(a);
  const bad: unknown[] = [
    "{",
    '"a1"',
    {},
    { move: "a1" },
    { token: tokens.x },
    { move: 11, token: tokens.x },
    { move: "a1", token: 5 },
    { move: "a1", token: tokens.x, seat: "x" },
  ];
  for (const body of bad) {
    await assertError(
      post(a, `/api/matches/${match.id}/moves`, body),
      400,
      "invalid-request",
    );
  }
});

Deno.test("POST /api/matches/:id/moves refuses undecodable and illegal Moves with 400", async () => {
  const a = app();
  const { match, tokens } = await create(a);
  const path = `/api/matches/${match.id}/moves`;
  await assertError(
    post(a, path, { move: "z9", token: tokens.x }),
    400,
    "invalid-move",
  );
  assertEquals(
    (await post(a, path, { move: "b2", token: tokens.x })).status,
    200,
  );
  await assertError(
    post(a, path, { move: "b2", token: tokens.o }),
    400,
    "illegal-move",
  );
});

Deno.test("POST /api/matches/:id/moves enforces tokens and turn order with 403", async () => {
  const a = app();
  const { match, tokens } = await create(a);
  const other = await create(a);
  const path = `/api/matches/${match.id}/moves`;
  await assertError(
    post(a, path, { move: "a1", token: "wrong" }),
    403,
    "invalid-token",
  );
  await assertError(
    post(a, path, { move: "a1", token: other.tokens.x }),
    403,
    "invalid-token",
  );
  await assertError(
    post(a, path, { move: "a1", token: tokens.o }),
    403,
    "not-your-turn",
  );
  assertEquals(
    (await post(a, path, { move: "a1", token: tokens.x })).status,
    200,
  );
  await assertError(
    post(a, path, { move: "b1", token: tokens.x }),
    403,
    "not-your-turn",
  );
});

Deno.test("a lost concurrent update is 409 conflict", async () => {
  const inner = new InMemoryMatchStore();
  const store: MatchStore = {
    create: (r) => inner.create(r),
    get: (id) => inner.get(id),
    update: () => Promise.resolve(false),
  };
  const a = app(store);
  const { match, tokens } = await create(a);
  await assertError(
    post(a, `/api/matches/${match.id}/moves`, { move: "a1", token: tokens.x }),
    409,
    "conflict",
  );
});

Deno.test("unexpected failures are 500 with the error shape", async () => {
  const store: MatchStore = {
    create: () => Promise.reject(new Error("disk on fire")),
    get: () => Promise.reject(new Error("disk on fire")),
    update: () => Promise.reject(new Error("disk on fire")),
  };
  const a = app(store);
  const originalError = console.error;
  console.error = () => {};
  try {
    const body = await assertError(
      a.request("/api/matches/x"),
      500,
      "internal",
    );
    assert(!body.error.message.includes("disk"));
  } finally {
    console.error = originalError;
  }
});

Deno.test("unknown routes are 404 with the error shape", async () => {
  await assertError(app().request("/api/nope"), 404, "not-found");
});
