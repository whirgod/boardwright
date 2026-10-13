import type { GameId } from "@boardwright/core";

/**
 * An Engine the server can seat in a Match. Engines are loaded by URL inside a
 * Web Worker (see `engine-worker.ts`), never imported into the server process.
 */
export interface EngineEntry {
  /** Unique among the Engines of one Game. */
  readonly id: string;
  readonly name: string;
  readonly gameId: GameId;
  /**
   * URL of a module exporting `rules` (the Game's `GameRules`) and `engine`
   * (an `Engine` for it), e.g. `import.meta.resolve("@boardwright/engine-x")`.
   */
  readonly module: string;
}

/** The Engines this server offers, per Game. */
export class EngineRegistry {
  readonly #entries = new Map<string, EngineEntry>();

  constructor(entries: readonly EngineEntry[] = []) {
    for (const entry of entries) {
      const key = keyOf(entry.gameId, entry.id);
      if (this.#entries.has(key)) {
        throw new Error(
          `Duplicate Engine ${JSON.stringify(entry.id)} for Game ${
            JSON.stringify(entry.gameId)
          }`,
        );
      }
      this.#entries.set(key, entry);
    }
  }

  get(gameId: GameId, engineId: string): EngineEntry | undefined {
    return this.#entries.get(keyOf(gameId, engineId));
  }

  list(gameId: GameId): readonly EngineEntry[] {
    return [...this.#entries.values()].filter((e) => e.gameId === gameId);
  }
}

function keyOf(gameId: GameId, engineId: string): string {
  return JSON.stringify([gameId, engineId]);
}
