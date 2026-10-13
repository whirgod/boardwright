import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import { buildApp } from "./app.ts";
import { EngineDriver } from "./engine-driver.ts";
import { EngineRegistry } from "./engines.ts";
import { GameMaster } from "./game-master.ts";
import { GameRegistry } from "./games.ts";
import { InMemoryMatchStore } from "./match-store.ts";

const port = Number(Deno.env.get("PORT") ?? 3000);
const hostname = Deno.env.get("HOST") ?? "127.0.0.1";

const master = new GameMaster({
  games: new GameRegistry([ticTacToe]),
  store: new InMemoryMatchStore(),
  engines: new EngineRegistry([{
    id: "minimax",
    name: "Minimax",
    gameId: ticTacToe.id,
    module: import.meta.resolve("@boardwright/engine-tic-tac-toe-minimax"),
  }]),
});
new EngineDriver(master);

// Built by `deno task build:web` (ADR 0004); `deno task start` builds it first.
const webRoot = `${import.meta.dirname}/../../web/dist`;
try {
  await Deno.stat(`${webRoot}/index.html`);
} catch {
  console.warn(
    "Web UI not built: run `deno task build:web`. Serving the API only.",
  );
}

Deno.serve({ port, hostname }, buildApp({ master, webRoot }).fetch);
