// Test Engine: yields one Analysis, then crashes its thread with an uncaught
// error (only meaningful inside a worker).
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import type { Engine } from "@boardwright/core";

export const rules = ticTacToe;
export const engine: Engine<unknown, unknown> = {
  name: "CrashWorker",
  gameId: ticTacToe.id,
  async *analyze() {
    await Promise.resolve();
    yield {
      depth: 1,
      lines: [{ moves: ["a1"], score: { kind: "value", value: 0 } }],
    };
    setTimeout(() => {
      throw new Error("worker down");
    });
    await new Promise(() => {});
  },
};
