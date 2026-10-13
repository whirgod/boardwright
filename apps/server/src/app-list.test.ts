import { assert, assertEquals } from "@std/assert";
import type { GameRules } from "@boardwright/core";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import { diceRace } from "@boardwright/testing";
import { buildApp, type ErrorBody } from "./app.ts";
import type { CreatedMatch } from "./game-master.ts";

const HUMANS = { x: { kind: "human" }, o: { kind: "human" } } as const;

function post(
  a: ReturnType<typeof buildApp>,
  path: string,
  body: unknown,
): Promise<Response> {
  return Promise.resolve(a.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function createTicTacToe(
  a: ReturnType<typeof buildApp>,
): Promise<CreatedMatch> {
  const res = await post(a, "/api/matches", {
    gameId: "tic-tac-toe",
    seats: HUMANS,
  });
  return await res.json();
}

Deno.test("GET /api/matches lists summaries newest first, with paging and filters", async () => {
  let tick = 0;
  const a = buildApp({
    games: [ticTacToe, diceRace as GameRules<unknown, unknown>],
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
  const ttt: CreatedMatch[] = [];
  for (let i = 0; i < 3; i++) ttt.push(await createTicTacToe(a));
  const dice = await (await post(a, "/api/matches", {
    gameId: "dice-race",
    seats: { a: { kind: "human" }, b: { kind: "human" } },
  })).json() as CreatedMatch;
  await post(a, `/api/matches/${ttt[0]!.match.id}/resign`, {
    token: ttt[0]!.tokens.x,
  });
  const list = async (query = "") => {
    const res = await a.request(`/api/matches${query}`);
    assertEquals(res.status, 200);
    return await res.json() as {
      matches: { id: string; moveCount: number; outcome: unknown }[];
      nextCursor: string | null;
    };
  };

  const all = await list();
  assertEquals(all.matches.map((m) => m.id), [
    dice.match.id,
    ttt[2]!.match.id,
    ttt[1]!.match.id,
    ttt[0]!.match.id,
  ]);
  assertEquals(all.nextCursor, null);
  assertEquals(all.matches[0]!.moveCount, 1); // the opening roll
  const json = JSON.stringify(all);
  assert(!json.includes("tokenHash") && !json.includes("seed"));
  assert(!json.includes("position") && !json.includes(ttt[0]!.tokens.x!));
  assertEquals(Object.keys(all.matches[1]!).sort(), [
    "createdAt",
    "gameId",
    "id",
    "moveCount",
    "outcome",
    "seats",
    "updatedAt",
    "version",
  ]);

  const first = await list("?limit=3");
  assertEquals(first.matches.length, 3);
  assert(first.nextCursor);
  const second = await list(
    `?limit=3&cursor=${encodeURIComponent(first.nextCursor)}`,
  );
  assertEquals(second.matches.map((m) => m.id), [ttt[0]!.match.id]);
  assertEquals(second.nextCursor, null);

  assertEquals((await list("?game=dice-race")).matches.length, 1);
  assertEquals((await list("?game=unknown")).matches, []);
  const done = await list("?finished=true");
  assertEquals(done.matches.map((m) => m.id), [ttt[0]!.match.id]);
  assertEquals(
    (done.matches[0]!.outcome as { kind: string }).kind,
    "resignation",
  );
  const running = await list("?finished=false&game=tic-tac-toe");
  assertEquals(running.matches.length, 2);
});

Deno.test("GET /api/matches rejects bad query parameters", async () => {
  const a = buildApp({ games: [ticTacToe] });
  for (
    const query of [
      "?limit=0",
      "?limit=101",
      "?limit=abc",
      "?limit=1.5",
      "?finished=maybe",
      "?game=",
      "?cursor=%25%25",
      "?cursor=e30",
      "?cursor=WzEsMl0",
      "?color=red",
    ]
  ) {
    const res = await a.request(`/api/matches${query}`);
    const body: ErrorBody = await res.json();
    assertEquals(res.status, 400, query);
    assertEquals(body.error.code, "invalid-request", query);
  }
});
