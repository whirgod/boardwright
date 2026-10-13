import type { SearchLimits } from "@boardwright/core";

/** Message to the worker: one search. Notation strings and plain data only. */
export interface SearchRequest {
  /** URL of the Engine module (see `EngineEntry.module`). */
  readonly module: string;
  /** Position in the Game's Notation. */
  readonly position: string;
  readonly limits: SearchLimits;
}

/** Message from the worker: the Engine's best Move in Notation, or why not. */
export type SearchReply =
  | { readonly ok: true; readonly move: string }
  | { readonly ok: false; readonly message: string };

/** Why a search failed, in words safe to show publicly (details are logged). */
export type SearchFailure =
  | "engine-error"
  | "worker-error"
  | "unreadable-reply"
  | "timeout"
  | "aborted";

export class SearchError extends Error {
  override readonly name = "SearchError";
  constructor(
    readonly code: SearchFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface SearchOptions {
  /** Hard deadline for the whole search, including worker start-up. */
  readonly timeoutMs: number;
  /** Aborting terminates the worker and rejects. */
  readonly signal?: AbortSignal;
}

const WORKER_URL = new URL("./engine-worker.ts", import.meta.url);

/**
 * Ask an Engine for its best Move in a fresh Web Worker.
 * The worker is always terminated afterwards, so a hung or crashed Engine
 * cannot outlive the call. Rejects with `SearchError` on a worker error, a
 * reply reporting failure, the timeout or an abort.
 */
export function searchInWorker(
  request: SearchRequest,
  options: SearchOptions,
): Promise<string> {
  const { signal } = options;
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SearchError("aborted", "search aborted"));
      return;
    }
    const worker = new Worker(WORKER_URL, { type: "module" });
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      settle();
    };
    const fail = (code: SearchFailure, message: string) =>
      finish(() => reject(new SearchError(code, message)));
    const onAbort = () => fail("aborted", "search aborted");
    const timer = setTimeout(
      () => fail("timeout", `no reply within ${options.timeoutMs} ms`),
      options.timeoutMs,
    );
    signal?.addEventListener("abort", onAbort);

    worker.onmessage = (event: MessageEvent<SearchReply>) => {
      const reply = event.data;
      if (reply.ok) finish(() => resolve(reply.move));
      else fail("engine-error", `Engine failed: ${reply.message}`);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail("worker-error", `worker error: ${event.message}`);
    };
    worker.onmessageerror = () =>
      fail("unreadable-reply", "unreadable worker reply");
    worker.postMessage(request);
  });
}
