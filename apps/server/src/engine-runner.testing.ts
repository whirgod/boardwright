/**
 * Test support for `engine-runner.ts`; never import from production code.
 */
import type { Engine, GameRules } from "@boardwright/core";
import { validateLimits } from "@boardwright/engine-search";
import { analyzeInNotation } from "./engine-host.ts";
import {
  type EngineAdapter,
  type EngineRunner,
  hostRequest,
  SearchError,
  workerAdapter,
} from "./engine-runner.ts";
import type { EngineEntry } from "./engines.ts";

/**
 * Runs the Engine module on the server's own thread, through the same
 * Notation code as the worker. No isolation: a CPU-bound Engine blocks the
 * thread, so the runner's deadline cannot cut it off (and the server would
 * freeze). Only for tests with cooperative Engines.
 */
export function inProcessAdapter(): EngineAdapter {
  return {
    analyze: (request, signal) =>
      analyzeInNotation(hostRequest(request), signal),
  };
}

/** The production worker adapter, additionally allowed to load `test-engines/`. */
export function testWorkerAdapter(): EngineAdapter {
  return workerAdapter({
    readDirs: [new URL("./test-engines/", import.meta.url)],
  });
}

/**
 * The runner's view of one Engine as a typed `Engine`, so the Engine contract
 * kit (`assertEngineContract`) can check any adapter end to end: Positions
 * are encoded and Moves decoded with the Game's Notation (each Line from its
 * own Position on), invalid limits throw a `RangeError` synchronously, and an
 * aborted search ends without an error (the runner reports it as `aborted`).
 */
export function runnerEngine<Position, Move>(
  runner: EngineRunner,
  entry: EngineEntry,
  rules: GameRules<Position, Move>,
): Engine<Position, Move> {
  const { notation } = rules;
  return {
    name: entry.name,
    gameId: entry.gameId,
    analyze(position, limits, signal) {
      validateLimits(limits);
      const analyses = runner.analyze(
        { engine: entry, position: notation.encodePosition(position), limits },
        signal ? { signal } : {},
      );
      return (async function* () {
        try {
          for await (const analysis of analyses) {
            yield {
              ...analysis,
              lines: analysis.lines.map((line) => {
                let p = position;
                return {
                  ...line,
                  moves: line.moves.map((text) => {
                    const move = notation.decodeMove(text, p);
                    p = rules.play(p, move);
                    return move;
                  }),
                };
              }),
            };
          }
        } catch (error) {
          if (error instanceof SearchError && error.code === "aborted") return;
          throw error;
        }
      })();
    },
  };
}
