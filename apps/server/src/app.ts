import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { GameMaster, MatchError, type MatchErrorCode } from "./game-master.ts";
import { type AnyGameRules, GameRegistry } from "./games.ts";
import { InMemoryMatchStore, type MatchStore } from "./match-store.ts";
import {
  parseCreateMatchBody,
  type Parsed,
  parsePlayMoveBody,
} from "./requests.ts";

export interface AppOptions {
  readonly games: readonly AnyGameRules[];
  /** Defaults to a fresh in-memory store. */
  readonly store?: MatchStore;
  /** Clock for Match timestamps; defaults to the system clock. */
  readonly now?: () => Date;
}

/** Every error response has this body. */
export interface ErrorBody {
  readonly error: { readonly code: ErrorCode; readonly message: string };
}

export type ErrorCode =
  | MatchErrorCode
  | "invalid-request"
  | "not-found"
  | "internal";

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  "invalid-request": 400,
  "invalid-seats": 400,
  "invalid-move": 400,
  "illegal-move": 400,
  "invalid-token": 403,
  "not-your-turn": 403,
  "unknown-game": 404,
  "unknown-match": 404,
  "not-found": 404,
  "match-finished": 409,
  "conflict": 409,
  "internal": 500,
};

function fail(c: Context, code: ErrorCode, message: string): Response {
  const body: ErrorBody = { error: { code, message } };
  return c.json(body, STATUS[code]);
}

/** Read a JSON body and validate it with `parse`. */
async function readBody<T>(
  c: Context,
  parse: (body: unknown) => Parsed<T>,
): Promise<Parsed<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, problem: "body must be valid JSON" };
  }
  return parse(body);
}

export function buildApp(options: AppOptions): Hono {
  const games = new GameRegistry(options.games);
  const master = new GameMaster({
    games,
    store: options.store ?? new InMemoryMatchStore(),
    ...(options.now ? { now: options.now } : {}),
  });
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ status: "ok" }));

  app.get(
    "/api/games",
    (c) =>
      c.json(
        games.list().map((game) => ({
          id: game.id,
          name: game.name,
          seats: game.seats,
        })),
      ),
  );

  app.post("/api/matches", async (c) => {
    const body = await readBody(c, parseCreateMatchBody);
    if (!body.ok) return fail(c, "invalid-request", body.problem);
    const created = await master.createMatch(
      body.value.gameId,
      body.value.seats,
    );
    c.header(
      "Location",
      `/api/matches/${encodeURIComponent(created.match.id)}`,
    );
    return c.json(created, 201);
  });

  app.get(
    "/api/matches/:id",
    async (c) => c.json(await master.getMatch(c.req.param("id"))),
  );

  app.post("/api/matches/:id/moves", async (c) => {
    const body = await readBody(c, parsePlayMoveBody);
    if (!body.ok) return fail(c, "invalid-request", body.problem);
    const { move, token } = body.value;
    return c.json(await master.playMove(c.req.param("id"), move, token));
  });

  app.notFound((c) =>
    fail(c, "not-found", `No route for ${c.req.method} ${c.req.path}`)
  );

  app.onError((error, c) => {
    if (error instanceof MatchError) return fail(c, error.code, error.message);
    console.error(error);
    return fail(c, "internal", "Internal server error");
  });

  return app;
}
