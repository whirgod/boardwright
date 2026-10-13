// Test Engine: busy for a while (blocks its own thread, not the server's),
// then plays the first legal Move.
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import type { Engine } from "@boardwright/core";

export const rules = ticTacToe;
export const engine: Engine<unknown, unknown> = {
  name: "Slow",
  gameId: ticTacToe.id,
  async *analyze(position) {
    const until = performance.now() + 600;
    while (performance.now() < until);
    await Promise.resolve();
    const move = ticTacToe.legalMoves(position as never)[0]!;
    yield {
      depth: 1,
      lines: [{ moves: [move], score: { kind: "value", value: 0 } }],
    };
  },
};
