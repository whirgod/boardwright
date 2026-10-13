import type { SearchLimits } from "@boardwright/core";

/**
 * Who occupies a Seat. Discriminated by `kind` so new kinds of Player extend
 * the union without reshaping the API: requests, stored records and
 * responses all carry this object as-is.
 */
export type Player = HumanPlayer | EnginePlayer;

/** A human Player; moves by presenting the Seat's seat token. */
export interface HumanPlayer {
  readonly kind: "human";
}

/** An Engine of the Match's Game; the server asks it for its Moves. */
export interface EnginePlayer {
  readonly kind: "engine";
  readonly engineId: string;
  /** Applied to every search of this Seat; Unset `maxTimeMs` becomes the server default (`DEFAULT_SEARCH_TIME_MS`). */
  readonly limits: SearchLimits;
}

export type PlayerKind = Player["kind"];

/** Longest `maxTimeMs` a client may ask for. */
export const MAX_SEARCH_TIME_MS = 60_000;
// Sanity caps on the other limits.
const MAX_DEPTH = 1000;
const MAX_LINES = 100;

/** Whether Moves for this Player arrive over the API with a seat token. */
export function usesSeatToken(player: Player): boolean {
  return player.kind === "human";
}

type ParsedPlayer =
  | { ok: true; player: Player }
  | { ok: false; problem: string };

/**
 * Validate an untrusted JSON value as a Player. Returns the parsed Player, or
 * a human-readable problem description.
 */
export function parsePlayer(value: unknown): ParsedPlayer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, problem: "must be an object with a `kind`" };
  }
  const { kind, ...rest } = value as Record<string, unknown>;
  switch (kind) {
    case "human":
      if (Object.keys(rest).length > 0) {
        return {
          ok: false,
          problem: `unexpected field(s) for kind "human": ${
            Object.keys(rest).join(", ")
          }`,
        };
      }
      return { ok: true, player: { kind: "human" } };
    case "engine":
      return parseEngine(rest);
    default:
      return {
        ok: false,
        problem: `unknown Player kind ${
          JSON.stringify(kind)
        } (expected "human" or "engine")`,
      };
  }
}

function parseEngine(fields: Record<string, unknown>): ParsedPlayer {
  const extra = Object.keys(fields).filter((k) =>
    k !== "engineId" && k !== "limits"
  );
  if (extra.length > 0) {
    return {
      ok: false,
      problem: `unexpected field(s) for kind "engine": ${extra.join(", ")}`,
    };
  }
  const { engineId, limits } = fields;
  if (typeof engineId !== "string" || engineId === "") {
    return { ok: false, problem: "`engineId` must be a non-empty string" };
  }
  const parsed = parseLimits(limits ?? {});
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    player: { kind: "engine", engineId, limits: parsed.limits },
  };
}

function parseLimits(
  value: unknown,
): { ok: true; limits: SearchLimits } | { ok: false; problem: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, problem: "`limits` must be an object" };
  }
  const { maxDepth, maxTimeMs, lines, ...rest } = value as Record<
    string,
    unknown
  >;
  if (Object.keys(rest).length > 0) {
    return {
      ok: false,
      problem: `unexpected field(s) in \`limits\`: ${
        Object.keys(rest).join(", ")
      }`,
    };
  }
  if (maxDepth !== undefined && !isIntegerIn(maxDepth, 1, MAX_DEPTH)) {
    return {
      ok: false,
      problem: `\`limits.maxDepth\` must be an integer from 1 to ${MAX_DEPTH}`,
    };
  }
  if (
    maxTimeMs !== undefined &&
    !(typeof maxTimeMs === "number" && maxTimeMs >= 0 &&
      maxTimeMs <= MAX_SEARCH_TIME_MS)
  ) {
    return {
      ok: false,
      problem:
        `\`limits.maxTimeMs\` must be a number from 0 to ${MAX_SEARCH_TIME_MS}`,
    };
  }
  if (lines !== undefined && !isIntegerIn(lines, 1, MAX_LINES)) {
    return {
      ok: false,
      problem: `\`limits.lines\` must be an integer from 1 to ${MAX_LINES}`,
    };
  }
  return {
    ok: true,
    limits: {
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      ...(maxTimeMs !== undefined ? { maxTimeMs } : {}),
      ...(lines !== undefined ? { lines } : {}),
    } as SearchLimits,
  };
}

function isIntegerIn(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= min && value <= max;
}
