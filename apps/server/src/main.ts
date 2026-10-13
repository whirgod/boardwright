import { buildApp } from "./app.ts";
import { verifyCatalog } from "./catalog.ts";
import { EngineDriver } from "./engine-driver.ts";
import { GameMaster } from "./game-master.ts";
import { GameRegistry } from "./games.ts";
import { hostedCatalog } from "./hosted-catalog.ts";
import { InMemoryMatchStore } from "./match-store.ts";

const port = Number(Deno.env.get("PORT") ?? 3000);
const hostname = Deno.env.get("HOST") ?? "127.0.0.1";

// Fails startup if a Game or Engine module of the catalog is unusable.
const catalog = await verifyCatalog(hostedCatalog);

const master = new GameMaster({
  games: new GameRegistry(catalog.games),
  store: new InMemoryMatchStore(),
  engines: catalog.engines,
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
