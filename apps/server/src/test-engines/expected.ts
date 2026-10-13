// Test Engine: an Analysis with no Lines and an expected Score, as an Engine
// for a Game with chance reports a pending Chance event (ADR 0005).
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import type { Analysis, Engine } from "@boardwright/core";

export const rules = ticTacToe;
export const engine: Engine<unknown, unknown> = {
  name: "Expected",
  gameId: ticTacToe.id,
  async *analyze() {
    await Promise.resolve();
    yield {
      depth: 2,
      lines: [],
      score: { kind: "value", value: 0.25 },
    } as Analysis<unknown>;
  },
};
