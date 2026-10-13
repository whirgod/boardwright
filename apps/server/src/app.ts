import { Hono } from "hono";
import type { GameRules } from "@boardwright/core";

export interface AppOptions {
  readonly games: readonly GameRules<unknown, unknown>[];
}

export function buildApp({ games }: AppOptions): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ status: "ok" }));

  app.get(
    "/api/games",
    (c) =>
      c.json(
        games.map((game) => ({
          id: game.id,
          name: game.name,
          seats: game.seats,
        })),
      ),
  );

  return app;
}
