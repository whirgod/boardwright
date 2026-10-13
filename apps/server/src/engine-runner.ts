/**
 * The Engine runner: the one place the server runs Engine searches. It
 * streams an Engine's Analysis of a Position (in Notation) and owns
 * everything around a search that callers should not repeat: the default
 * time limit, the hard deadline, aborts, the concurrency cap and turning
 * every failure into a {@link SearchError} with a public code.
 *
 * How an Engine actually runs is an {@link EngineAdapter} behind it: a fresh
 * Web Worker per search ({@link workerAdapter}, the default) or the server's
 * own thread ({@link inProcessAdapter}, tests only). Sandboxing workers (#29)
 * and out-of-process Engines (#18) change this module, not its callers.
 */
import type { Analysis, SearchLimits } from "@boardwright/core";
import type { EngineEntry } from "./engines.ts";
import { analyzeInNotation, type HostRequest } from "./engine-host.ts";

/** Search time used when a request's `limits.maxTimeMs` is unset. */
export const DEFAULT_SEARCH_TIME_MS = 5000;

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

/** One search: an Engine, a Position in its Game's Notation, and limits. */
export interface AnalysisRequest {
  readonly engine: EngineEntry;
  readonly position: string;
  readonly limits: SearchLimits;
}

/**
 * How an Engine runs (the runner's seam). `analyze` starts one search and
 * yields each Analysis (Moves in Notation) as the Engine produces it, ending
 * when the Engine finishes. `request.limits.maxTimeMs` is always set.
 * Failures are thrown, preferably as a {@link SearchError}; anything else
 * counts as `engine-error`. When `signal` aborts the adapter must release
 * what it holds (e.g. terminate its worker) at once; it need not settle a
 * pending `next()`, the runner does not wait for it.
 */
export interface EngineAdapter {
  analyze(
    request: AnalysisRequest,
    signal: AbortSignal,
  ): AsyncIterable<Analysis<string>>;
}

export interface EngineRunnerOptions {
  /** How Engines run. Default: {@link workerAdapter}. */
  readonly adapter?: EngineAdapter;
  /** Searches running at once; further ones wait their turn. Default 4. */
  readonly maxConcurrent?: number;
  /**
   * Extra time beyond `limits.maxTimeMs` before a search counts as hung
   * (covers worker start-up and the Engine's overshoot). Default 5000.
   */
  readonly graceMs?: number;
}

export interface AnalyzeOptions {
  /** Aborting stops the search (or its wait for a slot). */
  readonly signal?: AbortSignal;
}

/**
 * Runs Engine searches, at most `maxConcurrent` at once, each on an adapter.
 * Share one runner between everything that searches so the cap is global.
 */
export class EngineRunner {
  readonly #adapter: EngineAdapter;
  readonly #graceMs: number;
  readonly #slots: Slots;

  constructor(options: EngineRunnerOptions = {}) {
    this.#adapter = options.adapter ?? workerAdapter();
    this.#graceMs = options.graceMs ?? 5000;
    this.#slots = new Slots(options.maxConcurrent ?? 4);
  }

  /**
   * Streams the Engine's Analysis of the request's Position, in the order the
   * Engine yields it, each checked for shape (Moves are Notation strings, not
   * judged for legality). Nothing happens until iteration starts; then the
   * search waits for a free slot. An unset `limits.maxTimeMs` becomes
   * {@link DEFAULT_SEARCH_TIME_MS}, so no search is unbounded.
   *
   * The stream ends when the Engine finishes. It throws a `SearchError`:
   * `aborted` when `options.signal` aborts (also while waiting for a slot),
   * `timeout` when the search runs past `maxTimeMs` + grace (counted from
   * getting a slot, including time the consumer spends between Analyses),
   * or the adapter's failure (`engine-error`, `worker-error`,
   * `unreadable-reply`). Breaking out of the loop stops the search. In every
   * case the Engine is stopped and the slot freed, at the latest at the
   * deadline even if the consumer abandons the stream.
   *
   * Analyses without Lines are passed on (a terminal Position, or an expected
   * Score while a Chance event is pending); choosing a Move is the caller's
   * business.
   */
  async *analyze(
    request: AnalysisRequest,
    options: AnalyzeOptions = {},
  ): AsyncGenerator<Analysis<string>, void, undefined> {
    const { signal } = options;
    const limits = {
      ...request.limits,
      maxTimeMs: request.limits.maxTimeMs ?? DEFAULT_SEARCH_TIME_MS,
    };
    await this.#slots.acquire(signal);

    const stop = new AbortController();
    let failure: SearchError | undefined;
    const stopped = new Promise<never>((_, reject) =>
      stop.signal.addEventListener("abort", () => reject(failure))
    );
    stopped.catch(() => {}); // Observed through the race below.
    const fail = (error: SearchError) => {
      failure ??= error;
      cleanUp();
    };
    const onAbort = () => fail(new SearchError("aborted", "search aborted"));
    const deadlineMs = limits.maxTimeMs + this.#graceMs;
    const timer = setTimeout(
      () => fail(new SearchError("timeout", `no end within ${deadlineMs} ms`)),
      deadlineMs,
    );
    let cleaned = false;
    const cleanUp = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      stop.abort(); // The adapter stops the Engine.
      this.#slots.release();
    };
    signal?.addEventListener("abort", onAbort);
    if (signal?.aborted) onAbort();

