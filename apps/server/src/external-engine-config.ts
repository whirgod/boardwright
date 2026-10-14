/**
 * Registering external Engines: the JSON config file the server reads at
 * startup (docs/external-engine-protocol.md, "Configuration") and the
 * checks that turn it into Engine entries.
 */
import { dirname, isAbsolute, resolve } from "node:path";
import type { GameId } from "@boardwright/core";
import type { ExternalAdapter } from "./external-engine.ts";
import type { ExternalEngineEntry } from "./engines.ts";

/** One configured external Engine, paths resolved. */
export interface ExternalEngineConfig {
  readonly gameId: GameId;
  readonly id: string;
  /** Shown to clients; default: the name the Engine announces. */
  readonly name?: string;
  /** Absolute path, or a bare name looked up on `PATH`. */
  readonly command: string;
  readonly args: readonly string[];
  /** Absolute working directory. */
  readonly cwd: string;
  /** Extra environment variables of the process (the rest are cleared). */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Checks a parsed config file (`{ "engines": [...] }`) and resolves its
 * paths: a `command` containing a `/` and `cwd` are relative to `baseDir`
 * (the config file's directory), which is also the default `cwd`. Throws an
 * `Error` listing every problem.
 */
export function parseExternalEngineConfig(
  json: unknown,
  baseDir: string,
): ExternalEngineConfig[] {
  const problems: string[] = [];
  const engines = isRecord(json) ? json.engines : undefined;
  if (!Array.isArray(engines)) {
    throw new Error(
      'Invalid external Engine config: expected { "engines": [...] }',
    );
  }
  const configs: ExternalEngineConfig[] = [];
  engines.forEach((value, i) => {
    const where = `engines[${i}]`;
    if (!isRecord(value)) return problems.push(`${where}: not an object`);
    const { gameId, id, name, command, args, cwd, env } = value;
    const before = problems.length;
    const text = (field: string, v: unknown, optional = false) => {
      if (optional && v === undefined) return;
      if (typeof v !== "string" || v.length === 0) {
        problems.push(`${where}.${field}: expected a non-empty string`);
      }
    };
    text("gameId", gameId);
    text("id", id);
    text("name", name, true);
    text("command", command);
    text("cwd", cwd, true);
    if (
      args !== undefined &&
      !(Array.isArray(args) && args.every((a) => typeof a === "string"))
    ) {
      problems.push(`${where}.args: expected an array of strings`);
    }
    if (
      env !== undefined &&
      !(isRecord(env) &&
        Object.values(env).every((v) => typeof v === "string"))
    ) {
      problems.push(`${where}.env: expected an object of strings`);
    }
    if (problems.length > before) return;
    const path = (p: string) => isAbsolute(p) ? p : resolve(baseDir, p);
    configs.push({
      gameId: gameId as string,
      id: id as string,
      ...(name !== undefined && { name: name as string }),
      command: (command as string).includes("/")
        ? path(command as string)
        : command as string,
      args: (args ?? []) as string[],
      cwd: cwd === undefined ? baseDir : path(cwd as string),
      ...(env !== undefined && { env: env as Record<string, string> }),
    });
  });
  if (problems.length > 0) {
    throw new Error(
      `Invalid external Engine config:\n- ${problems.join("\n- ")}`,
    );
  }
  return configs;
}

/**
 * Reads and parses the config file at `path` (see
 * {@link parseExternalEngineConfig}). A missing file means no external
 * Engines when `optional`, an error otherwise.
 */
export async function readExternalEngineConfig(
  path: string,
  options: { readonly optional?: boolean } = {},
): Promise<ExternalEngineConfig[]> {
  const file = resolve(path);
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch (error) {
    if (options.optional && error instanceof Deno.errors.NotFound) return [];
    throw new Error(`Cannot read external Engine config ${file}`, {
      cause: error,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`External Engine config ${file} is not JSON`, {
      cause: error,
    });
  }
  return parseExternalEngineConfig(json, dirname(file));
}

/**
 * Turns configured external Engines into Engine entries, checking each:
 * its Game is hosted, the server may run its command (`--allow-run`), and
 * it starts and completes the handshake for its Game (through `adapter`,
 * which keeps the process for the first search). Rejects with every
 * problem listed, so a bad config stops startup.
 */
export async function registerExternalEngines(
  configs: readonly ExternalEngineConfig[],
  adapter: ExternalAdapter,
  hostedGames: ReadonlySet<GameId>,
): Promise<ExternalEngineEntry[]> {
  const results = await Promise.all(configs.map(async (config) => {
    const label = `External Engine ${JSON.stringify(config.id)} of Game ${
      JSON.stringify(config.gameId)
    }`;
    if (!hostedGames.has(config.gameId)) return `${label}: no such Game`;
    const { state } = await Deno.permissions.query({
      name: "run",
      command: config.command,
    });
    if (state !== "granted") {
      return `${label}: not allowed to run ${config.command} ` +
        `(start the server with --allow-run=${config.command})`;
    }
    const entry: ExternalEngineEntry = {
      id: config.id,
      name: config.name ?? "",
      gameId: config.gameId,
      external: {
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        ...(config.env && { env: config.env }),
      },
    };
    try {
      const announced = await adapter.connect(entry);
      return { ...entry, name: config.name ?? announced };
    } catch (error) {
      return `${label}: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }));
  const problems = results.filter((r) => typeof r === "string");
  if (problems.length > 0) {
    throw new Error(`Invalid external Engines:\n- ${problems.join("\n- ")}`);
  }
  return results.filter((r) => typeof r !== "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
