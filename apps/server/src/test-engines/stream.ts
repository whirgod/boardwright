// Test Engine: yields depths 1..maxDepth (default 5), one every 30 ms, each
// Line being the first `depth` legal Moves in turn; stops on abort.
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import type { Engine } from "@boardwright/core";

export const rules = ticTacToe;
export const engine: Engine<unknown, unknown> = {
  name: "Stream",
  gameId: ticTacToe.id,
  async *analyze(position, limits, signal) {
    const start = position as Parameters<typeof ticTacToe.play>[0];
    for (let depth = 1; depth <= (limits.maxDepth ?? 5); depth++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (signal?.aborted) return;
      const moves = [];
      let at = start;
      for (let i = 0; i < depth && ticTacToe.toMove(at); i++) {
        const move = ticTacToe.legalMoves(at)[0]!;
        moves.push(move);
        at = ticTacToe.play(at, move);
      }
      yield {
        depth,
        lines: [{ moves, score: { kind: "value", value: depth } }],
      };
    }
  },
};