    let iterator: AsyncIterator<Analysis<string>> | undefined;
    try {
      iterator = this.#adapter.analyze({ ...request, limits }, stop.signal)
        [Symbol.asyncIterator]();
      for (;;) {
        const step = await Promise.race([iterator.next(), stopped]);
        if (step.done) return;
        if (!isAnalysis(step.value)) {
          throw new SearchError("unreadable-reply", "malformed Analysis");
        }
        yield step.value;
        if (failure) throw failure;
      }
    } catch (error) {
      throw failure ?? asSearchError(error);
    } finally {
      cleanUp();
      // Let the adapter finish its own clean-up; nothing to wait for.
      try {
        iterator?.return?.().catch(() => {});
      } catch { /* the adapter already failed */ }
    }
  }
}

function asSearchError(error: unknown): SearchError {
  if (error instanceof SearchError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SearchError("engine-error", `Engine failed: ${message}`, {
    cause: error,
  });
}

/** Shape check for what an adapter yields (Moves in Notation; extra fields pass). */
function isAnalysis(value: unknown): value is Analysis<string> {
  if (typeof value !== "object" || value === null) return false;
  const { depth, lines } = value as { depth?: unknown; lines?: unknown };
  return typeof depth === "number" && Number.isInteger(depth) && depth >= 0 &&
    Array.isArray(lines) && lines.every(isLine);
}

function isLine(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { moves, score } = value as { moves?: unknown; score?: unknown };
  return Array.isArray(moves) && moves.every((m) => typeof m === "string") &&
    typeof score === "object" && score !== null;
}

/** A counting semaphore whose waiters can give up on abort. */
class Slots {
  #free: number;
  readonly #waiting: (() => void)[] = [];

  constructor(size: number) {
    this.#free = size;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new SearchError("aborted", "search aborted");
    if (this.#free > 0) {
      this.#free--;
      return;
    }
    // The slot is handed over by release() without freeing it.
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.#waiting.splice(this.#waiting.indexOf(granted), 1);
        reject(new SearchError("aborted", "search aborted"));
      };
      const granted = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.#waiting.push(granted);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#free++;
  }
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

const WORKER_URL = new URL("./engine-worker.ts", import.meta.url);

function hostRequest(request: AnalysisRequest): HostRequest {
  return {
    module: request.engine.module,
    position: request.position,
    limits: request.limits,
  };
}

/**
 * Runs each search in a fresh Web Worker, so a busy or hung Engine never
 * blocks the server, and terminates it when the search ends, fails or is
 * stopped. Worker errors are `worker-error`, the Engine's own `engine-error`,
 * messages outside the protocol `unreadable-reply`.
 */
export function workerAdapter(): EngineAdapter {
  return {
    async *analyze(request, signal) {
      if (signal.aborted) return;
      const worker = new Worker(WORKER_URL, { type: "module" });
      const inbox: (WorkerMessage | SearchError)[] = [];
      let wake: (() => void) | undefined;
      const deliver = (item: WorkerMessage | SearchError) => {
        inbox.push(item);
        wake?.();
      };
      worker.onmessage = (event: MessageEvent<WorkerMessage>) =>
        deliver(event.data);
      worker.onerror = (event) => {
        event.preventDefault();
        deliver(
          new SearchError("worker-error", `worker error: ${event.message}`),
        );
      };
      worker.onmessageerror = () =>
        deliver(new SearchError("unreadable-reply", "unreadable worker reply"));
      const onAbort = () => {
        worker.terminate();
        deliver(new SearchError("aborted", "search aborted"));
      };
      signal.addEventListener("abort", onAbort);
      try {
        worker.postMessage(hostRequest(request));
        for (;;) {
          while (inbox.length === 0) {
            await new Promise<void>((resolve) => wake = resolve);
          }
          const item = inbox.shift();
          if (item instanceof SearchError) throw item;
          switch (item?.kind) {
            case "analysis":
              yield item.analysis;
              break;
            case "done":
              return;
            case "error":
              throw new SearchError(
                "engine-error",
                `Engine failed: ${item.message}`,
              );
            default:
              throw new SearchError("unreadable-reply", "unknown worker reply");
          }
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        worker.terminate();
      }
    },
  };
}

/**
 * Runs the Engine module on the server's own thread, through the same
 * Notation code as the worker. No isolation: a busy Engine blocks the server
 * and a hung one cannot be cut off. For tests and debugging only.
 */
export function inProcessAdapter(): EngineAdapter {
  return {
    analyze: (request, signal) =>
      analyzeInNotation(hostRequest(request), signal),
  };
}
