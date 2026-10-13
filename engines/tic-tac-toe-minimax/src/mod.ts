/**
 * Tic-tac-toe Engine: the generic alpha-beta library with a neutral
 * evaluation. The game is small enough to be searched to the end, so the
 * evaluation is only reached under a `maxDepth` limit, where every unfinished
 * Position counts as level.
 *
 * The module exports `rules` and `engine` so a host can load it by URL and
 * search in a Worker (the server's engine worker expects exactly these names).
 */
import type { Engine } from "@boardwright/core";
import { createMinimaxEngine } from "@boardwright/engine-minimax";
import {
  ticTacToe,
  type TicTacToeMove,
  type TicTacToePosition,
} from "@boardwright/game-tic-tac-toe";

export const rules = ticTacToe;

export const engine: Engine<TicTacToePosition, TicTacToeMove> =
  createMinimaxEngine<TicTacToePosition, TicTacToeMove>({
    rules,
    evaluate: () => 0,
    name: "Minimax",
  });
