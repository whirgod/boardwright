/**
 * Runs one Engine module's `analyze` and streams its Analysis in Notation.
 * Shared by the Web Worker (`engine-worker.ts`) and the in-process adapter of
 * `engine-runner.ts`, so both speak exactly the same Notation.
 */
import type {
  Analysis,
  Engine,
  GameRules,
  SearchLimits,
} from "@boardwright/core";

/** One search as plain data: what crosses a worker (or process) boundary. */
export interface HostRequest {
  /** URL of a module exporting `rules` and `engine` (see `EngineEntry.module`). */
  readonly module: string;
  /** Position in the Game's Notation. */
  readonly position: string;
  readonly limits: SearchLimits;
}

interface EngineModule {
  readonly rules: GameRules<unknown, unknown>;
  readonly engine: Engine<unknown, unknown>;
}

/**
 * Loads the Engine module, decodes the Position and yields every Analysis
 * with its Moves encoded. Fields other than `lines` (`depth`, and any the
 * contract adds, such as the expected Score of a Position with a pending
 * Chance event) pass through unchanged.
 */
export async function* analyzeInNotation(
  request: HostRequest,
  signal?: AbortSignal,
): AsyncGenerator<Analysis<string>> {
  const { rules, engine } = await import(request.module) as EngineModule;
  const position = rules.notation.decodePosition(request.position);
  const analyses = engine.analyze(position, request.limits, signal);
  for await (const analysis of analyses) {
    yield {
      ...analysis,
      lines: analysis.lines.map((line) => ({
        ...line,
        moves: line.moves.map((move) => rules.notation.encodeMove(move)),
      })),
    };
  }
}
