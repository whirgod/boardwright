import { buildApp } from "./app.ts";
import { verifyCatalog } from "./catalog.ts";
import { EngineDriver } from "./engine-driver.ts";
import {
  EngineRunner,
  routingAdapter,
  workerAdapter,
} from "./engine-runner.ts";
import { externalAdapter, shutdownHandler } from "./external-engine.ts";
import {
  readExternalEngineConfig,
  registerExternalEngines,
} from "./external-engine-config.ts";
import { GameMaster } from "./game-master.ts";
import { GameRegistry } from "./games.ts";
import { hostedCatalog } from "./hosted-catalog.ts";
import { InMemoryMatchStore } from "./match-store.ts";
import { openMatchStore } from "./sqlite-match-store.ts";

const port = Number(Deno.env.get("PORT") ?? 3000);
const hostname = Deno.env.get("HOST") ?? "127.0.0.1";

// Matches persist in `<data dir>/matches.db` (ADR 0007); the task grants
// read/write on `data/` of the repo only, so another dir needs its own grant.
// `BOARDWRIGHT_DATA_DIR=:memory:` keeps Matches in memory (lost on exit).
const dataDir = Deno.env.get("BOARDWRIGHT_DATA_DIR") ??
  `${import.meta.dirname}/../../../data`;
const store = dataDir === ":memory:"
  ? new InMemoryMatchStore()
  : openMatchStore(dataDir);

// External Engines (ADR 0008) from a JSON config: `BOARDWRIGHT_EXTERNAL_ENGINES`,
// default `external-engines.json` in the repo (optional; the tasks grant read
// of it). Each command also needs `--allow-run=<command>`. Startup fails if
// one cannot run or fails its handshake.
const externalConfig = Deno.env.get("BOARDWRIGHT_EXTERNAL_ENGINES");
const external = externalAdapter({
  games: new GameRegistry(hostedCatalog.map((c) => c.game)),
});
// Stop external Engines with the server, so none is left running as an orphan.
const shutdown = shutdownHandler(() => external.close());
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  try {
    Deno.addSignalListener(signal, shutdown);
  } catch {
    // Not supported on this platform (SIGTERM on Windows).
  }
}
const externalEngines = await registerExternalEngines(
  await readExternalEngineConfig(
    externalConfig ?? `${import.meta.dirname}/../../../external-engines.json`,
    { optional: externalConfig === undefined },
  ),
  external,
  new Set(hostedCatalog.map((c) => c.game.id)),
);

// Fails startup if a Game or Engine module of the catalog is unusable.
const catalog = await verifyCatalog(hostedCatalog, externalEngines);

const master = new GameMaster({
  games: new GameRegistry(catalog.games),
  store,
  engines: catalog.engines,
});
// The one runner every search goes through (Matches and the Analysis stream),
// so its concurrency cap and queueing policy hold server-wide.
const runner = new EngineRunner({
  adapter: routingAdapter({ module: workerAdapter(), external }),
});
const driver = new EngineDriver(master, { runner });
// Engine turns left waiting by the last run (no event will announce them).
await driver.resumeAll();

// Built by `deno task build:web` (ADR 0004); `deno task start` builds it first.
const webRoot = `${import.meta.dirname}/../../web/dist`;
try {
  await Deno.stat(`${webRoot}/index.html`);
} catch {
  console.warn(
    "Web UI not built: run `deno task build:web`. Serving the API only.",
  );
}

Deno.serve({ port, hostname }, buildApp({ master, webRoot, runner }).fetch);
