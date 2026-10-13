import { assertEquals, assertRejects } from "@std/assert";
import { checkers } from "@boardwright/game-checkers";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import { verifyCatalog } from "./catalog.ts";
import type { AnyGameRules } from "./games.ts";
import { hostedCatalog } from "./hosted-catalog.ts";

const ttt = ticTacToe as unknown as AnyGameRules;
const chk = checkers as unknown as AnyGameRules;
const tttModule = import.meta.resolve(
  "@boardwright/engine-tic-tac-toe-minimax",
);
const inline = (source: string) =>
  `data:text/javascript,${encodeURIComponent(source)}`;
const engine = (module: string) => ({ id: "e", name: "E", module });

Deno.test("verifyCatalog builds the registries of a valid catalog", async () => {
  const { games, engines } = await verifyCatalog([
    { game: ttt, engines: [engine(tttModule)] },
    { game: chk, engines: [] },
  ]);
  assertEquals(games.map((g) => g.id), ["tic-tac-toe", "checkers"]);
  assertEquals(engines.get("tic-tac-toe", "e")?.gameId, "tic-tac-toe");
  assertEquals(engines.list("checkers"), []);
});

Deno.test("verifyCatalog rejects an Engine of another Game", async () => {
  await assertRejects(
    () => verifyCatalog([{ game: chk, engines: [engine(tttModule)] }]),
    Error,
    'exported rules are for Game "tic-tac-toe"',
  );
});

Deno.test("verifyCatalog rejects rules and engine disagreeing", async () => {
  const module = inline(
    `export const rules = { id: "tic-tac-toe", notation: {} };
     export const engine = { gameId: "checkers", analyze() {} };`,
  );
  await assertRejects(
    () => verifyCatalog([{ game: ttt, engines: [engine(module)] }]),
    Error,
    'exported engine is for Game "checkers"',
  );
});

Deno.test("verifyCatalog rejects missing or malformed exports", async () => {
  const cases: [string, string][] = [
    ["export const engine = {};", "does not export `rules`"],
    [
      `export const rules = { id: "tic-tac-toe", notation: {} };`,
      "does not export `engine`",
    ],
    [
      `export const rules = { id: "tic-tac-toe", notation: {} };
       export const engine = { gameId: "tic-tac-toe" };`,
      "no `analyze`",
    ],
  ];
  for (const [source, message] of cases) {
    await assertRejects(
      () => verifyCatalog([{ game: ttt, engines: [engine(inline(source))] }]),
      Error,
      message,
    );
  }
});

Deno.test("verifyCatalog rejects an unknown Engine module and lists all problems", async () => {
  const error = await assertRejects(
    () =>
      verifyCatalog([
        {
          game: ttt,
          engines: [
            engine("file:///does/not/exist.ts"),
            { id: "other", name: "O", module: inline("export {}") },
          ],
        },
      ]),
    Error,
    "failed to load",
  );
  assertEquals(error.message.includes("does not export `rules`"), true);
});

Deno.test("verifyCatalog rejects duplicate Engine ids of a Game", async () => {
  await assertRejects(
    () =>
      verifyCatalog([{
        game: ttt,
        engines: [engine(tttModule), engine(tttModule)],
      }]),
    Error,
    "Duplicate Engine",
  );
});

Deno.test("the hosted catalog is valid and hosts the four Games", async () => {
  const { games, engines } = await verifyCatalog(hostedCatalog);
  assertEquals(games.map((g) => g.id), [
    "tic-tac-toe",
    "nine-mens-morris",
    "checkers",
    "chess",
  ]);
  for (const id of ["tic-tac-toe", "nine-mens-morris", "checkers", "chess"]) {
    assertEquals(engines.list(id).map((e) => e.id), ["minimax"]);
  }
});
