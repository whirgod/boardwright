import type { GameId, GameRules } from "@boardwright/core";

/** Any Game, with its Position and Move types erased (they are opaque to the server). */
export type AnyGameRules = GameRules<unknown, unknown>;

/** The Games this server can host, looked up by id. */
export class GameRegistry {
  readonly #games = new Map<GameId, AnyGameRules>();

  constructor(games: readonly AnyGameRules[]) {
    for (const game of games) {
      if (this.#games.has(game.id)) {
        throw new Error(`Duplicate Game id: ${JSON.stringify(game.id)}`);
      }
      this.#games.set(game.id, game);
    }
  }

  get(id: GameId): AnyGameRules | undefined {
    return this.#games.get(id);
  }

  list(): readonly AnyGameRules[] {
    return [...this.#games.values()];
  }
}
