import type { GameId } from "@boardwright/core";

/**
 * An Engine the server can seat in a Match: either a module run in a Web
 * Worker (see `engine-worker.ts`, never imported into the server process) or
 * an external Engine, a process speaking the external Engine protocol
 * (`external-engine.ts`, docs/external-engine-protocol.md).
 */
export type EngineEntry = ModuleEngineEntry | ExternalEngineEntry;

interface EngineEntryBase {
  /** Unique among the Engines of one Game. */
  readonly id: string;
  readonly name: string;
  readonly gameId: GameId;
}

export interface ModuleEngineEntry extends EngineEntryBase {
  /**
   * URL of a module exporting `rules` (the Game's `GameRules`) and `engine`
   * (an `Engine` for it), e.g. `import.meta.resolve("@boardwright/engine-x")`.
   */
  readonly module: string;
  readonly external?: never;
}

export interface ExternalEngineEntry extends EngineEntryBase {
  /** How to start the Engine's process. */
  readonly external: ExternalEngineCommand;
  readonly module?: never;
}

/** The process of an external Engine (no shell: `command` runs directly). */
export interface ExternalEngineCommand {
  /** Executable: an absolute path, or a name looked up on `PATH`. */
  readonly command: string;
  readonly args?: readonly string[];
  /** Working directory (absolute). Default: the server's. */
  readonly cwd?: string;
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
