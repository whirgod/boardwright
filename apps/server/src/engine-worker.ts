/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />
/**
 * Worker entry of the runner's worker adapter (`engine-runner.ts` documents
 * the protocol): runs the one search it is sent and posts each Analysis as
 * soon as the Engine yields it, then `done` (or `error`). The runner
 * terminates the worker to stop it. Only Notation strings and plain data
 * cross the boundary.
 *
 * The runner starts this worker with a minimal permission set (ADR 0006): read
 * of the Engine source roots only, so the Engine code it imports cannot use
 * net, env, other files or subprocesses.
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
