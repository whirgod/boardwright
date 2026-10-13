// Test Engine: finishes without proposing any Move.
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import type { Engine } from "@boardwright/core";

export const rules = ticTacToe;
export const engine: Engine<unknown, unknown> = {
  name: "Empty",
  gameId: ticTacToe.id,
  async *analyze() {
    await Promise.resolve();
    yield { depth: 0, lines: [] };
  },
};
