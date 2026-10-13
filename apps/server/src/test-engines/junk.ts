// Test Engine: posts a message outside the worker protocol, then stalls
// (only meaningful inside a worker).
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import type { Engine } from "@boardwright/core";

export const rules = ticTacToe;
export const engine: Engine<unknown, unknown> = {
  name: "Junk",
  gameId: ticTacToe.id,
  async *analyze() {
    globalThis.postMessage({ kind: "bogus" });
    await new Promise(() => {});
    yield* [];
  },
};
