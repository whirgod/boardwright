// Test Engine: fails every search.
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import type { Engine } from "@boardwright/core";

export const rules = ticTacToe;
export const engine: Engine<unknown, unknown> = {
  name: "Crash",
  gameId: ticTacToe.id,
  analyze() {
    throw new Error("boom");
  },
};
