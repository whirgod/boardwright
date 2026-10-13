/**
 * Validation of untrusted JSON request bodies. Hand-written type guards: the
 * bodies are tiny, and owning the checks keeps error messages in our error
 * shape without a schema library dependency.
 */
import type { GameId, SearchLimits, Seat } from "@boardwright/core";
import { parseLimits, parsePlayer, type Player } from "./players.ts";

export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

export interface CreateMatchBody {
  readonly gameId: GameId;
  readonly seats: Readonly<Record<Seat, Player>>;
}

export interface PlayMoveBody {
  readonly move: string;
  readonly token: string;
}

export interface ResignBody {
  readonly token: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unexpectedFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  return extra.length > 0
    ? `unexpected field(s): ${extra.join(", ")}`
    : undefined;
}

/** `{ gameId, seats: { <seat>: Player } }` */
export function parseCreateMatchBody(body: unknown): Parsed<CreateMatchBody> {
  if (!isObject(body)) {
    return { ok: false, problem: "body must be a JSON object" };
  }
  const extra = unexpectedFields(body, ["gameId", "seats"]);
  if (extra) return { ok: false, problem: extra };
  const { gameId, seats } = body;
  if (typeof gameId !== "string" || gameId === "") {
    return { ok: false, problem: "`gameId` must be a non-empty string" };
  }
  if (!isObject(seats)) {
    return {
      ok: false,
      problem: "`seats` must be an object of Seat to Player",
    };
  }
  const players: Record<Seat, Player> = {};
  for (const [seat, value] of Object.entries(seats)) {
    const parsed = parsePlayer(value);
    if (!parsed.ok) {
      return { ok: false, problem: `\`seats.${seat}\` ${parsed.problem}` };
    }
    players[seat] = parsed.player;
  }
  return { ok: true, value: { gameId, seats: players } };
}

/** `{ move, token }` */
export function parsePlayMoveBody(body: unknown): Parsed<PlayMoveBody> {
  if (!isObject(body)) {
    return { ok: false, problem: "body must be a JSON object" };
  }
  const extra = unexpectedFields(body, ["move", "token"]);
  if (extra) return { ok: false, problem: extra };
  const { move, token } = body;
  if (typeof move !== "string") {
    return {
      ok: false,
      problem: "`move` must be a string in the Game's Notation",
    };
  }
  if (typeof token !== "string") {
    return {
      ok: false,
      problem: "`token` must be the Seat's seat token (string)",
    };
  }
  return { ok: true, value: { move, token } };
}

/** `{ token }` */
export function parseResignBody(body: unknown): Parsed<ResignBody> {
  if (!isObject(body)) {
    return { ok: false, problem: "body must be a JSON object" };
  }
  const extra = unexpectedFields(body, ["token"]);
  if (extra) return { ok: false, problem: extra };
  const { token } = body;
  if (typeof token !== "string") {
    return {
      ok: false,
      problem: "`token` must be the Seat's seat token (string)",
    };
  }
  return { ok: true, value: { token } };
}

/** The `start` message of the Analysis stream. */
export interface AnalysisStartBody {
  readonly id?: string;
  readonly gameId: GameId;
  readonly engineId: string;
  readonly position: string;
  readonly limits: SearchLimits;
}

/** `{ type: "start", id?, gameId, engineId, position, limits? }` */
export function parseAnalysisStartBody(
  body: Record<string, unknown>,
): Parsed<AnalysisStartBody> {
  const extra = unexpectedFields(body, [
    "type",
    "id",
    "gameId",
    "engineId",
    "position",
    "limits",
  ]);
  if (extra) return { ok: false, problem: extra };
  const { id, gameId, engineId, position, limits } = body;
  if (id !== undefined && (typeof id !== "string" || id.length > 100)) {
    return { ok: false, problem: "`id` must be a string of at most 100 chars" };
  }
  if (typeof gameId !== "string" || gameId === "") {
    return { ok: false, problem: "`gameId` must be a non-empty string" };
  }
  if (typeof engineId !== "string" || engineId === "") {
    return { ok: false, problem: "`engineId` must be a non-empty string" };
  }
  if (typeof position !== "string") {
    return {
      ok: false,
      problem: "`position` must be a string in the Game's Notation",
    };
  }
  const parsed = parseLimits(limits ?? {});
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      ...(id !== undefined ? { id } : {}),
      gameId,
      engineId,
      position,
      limits: parsed.limits,
    },
  };
}

/** Parse a text message as a JSON object. */
export function parseJsonObject(
  text: string,
): Parsed<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problem: "message must be valid JSON" };
  }
  return isObject(value)
    ? { ok: true, value }
    : { ok: false, problem: "message must be a JSON object" };
}
