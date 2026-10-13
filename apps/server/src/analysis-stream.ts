/**
 * The Analysis stream: one client's live Engine analysis over a WebSocket
 * (schema in `docs/ARCHITECTURE.md`). Searches run on the server's one
 * {@link EngineRunner} with purpose `analysis`, so the server-wide cap and
 * `busy` policy apply. Transport-agnostic, like `match-stream.ts`.
 */
import type { Analysis } from "@boardwright/core";
import type { EngineRegistry } from "./engines.ts";
import type { GameRegistry } from "./games.ts";
import {
  type AnalysisRequest,
  type EngineRunner,
  SearchError,
  type SearchFailure,
} from "./engine-runner.ts";
import { parseAnalysisStartBody, parseJsonObject } from "./requests.ts";

export type AnalysisErrorCode =
  | "invalid-request"
  | "unknown-game"
  | "unknown-engine"
  | "invalid-position"
  | Exclude<SearchFailure, "aborted">
  | "internal";

/** Server-to-client messages of the Analysis stream; `id` echoes the `start`'s. */
export type AnalysisStreamMessage =
  | {
    readonly type: "analysis";
    readonly id?: string;
    readonly analysis: Analysis<string>;
  }
  | { readonly type: "done"; readonly id?: string }
  | { readonly type: "stopped"; readonly id?: string }
  | {
    readonly type: "error";
    readonly id?: string;
    readonly error: {
      readonly code: AnalysisErrorCode;
      readonly message: string;
    };
  };

export interface AnalysisSessionOptions {
  readonly games: GameRegistry;
  readonly engines: EngineRegistry;
  readonly runner: EngineRunner;
  readonly send: (message: AnalysisStreamMessage) => void;
}

/** Longest client message accepted, in characters. */
export const MAX_MESSAGE_CHARS = 16 * 1024;

interface Search {
  readonly id: string | undefined;
  readonly abort: AbortController;
}

/**
 * One connection's state: at most one search at a time. A new `start`
 * replaces the running search; `stop` and {@link close} cancel it (the
 * runner then stops the Engine and frees its slot).
 */
export class AnalysisSession {
  readonly #options: AnalysisSessionOptions;
  #current: Search | undefined;
  #closed = false;

  constructor(options: AnalysisSessionOptions) {
    this.#options = options;
  }

  /** Handle one client message; never throws. */
  handle(data: unknown): void {
    if (this.#closed) return;
    if (typeof data !== "string") {
      return this.#error(undefined, "invalid-request", "send text messages");
    }
    if (data.length > MAX_MESSAGE_CHARS) {
      return this.#error(
        undefined,
        "invalid-request",
        `message exceeds ${MAX_MESSAGE_CHARS} characters`,
      );
    }
    const parsed = parseJsonObject(data);
    if (!parsed.ok) {
      return this.#error(undefined, "invalid-request", parsed.problem);
    }
    const { type } = parsed.value;
    if (type === "start") return this.#start(parsed.value);
    if (type === "stop") return this.#stop();
    this.#error(
      undefined,
      "invalid-request",
      '`type` must be "start" or "stop"',
    );
  }

  /** The client went away: cancel the running search; later messages are ignored. */
  close(): void {
    this.#closed = true;
    this.#cancel();
  }

  #cancel(): string | undefined {
    const current = this.#current;
    this.#current = undefined;
    current?.abort.abort();
    return current?.id;
  }

  #stop(): void {
    const id = this.#cancel();
    this.#options.send({
      type: "stopped",
      ...(id !== undefined ? { id } : {}),
    });
  }

  #start(body: Record<string, unknown>): void {
    // Any `start` replaces the running search, even one that is rejected.
    this.#cancel();
    const parsed = parseAnalysisStartBody(body);
    const id = typeof body.id === "string" ? body.id : undefined;
    if (!parsed.ok) return this.#error(id, "invalid-request", parsed.problem);
    const request = parsed.value;
    const game = this.#options.games.get(request.gameId);
    if (!game) {
      return this.#error(
        id,
        "unknown-game",
        `Unknown Game ${quoted(request.gameId)}`,
      );
    }
    const engine = this.#options.engines.get(request.gameId, request.engineId);
    if (!engine) {
      return this.#error(
        id,
        "unknown-engine",
        `Game ${quoted(request.gameId)} has no Engine ${
          quoted(request.engineId)
        }`,
      );
    }
    try {
      game.notation.decodePosition(request.position);
    } catch {
      return this.#error(
        id,
        "invalid-position",
        "`position` is not valid Notation for this Game",
      );
    }
    const search: Search = { id, abort: new AbortController() };
    this.#current = search;
    void this.#run(search, {
      engine,
      position: request.position,
      limits: request.limits,
    });
  }

  async #run(search: Search, request: AnalysisRequest): Promise<void> {
    const { id } = search;
    const tagged = id !== undefined ? { id } : {};
    try {
      const analyses = this.#options.runner.analyze(request, {
        signal: search.abort.signal,
        purpose: "analysis",
      });
      for await (const analysis of analyses) {
        if (this.#current !== search) return;
        this.#options.send({ type: "analysis", ...tagged, analysis });
      }
      if (this.#current !== search) return;
      this.#current = undefined;
      this.#options.send({ type: "done", ...tagged });
    } catch (error) {
      if (this.#current !== search) return; // cancelled or replaced: no reply
      this.#current = undefined;
      if (error instanceof SearchError && error.code !== "aborted") {
        // Engine text in the error is never forwarded: log it, send a fixed one.
        if (error.code !== "busy") console.error(error);
        this.#error(id, error.code, PUBLIC_MESSAGES[error.code]);
      } else {
        console.error(error);
        this.#error(id, "internal", "Internal server error");
      }
    }
  }

  #error(
    id: string | undefined,
    code: AnalysisErrorCode,
    message: string,
  ): void {
    this.#options.send({
      type: "error",
      ...(id !== undefined ? { id } : {}),
      error: { code, message },
    });
  }
}

const PUBLIC_MESSAGES: Record<
  Exclude<SearchFailure, "aborted">,
  string
> = {
  "busy": "Too many Analysis requests are waiting; try again later",
  "timeout": "The Engine took too long",
  "engine-error": "The Engine failed",
  "worker-error": "The Engine's Worker failed",
  "unreadable-reply": "The Engine sent an unreadable reply",
};

function quoted(text: string): string {
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}...` : text);
}
