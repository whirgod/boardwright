/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />
/**
 * Worker entry of the runner's worker adapter (`engine-runner.ts` documents
 * the protocol): runs the one search it is sent and posts each Analysis as
 * soon as the Engine yields it, then `done` (or `error`). The runner
 * terminates the worker to stop it. Only Notation strings and plain data
 * cross the boundary.
 *
 * The worker inherits the server's permissions (net, env, scoped read):
 * Engine code is trusted, sandboxing is a known gap (see #29).
 */
import {
  analyzeInNotation,
  type HostRequest,
  type WorkerMessage,
} from "./engine-host.ts";

self.onmessage = async (event: MessageEvent<HostRequest>) => {
  const post = (message: WorkerMessage) => self.postMessage(message);
  try {
    for await (const analysis of analyzeInNotation(event.data)) {
      post({ kind: "analysis", analysis });
    }
    post({ kind: "done" });
  } catch (error) {
    post({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
