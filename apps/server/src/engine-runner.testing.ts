/**
 * Test support for `engine-runner.ts`; never import from production code.
 */
import { analyzeInNotation } from "./engine-host.ts";
import { type EngineAdapter, hostRequest } from "./engine-runner.ts";

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
