import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { checkers } from "@boardwright/game-checkers";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import { verifyCatalog } from "./catalog.ts";
import { EngineDriver } from "./engine-driver.ts";
import { EngineRunner } from "./engine-runner.ts";
import { testWorkerAdapter } from "./engine-runner.testing.ts";
import { GameMaster } from "./game-master.ts";
import { type AnyGameRules, GameRegistry } from "./games.ts";
import { InMemoryMatchStore } from "./match-store.ts";
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

Deno.test("the hosted catalog is valid and hosts the five Games", async () => {
  const { games, engines } = await verifyCatalog(hostedCatalog);
  assertEquals(games.map((g) => g.id), [
    "tic-tac-toe",
    "nine-mens-morris",
    "checkers",
    "chess",
    "backgammon",
  ]);
  for (const id of ["tic-tac-toe", "nine-mens-morris", "checkers", "chess"]) {
    assertEquals(engines.list(id).map((e) => e.id), ["minimax"]);
  }
  assertEquals(engines.list("backgammon").map((e) => e.id), [
    "expectiminimax",
  ]);
});

Deno.test("hosted backgammon: the Game master rolls, humans play", async () => {
  const { games } = await verifyCatalog(hostedCatalog);
  const master = new GameMaster({
    games: new GameRegistry(games),
    store: new InMemoryMatchStore(),
  });
  const human = { kind: "human" } as const;
  const { match, tokens } = await master.createMatch("backgammon", {
    white: human,
    black: human,
  });
  // The opening roll was resolved at creation.
  assertEquals(match.moves.length, 1);
  assertEquals(match.moves[0]!.kind, "chance");
  const seat = match.toMove!;
  const move = match.legalMoves[0]!;
  const next = await master.apply(match.id, { token: tokens[seat]! }, {
    kind: "move",
    move,
  });
  // The Move, then the Opponent's roll.
  assertEquals(next.moves.map((e) => e.kind), ["chance", "move", "chance"]);
  assertNotEquals(next.toMove, seat);
});

Deno.test("hosted backgammon: the Engine plays in its sandboxed worker", async () => {
  const { games, engines } = await verifyCatalog(hostedCatalog);
  const master = new GameMaster({
    games: new GameRegistry(games),
    store: new InMemoryMatchStore(),
    engines,
  });
  const driver = new EngineDriver(master, {
    runner: new EngineRunner({ adapter: testWorkerAdapter() }),
  });
  try {
    const { match, tokens } = await master.createMatch("backgammon", {
      white: { kind: "human" },
      black: {
        kind: "engine",
        engineId: "expectiminimax",
        limits: { maxDepth: 1 },
      },
    });
    await driver.idle();
    let view = await master.getMatch(match.id);
    const moves = () => view.moves.filter((e) => e.kind === "move").length;
    // Seats alternate, so after four Moves the Engine has played two.
    while (moves() < 4) {
      // The Engine has replied (or white won the opening roll).
      assertEquals(view.toMove, "white");
      await master.apply(view.id, { token: tokens.white! }, {
        kind: "move",
        move: view.legalMoves[0]!,
      });
      await driver.idle();
      view = await master.getMatch(view.id);
    }
    assertEquals(view.outcome, null);
  } finally {
    await driver.close();
  }
});

Deno.test("verifyCatalog adds extra (external) Engines of hosted Games only", async () => {
  const external = (gameId: string) => ({
    id: "x",
    name: "X",
    gameId,
    external: { command: "/unused" },
  });
  const { engines } = await verifyCatalog([{ game: ttt, engines: [] }], [
    external("tic-tac-toe"),
  ]);
  assertEquals(engines.get("tic-tac-toe", "x")?.external, {
    command: "/unused",
  });
  await assertRejects(
    () => verifyCatalog([{ game: ttt, engines: [] }], [external("go")]),
    Error,
    'Engine "x": no such Game "go"',
  );
});
