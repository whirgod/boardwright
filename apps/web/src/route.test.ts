import { assertEquals } from "@std/assert";
import { parseRoute, type Route, routeHash, shareLink } from "./route.ts";

Deno.test("parseRoute: Game list, new Match form and Match pages", () => {
  assertEquals(parseRoute(""), { page: "games" });
  assertEquals(parseRoute("#/"), { page: "games" });
  assertEquals(parseRoute("#/games/tic-tac-toe/new"), {
    page: "new-match",
    gameId: "tic-tac-toe",
  });
  assertEquals(parseRoute("#/matches/a%20b"), {
    page: "match",
    matchId: "a b",
  });
});

Deno.test("parseRoute: a share link carries a Seat and its token", () => {
  assertEquals(parseRoute("#/matches/m1?seat=o&token=abc"), {
    page: "match",
    matchId: "m1",
    invite: { seat: "o", token: "abc" },
  });
  // Both are needed.
  assertEquals(parseRoute("#/matches/m1?seat=o"), {
    page: "match",
    matchId: "m1",
  });
});

Deno.test("parseRoute: anything else is not-found", () => {
  for (
    const hash of ["#/nope", "#/games/x", "#/matches/%E0%A4%A", "#/matches/a/b"]
  ) {
    assertEquals(parseRoute(hash), { page: "not-found", hash });
  }
});

Deno.test("routeHash round-trips through parseRoute", () => {
  const routes: Route[] = [
    { page: "games" },
    { page: "new-match", gameId: "nine mens/morris" },
    { page: "match", matchId: "m?1#" },
  ];
  for (const route of routes) {
    assertEquals(parseRoute(routeHash(route)), route);
  }
  assertEquals(routeHash({ page: "not-found", hash: "#/x" }), "#/x");
  assertEquals(
    routeHash({
      page: "match",
      matchId: "m",
      invite: { seat: "x", token: "t" },
    }),
    "#/matches/m",
  );
});

Deno.test("shareLink: opens the Match holding the given Seat", () => {
  const link = shareLink("https://host", "m1", "o", "t&k");
  assertEquals(link, "https://host/#/matches/m1?seat=o&token=t%26k");
  assertEquals(parseRoute(new URL(link).hash), {
    page: "match",
    matchId: "m1",
    invite: { seat: "o", token: "t&k" },
  });
});
