// Test Engine: waits without blocking its thread and never yields, until
// aborted (a hung Engine that a single thread can still cut off).
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import type { Engine } from "@boardwright/core";

export const rules = ticTacToe;
export const engine: Engine<unknown, unknown> = {
  name: "Stall",
  gameId: ticTacToe.id,
  async *analyze(_position, _limits, signal) {
    await new Promise((resolve) => signal?.addEventListener("abort", resolve));
    yield* [];
  },
};
