// Test Engine: never answers (busy loop), as a runaway search would.
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import type { Engine } from "@boardwright/core";

export const rules = ticTacToe;
export const engine: Engine<unknown, unknown> = {
  name: "Hang",
  gameId: ticTacToe.id,
  analyze() {
    for (;;);
  },
};
