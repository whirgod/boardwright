import { backgammon } from "@boardwright/game-backgammon";
import { checkers } from "@boardwright/game-checkers";
import { chess } from "@boardwright/game-chess";
import { nineMensMorris } from "@boardwright/game-nine-mens-morris";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import type { CatalogGame } from "./catalog.ts";
import type { AnyGameRules } from "./games.ts";

const erase = (game: unknown) => game as AnyGameRules;

/** Every Game this server hosts, with its Engines. Register new ones here. */
export const hostedCatalog: readonly CatalogGame[] = [
  {
    game: erase(ticTacToe),
    engines: [{
      id: "minimax",
      name: "Minimax",
      module: import.meta.resolve("@boardwright/engine-tic-tac-toe-minimax"),
    }],
  },
  {
    game: erase(nineMensMorris),
    engines: [{
      id: "minimax",
      name: "Minimax",
      module: import.meta.resolve(
        "@boardwright/engine-nine-mens-morris-minimax",
      ),
    }],
  },
  {
    game: erase(checkers),
    engines: [{
      id: "minimax",
      name: "Minimax",
      module: import.meta.resolve("@boardwright/engine-checkers-minimax"),
    }],
  },
  {
    game: erase(chess),
    engines: [{
      id: "minimax",
      name: "Minimax",
      module: import.meta.resolve("@boardwright/engine-chess-minimax"),
    }],
  },
  // No Engine yet (an expectiminimax Engine follows, #17): human Players only.
  { game: erase(backgammon), engines: [] },
];
