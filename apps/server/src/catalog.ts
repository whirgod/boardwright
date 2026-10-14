import type { GameId } from "@boardwright/core";
import { type EngineEntry, EngineRegistry } from "./engines.ts";
import type { AnyGameRules } from "./games.ts";

/** An Engine of a hosted Game: what `EngineRegistry` needs, minus the Game id. */
export interface CatalogEngine {
  readonly id: string;
  readonly name: string;
  /** Module URL exporting `rules` and `engine`, see `EngineEntry.module`. */
  readonly module: string;
}

/** A hosted Game with the Engines offered for it (possibly none). */
export interface CatalogGame {
  readonly game: AnyGameRules;
  readonly engines: readonly CatalogEngine[];
}

export interface VerifiedCatalog {
  readonly games: readonly AnyGameRules[];
  readonly engines: EngineRegistry;
}

/**
 * Verifies the catalog and builds the registries the server runs on: every
 * Engine module must load and export `rules` and `engine` (what the worker
 * expects), and both must name the Game id the catalog registers them under.
 * `extraEngines` (external Engines, checked by
 * `registerExternalEngines`) join the registry; their Games must be hosted.
 * Rejects with all problems listed, so a bad catalog stops startup.
 */
export async function verifyCatalog(
  catalog: readonly CatalogGame[],
  extraEngines: readonly EngineEntry[] = [],
): Promise<VerifiedCatalog> {
  const problems: string[] = [];
  const entries: EngineEntry[] = [];
  for (const { game, engines } of catalog) {
    for (const entry of engines) {
      const label = `Engine ${JSON.stringify(entry.id)} of Game ${
        JSON.stringify(game.id)
      }`;
      const problem = await checkEngineModule(entry.module, game.id);
      if (problem) problems.push(`${label}: ${problem}`);
      entries.push({ ...entry, gameId: game.id });
    }
  }
  const hosted = new Set(catalog.map((c) => c.game.id));
  for (const entry of extraEngines) {
    if (!hosted.has(entry.gameId)) {
      problems.push(
        `Engine ${JSON.stringify(entry.id)}: no such Game ${
          JSON.stringify(entry.gameId)
        }`,
      );
    }
    entries.push(entry);
  }
  if (problems.length > 0) {
    throw new Error(`Invalid catalog:\n- ${problems.join("\n- ")}`);
  }
  return {
    games: catalog.map((c) => c.game),
    engines: new EngineRegistry(entries),
  };
}

async function checkEngineModule(
  url: string,
  gameId: GameId,
): Promise<string | undefined> {
  let mod: Record<string, unknown>;
  try {
    mod = await import(url);
  } catch (error) {
    return `module ${url} failed to load (${
      error instanceof Error ? error.message.split("\n")[0] : String(error)
    })`;
  }
  const rules = mod["rules"] as
    | { id?: unknown; notation?: unknown }
    | undefined;
  const engine = mod["engine"] as
    | { gameId?: unknown; analyze?: unknown }
    | undefined;
  if (typeof rules !== "object" || rules === null || !rules.notation) {
    return "module does not export `rules` (GameRules)";
  }
  if (typeof engine !== "object" || engine === null) {
    return "module does not export `engine`";
  }
  if (typeof engine.analyze !== "function") {
    return "`engine` has no `analyze` function";
  }
  if (rules.id !== gameId) {
    return `exported rules are for Game ${JSON.stringify(rules.id)}`;
  }
  if (engine.gameId !== gameId) {
    return `exported engine is for Game ${JSON.stringify(engine.gameId)}`;
  }
  // Hook (ADR 0005): once `ChanceGameRules` exists, also check that the
  // Engine's library fits the Game's kind (minimax <-> no chance,
  // expectiminimax <-> `hasChance`).
  return undefined;
}
