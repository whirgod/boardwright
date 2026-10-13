// Test Engine: answers with a Move that is never legal.
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import type { Engine } from "@boardwright/core";

export const rules = ticTacToe;
export const engine: Engine<unknown, unknown> = {
  name: "Illegal",
  gameId: ticTacToe.id,
  async *analyze() {
    await Promise.resolve();
    yield {
      depth: 1,
      lines: [{ moves: ["z9"], score: { kind: "value", value: 0 } }],
    };
  },
};
