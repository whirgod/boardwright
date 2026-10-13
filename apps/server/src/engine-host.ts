/**
 * Runs one Engine module's `analyze` and streams its Analysis in Notation.
 * Shared by the Web Worker (`engine-worker.ts`) and the test-only in-process
 * adapter (`engine-runner.testing.ts`), so both speak exactly the same
 * Notation. Also defines the worker protocol.
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

/**
 * Message from the worker (`engine-worker.ts`), which receives one
 * {@link HostRequest} and answers with any number of `analysis` messages,
 * then `done` or `error` (the Engine's message, logged only).
 */
export type WorkerMessage =
  | { readonly kind: "analysis"; readonly analysis: Analysis<string> }
  | { readonly kind: "done" }
  | { readonly kind: "error"; readonly message: string };

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
