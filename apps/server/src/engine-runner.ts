/**
 * The Engine runner: the one place the server runs Engine searches. It
 * streams an Engine's Analysis of a Position (in Notation) and owns
 * everything around a search that callers should not repeat: the default
 * time limit, the hard deadline, aborts, the concurrency cap and its queueing
 * policy, checking what Engines report, and turning every failure into a
 * {@link SearchError} with a public code.
 *
 * How an Engine actually runs is an {@link EngineAdapter} behind it: in
 * production a fresh Web Worker per search for module Engines
 * ({@link workerAdapter}) and a process speaking the external Engine
 * protocol for external ones (`externalAdapter` in `external-engine.ts`),
 * combined by {@link routingAdapter}.
 */
import type { Analysis, Score, SearchLimits } from "@boardwright/core";
import type { EngineEntry } from "./engines.ts";
import { fileURLToPath } from "node:url";
import type { HostRequest, WorkerMessage } from "./engine-host.ts";

/** Search time used when a request's `limits.maxTimeMs` is unset. */
export const DEFAULT_SEARCH_TIME_MS = 5000;

/** Longest delay `setTimeout` supports; longer deadlines are clamped to it. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Why a search failed, in words safe to show publicly (details are logged). */
export type SearchFailure =
  | "engine-error"
  | "worker-error"
  | "unreadable-reply"
  | "timeout"
  | "aborted"
  | "busy";

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
 *
 * Production adapters must isolate the Engine from the server's thread
 * (worker, process): the runner's deadline is a timer on that thread, so it
 * can only cut off an Engine that does not block it.
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
  /** Searches running at once, integer >= 1. Default 4. */
  readonly maxConcurrent?: number;
  /**
   * Slots only `match` searches may use, integer in [0, maxConcurrent).
   * Default 1 (0 when `maxConcurrent` is 1).
   */
  readonly reservedForMatches?: number;
  /**
   * `analysis` searches that may wait for a slot, integer >= 0; one more is
   * refused with `busy`. Default 8.
   */
  readonly maxQueued?: number;
  /**
   * Extra time beyond `limits.maxTimeMs` before a search counts as hung
   * (covers worker start-up and the Engine's overshoot), >= 0. Default 5000.
   */
  readonly graceMs?: number;
}

/**
 * Who a search is for, which decides how it queues:
 * - `match`: an Engine Seat must move. Never refused; waits ahead of every
 *   `analysis` search and may also use the reserved slots, so it never
 *   starves behind Analysis requests.
 * - `analysis`: a client wants Analysis. Uses unreserved slots only; refused
 *   with `busy` when `maxQueued` others already wait.
 */
export type SearchPurpose = "match" | "analysis";

export interface AnalyzeOptions {
  /** Aborting stops the search (or its wait for a slot). */
  readonly signal?: AbortSignal;
  /** Default `analysis`. */
  readonly purpose?: SearchPurpose;
}

/**
 * Runs Engine searches, at most `maxConcurrent` at once, each on an adapter.
 * The server has one runner, shared by everything that searches, so the cap
 * and queueing policy hold globally.
 */
export class EngineRunner {
  readonly #adapter: EngineAdapter;
  readonly #graceMs: number;
  readonly #slots: Slots;

