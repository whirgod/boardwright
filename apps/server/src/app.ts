import Fastify, { type FastifyInstance } from "fastify";
import type { GameRules } from "@boardwright/core";

export interface AppOptions {
  readonly games: readonly GameRules<unknown, unknown>[];
  readonly logger?: boolean;
}

export function buildApp({ games, logger = false }: AppOptions): FastifyInstance {
  const app = Fastify({ logger });

  app.get("/api/health", async () => ({ status: "ok" }));

  app.get("/api/games", async () =>
    games.map((game) => ({ id: game.id, name: game.name, seats: game.seats })),
  );

  return app;
}
