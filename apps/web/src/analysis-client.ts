// Client of the Analysis stream (`/api/analysis/stream`, docs/ARCHITECTURE.md).
// DOM-free: the socket comes through `Connect`. One search at a time: asking
// for another Position replaces the running search (the server cancels it),
// and replies about any earlier search are dropped by their `id`.
import type { Analysis, GameId } from "@boardwright/core";
import type { Connect, StreamSocket } from "./socket.ts";

export const ANALYSIS_STREAM_PATH = "/api/analysis/stream";

/** What to analyse, as the `start` message sends it. */
export interface AnalysisRequest {
  readonly gameId: GameId;
  readonly engineId: string;
  /** The Position in the Game's Notation. */
  readonly position: string;
  /** How many best Lines. */
  readonly lines: number;
  readonly maxTimeMs: number;
}

export type AnalysisState =
  | { readonly kind: "idle" }
  /** Searching; `analysis` is the deepest so far, absent until the first one. */
  | {
    readonly kind: "running" | "done";
    readonly request: AnalysisRequest;
    readonly analysis?: Analysis<string>;
  }
  | {
    readonly kind: "error";
    readonly request: AnalysisRequest;
    readonly message: string;
    readonly analysis?: Analysis<string>;
  };

export interface AnalysisClientOptions {
  readonly connect: Connect;
  readonly onState: (state: AnalysisState) => void;
  /**
   * Waits this long before starting a search, so stepping quickly through
   * Positions starts one search, not one per Position. Default 150 ms.
   */
  readonly delayMs?: number;
}

/**
 * The Analysis to show for `position`: only one of that very Position, so a
 * stale state (rendered before the client switched) never draws on it.
 */
export function analysisOf(
  state: AnalysisState,
  position: string | undefined,
): Analysis<string> | undefined {
  return state.kind !== "idle" && state.request.position === position
    ? state.analysis
    : undefined;
}

const ERROR_TEXT: Readonly<Record<string, string>> = {
  busy: "The server is busy with other searches; try again shortly.",
  timeout: "The Engine ran out of time.",
  "engine-error": "The Engine failed.",
  "worker-error": "The Engine crashed.",
  "unreadable-reply": "The Engine sent an unreadable reply.",
};

const sameRequest = (a: AnalysisRequest, b: AnalysisRequest) =>
  a.gameId === b.gameId && a.engineId === b.engineId &&
  a.position === b.position && a.lines === b.lines &&
  a.maxTimeMs === b.maxTimeMs;

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export class AnalysisClient {
  readonly #connect: Connect;
  readonly #onState: (state: AnalysisState) => void;
  readonly #delayMs: number;
  #socket: StreamSocket | undefined;
  #open = false;
  /** A `start` waiting for the socket to open. */
  #queued: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #state: AnalysisState = { kind: "idle" };
  /** `id` of the wanted search; replies with any other id are stale. */
  #id: string | undefined;
  #sent = false;
  #seq = 0;
  #closed = false;

  constructor(options: AnalysisClientOptions) {
    this.#connect = options.connect;
    this.#onState = options.onState;
    this.#delayMs = options.delayMs ?? 150;
  }

  get state(): AnalysisState {
    return this.#state;
  }

  /**
   * Analyse `request`, replacing any other search (a changed Position cancels
   * the old one at once: its Lines are no longer shown). The same request
   * again keeps the search as it is, even a finished or failed one (see
   * `retry`); `undefined` stops it.
   */
  analyze(request: AnalysisRequest | undefined): void {
    if (this.#closed) return;
    if (request === undefined) return this.stop();
    const current = this.#state;
    if (current.kind !== "idle" && sameRequest(current.request, request)) {
      return;
    }
    this.#begin(request);
  }

  /** Start `request` again even if it finished or failed (e.g. after `busy`). */
  retry(): void {
    const current = this.#state;
    if (!this.#closed && current.kind !== "idle") this.#begin(current.request);
  }

  /** Cancel the search, if any. */
  stop(): void {
    if (this.#closed) return;
    clearTimeout(this.#timer);
    this.#queued = undefined;
    if (this.#id !== undefined && this.#sent) {
      this.#socket?.send(JSON.stringify({ type: "stop" }));
    }
    this.#id = undefined;
    this.#sent = false;
    this.#set({ kind: "idle" });
  }

  /**
   * Cancel any search explicitly (`stop`), then close the connection; the
   * client is unusable afterwards.
   */
  close(): void {
    clearTimeout(this.#timer);
    if (!this.#closed && this.#id !== undefined && this.#sent) {
      this.#socket?.send(JSON.stringify({ type: "stop" }));
    }
    this.#closed = true;
    this.#id = undefined;
    this.#socket?.close();
    this.#socket = undefined;
  }

  #begin(request: AnalysisRequest): void {
    clearTimeout(this.#timer);
    const id = `s${++this.#seq}`;
    this.#id = id;
    this.#sent = false;
    this.#set({ kind: "running", request });
    this.#timer = setTimeout(() => this.#send(id, request), this.#delayMs);
  }

  #send(id: string, request: AnalysisRequest): void {
    if (this.#id !== id) return;
    const message = JSON.stringify({
      type: "start",
      id,
      gameId: request.gameId,
      engineId: request.engineId,
      position: request.position,
      limits: { lines: request.lines, maxTimeMs: request.maxTimeMs },
    });
    this.#sent = true;
    if (this.#open) {
      this.#socket!.send(message);
      return;
    }
    this.#queued = message;
    if (!this.#socket) this.#openSocket();
  }

  #openSocket(): void {
    const socket = this.#connect(ANALYSIS_STREAM_PATH, {
      onOpen: () => {
        if (this.#socket !== socket) return;
        this.#open = true;
        const queued = this.#queued;
        this.#queued = undefined;
        if (queued !== undefined) socket.send(queued);
      },
      onMessage: (text) => {
        if (this.#socket === socket) this.#receive(text);
      },
      onClose: () => {
        if (this.#socket !== socket) return;
        this.#socket = undefined;
        this.#open = false;
        this.#queued = undefined;
        const current = this.#state;
        if (current.kind === "running" && this.#id !== undefined) {
          this.#id = undefined;
          this.#set({
            ...current,
            kind: "error",
            message: "Lost the connection to the server.",
          });
        }
      },
    });
    this.#socket = socket;
  }

  #receive(text: string): void {
    const message = parse(text);
    if (!message || message.id === undefined || message.id !== this.#id) {
      return; // Not about the wanted search (e.g. one already replaced).
    }
    const current = this.#state;
    if (current.kind !== "running") return;
    switch (message.type) {
      case "analysis":
        this.#set({
          kind: "running",
          request: current.request,
          analysis: message.analysis as Analysis<string>,
        });
        return;
      case "done":
        this.#id = undefined;
        this.#set({ ...current, kind: "done" });
        return;
      case "error": {
        this.#id = undefined;
        const error = message.error as
          | { code?: unknown; message?: unknown }
          | undefined;
        const code = typeof error?.code === "string" ? error.code : "";
        const fallback = typeof error?.message === "string"
          ? error.message
          : "The search failed.";
        this.#set({
          ...current,
          kind: "error",
          message: ERROR_TEXT[code] ?? fallback,
        });
        return;
      }
    }
  }

  #set(state: AnalysisState): void {
    this.#state = state;
    this.#onState(state);
  }
}