  /** Throws a `RangeError` for invalid options. */
  constructor(options: EngineRunnerOptions = {}) {
    const maxConcurrent = options.maxConcurrent ?? 4;
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError(`maxConcurrent must be an integer >= 1`);
    }
    const reserved = options.reservedForMatches ?? (maxConcurrent > 1 ? 1 : 0);
    if (
      !Number.isInteger(reserved) || reserved < 0 || reserved >= maxConcurrent
    ) {
      throw new RangeError(
        `reservedForMatches must be an integer in [0, maxConcurrent)`,
      );
    }
    const maxQueued = options.maxQueued ?? 8;
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new RangeError(`maxQueued must be an integer >= 0`);
    }
    const graceMs = options.graceMs ?? 5000;
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      throw new RangeError(`graceMs must be a finite number >= 0`);
    }
    this.#adapter = options.adapter ?? workerAdapter();
    this.#graceMs = graceMs;
    this.#slots = new Slots(maxConcurrent, reserved, maxQueued);
  }

  /**
   * Streams the Engine's Analysis of the request's Position, in the order the
   * Engine yields it. Each Analysis is checked against the Engine contract's
   * shape (integer depth; at most `limits.lines` Lines, each with at least
   * one Move in Notation and a well-formed Score; an optional top-level
   * expected Score, ADR 0005); Moves are not judged for legality. Other
   * fields pass through. Analyses without Lines are passed on (a terminal
   * Position, or a pending Chance event); choosing a Move is the caller's
   * business.
   *
   * Nothing happens until iteration starts; then the search queues for a slot
   * by `options.purpose`. An unset `limits.maxTimeMs` becomes
   * {@link DEFAULT_SEARCH_TIME_MS}, so no search is unbounded; a negative or
   * non-numeric one throws a `RangeError`.
   *
   * The stream ends when the Engine finishes. It throws a `SearchError`:
   * `busy` when the `analysis` queue is full, `aborted` when
   * `options.signal` aborts (also while queued), `timeout` when the search
   * runs past `maxTimeMs` + grace (counted from getting a slot, including
   * time the consumer spends between Analyses), `unreadable-reply` for a
   * malformed Analysis, or the adapter's failure (`engine-error`,
   * `worker-error`). Breaking out of the loop stops the search. In every case
   * the adapter is told to stop the Engine and the slot is freed, at the
   * latest at the deadline even if the consumer abandons the stream.
   */
  async *analyze(
    request: AnalysisRequest,
    options: AnalyzeOptions = {},
  ): AsyncGenerator<Analysis<string>, void, undefined> {
    const { signal } = options;
    const maxTimeMs = request.limits.maxTimeMs ?? DEFAULT_SEARCH_TIME_MS;
    if (typeof maxTimeMs !== "number" || !(maxTimeMs >= 0)) {
      throw new RangeError(`maxTimeMs must be a number >= 0`);
    }
    const limits = { ...request.limits, maxTimeMs };
    const purpose = options.purpose ?? "analysis";
    await this.#slots.acquire(purpose, signal);

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
    const deadlineMs = Math.min(maxTimeMs + this.#graceMs, MAX_TIMER_MS);
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
      this.#slots.release(purpose);
    };
    signal?.addEventListener("abort", onAbort);
    if (signal?.aborted) onAbort();

    const maxLines = limits.lines ?? 1;
    let iterator: AsyncIterator<Analysis<string>> | undefined;
    try {
      iterator = this.#adapter.analyze({ ...request, limits }, stop.signal)
        [Symbol.asyncIterator]();
      for (;;) {
        const step = await Promise.race([iterator.next(), stopped]);
        if (step.done) return;
        if (!isAnalysis(step.value, maxLines)) {
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
function isAnalysis(
  value: unknown,
  maxLines: number,
): value is Analysis<string> {
  if (typeof value !== "object" || value === null) return false;
  const { depth, lines, score } = value as Record<string, unknown>;
  return Number.isInteger(depth) && (depth as number) >= 0 &&
    Array.isArray(lines) && lines.length <= maxLines && lines.every(isLine) &&
    (score === undefined || isScore(score));
}

function isLine(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { moves, score } = value as Record<string, unknown>;
  return Array.isArray(moves) && moves.length > 0 &&
    moves.every((move) => typeof move === "string") && isScore(score);
}

function isScore(value: unknown): value is Score {
  if (typeof value !== "object" || value === null) return false;
  const score = value as Record<string, unknown>;
  switch (score.kind) {
    case "value":
      return Number.isFinite(score.value);
    case "win-in":
    case "loss-in":
      return Number.isInteger(score.plies) && (score.plies as number) >= 0;
    default:
      return false;
  }
}

interface Waiter {
  readonly grant: () => void;
}

/**
 * The concurrency cap and its queueing policy (see {@link SearchPurpose}):
 * `match` waiters go first and may use every slot; `analysis` ones use at
 * most `size - reserved` slots and their queue holds `maxQueued`.
 */
class Slots {
  #running = 0;
  #runningAnalyses = 0;
  readonly #queues: Record<SearchPurpose, Waiter[]> = {
    match: [],
    analysis: [],
  };

  constructor(
    readonly size: number,
    readonly reserved: number,
    readonly maxQueued: number,
  ) {}

  async acquire(purpose: SearchPurpose, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new SearchError("aborted", "search aborted");
    const queue = this.#queues[purpose];
    if (queue.length === 0 && this.#canStart(purpose)) {
      this.#start(purpose);
      return;
    }
    if (purpose === "analysis" && queue.length >= this.maxQueued) {
      throw new SearchError("busy", "too many Analysis requests waiting");
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        queue.splice(queue.indexOf(waiter), 1);
        reject(new SearchError("aborted", "search aborted"));
      };
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      queue.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  release(purpose: SearchPurpose): void {
    this.#running--;
    if (purpose === "analysis") this.#runningAnalyses--;
    for (const next of ["match", "analysis"] as const) {
      const queue = this.#queues[next];
      while (queue.length > 0 && this.#canStart(next)) {
        this.#start(next);
        queue.shift()!.grant();
      }
    }
  }

  #canStart(purpose: SearchPurpose): boolean {
    if (this.#running >= this.size) return false;
    if (purpose === "match") return true;
    return this.#queues.match.length === 0 &&
      this.#runningAnalyses < this.size - this.reserved;
  }

  #start(purpose: SearchPurpose): void {
    this.#running++;
    if (purpose === "analysis") this.#runningAnalyses++;
  }
}

const WORKER_URL = new URL("./engine-worker.ts", import.meta.url);

/**
 * The only thing a worker may read: the source of the workspace packages an
 * Engine module imports (loading `import(module)` at run time needs it).
 * Everything else (net, env, write, run, ffi, sys, other files) is denied.
 */
const ENGINE_SOURCE_ROOTS = ["packages", "games", "engines"].map((dir) =>
  new URL(`../../../${dir}/`, import.meta.url)
);

export interface WorkerAdapterOptions {
  /** Further directories (URLs) whose files Engine modules may import, e.g. test Engines. */
  readonly readDirs?: readonly URL[];
}

/**
 * The plain-data request an adapter hands to the Engine's host. Throws an
 * `engine-error` for an external Engine (it has no module).
 */
export function hostRequest(request: AnalysisRequest): HostRequest {
  const { module } = request.engine;
  if (module === undefined) {
    throw new SearchError(
      "engine-error",
      `Engine ${JSON.stringify(request.engine.id)} is not a module Engine`,
    );
  }
  return { module, position: request.position, limits: request.limits };
}

/**
 * Sends each search to the adapter for its Engine's kind: module Engines to
 * `module` (e.g. {@link workerAdapter}), external Engines to `external`
 * (`externalAdapter` in `external-engine.ts`).
 */
export function routingAdapter(adapters: {
  readonly module: EngineAdapter;
  readonly external: EngineAdapter;
}): EngineAdapter {
  return {
    analyze: (request, signal) =>
      (request.engine.external === undefined
        ? adapters.module
        : adapters.external).analyze(request, signal),
  };
}

/**
 * Runs each search in a fresh Web Worker, so a busy or hung Engine never
 * blocks the server, and terminates it when the search ends, fails or is
 * stopped. The worker is sandboxed: read of the Engine
 * source roots only, nothing else (ADR 0006; needs `unstable:
 * ["worker-options"]`). Worker errors are `worker-error`, the Engine's own `engine-error`,
 * messages outside the protocol (`WorkerMessage`) `unreadable-reply`.
 */
export function workerAdapter(
  options: WorkerAdapterOptions = {},
): EngineAdapter {
  const readPaths = [...ENGINE_SOURCE_ROOTS, ...(options.readDirs ?? [])]
    .map((dir) => fileURLToPath(dir));
  return {
    async *analyze(request, signal) {
      if (signal.aborted) return;
      const message = hostRequest(request);
      const worker = new Worker(WORKER_URL, {
        type: "module",
        deno: { permissions: { read: readPaths } },
      });
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
        worker.postMessage(message);
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
