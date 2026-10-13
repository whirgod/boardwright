// Follows one Match over the Match stream (`/api/matches/:id/stream`,
// docs/ARCHITECTURE.md). DOM-free: the socket comes through `Connect`.
//
// The stream sends a snapshot, then one event per change. Events carry the
// new Position but not the legal Moves (nor, at the end, the seed), so after
// applying an event the feed reloads the Match over REST to fill them in.
// If the socket drops (or never opens), the feed reloads over REST and
// reconnects with backoff; the new snapshot catches up on anything missed.
// That replaces polling: one path, and a reconnect is as good as a poll.
import { ApiError, type MatchEvent, type MatchView } from "./api.ts";
import type { Connect, StreamSocket } from "./socket.ts";

export const matchStreamPath = (matchId: string) =>
  `/api/matches/${encodeURIComponent(matchId)}/stream`;

/**
 * The Match after `event`: the next version applied (legal Moves unknown, so
 * empty until reloaded), the same view for an event it already has, or
 * `undefined` when versions were skipped (reload needed).
 */
export function applyMatchEvent(
  view: MatchView,
  event: MatchEvent,
): MatchView | undefined {
  if (event.version <= view.version) return view;
  if (event.version !== view.version + 1) return undefined;
  const entry = event.kind === "move"
    ? [{ kind: "move" as const, move: event.move }]
    : event.kind === "chance"
    ? [{ kind: "chance" as const, chance: event.chance }]
    : [];
  return {
    ...view,
    moves: [...view.moves, ...entry],
    position: event.position,
    toMove: event.toMove,
    outcome: event.outcome,
    legalMoves: [],
    version: event.version,
    updatedAt: event.at,
  };
}

export interface MatchFeedOptions {
  readonly matchId: string;
  readonly connect: Connect;
  /** `GET /api/matches/:id`. */
  readonly load: (matchId: string) => Promise<MatchView>;
  /** Every newer view of the Match. */
  readonly onMatch: (view: MatchView) => void;
  /** A failure to show (`null` once the feed works again). */
  readonly onError: (error: unknown) => void;
  /** Whether the stream is connected (for a "reconnecting" hint). */
  readonly onLive?: (live: boolean) => void;
  /** Waits before each reconnect; the last one repeats. Default 1, 2, 5, 10 s. */
  readonly retryDelaysMs?: readonly number[];
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export class MatchFeed {
  readonly #options: MatchFeedOptions;
  readonly #delays: readonly number[];
  #view: MatchView | undefined;
  #socket: StreamSocket | undefined;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #loading = false;
  #reloadAgain = false;
  #stopped = false;
  /** The Match has an Outcome: no more stream. */
  #finished = false;

  constructor(options: MatchFeedOptions) {
    this.#options = options;
    this.#delays = options.retryDelaysMs ?? [1000, 2000, 5000, 10000];
    this.#connect();
  }

  /** The latest view, if any. */
  get match(): MatchView | undefined {
    return this.#view;
  }

  /** A view from elsewhere (e.g. the reply to a Move); taken if it is not older. */
  offer(view: MatchView): void {
    this.#accept(view);
  }

  /** Reload over REST now (e.g. after a `409`). */
  reload(): void {
    if (this.#stopped) return;
    if (this.#loading) {
      this.#reloadAgain = true;
      return;
    }
    this.#loading = true;
    this.#options.load(this.#options.matchId).then(
      (view) => {
        this.#accept(view);
        if (!this.#stopped) this.#options.onError(null);
      },
      (error) => {
        if (this.#stopped) return;
        this.#options.onError(error);
        // No such Match: nothing to follow.
        if (error instanceof ApiError && error.status === 404) this.close();
      },
    ).finally(() => {
      this.#loading = false;
      if (this.#reloadAgain) {
        this.#reloadAgain = false;
        this.reload();
      }
    });
  }

  /** Stop following; idempotent. */
  close(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#socket?.close();
    this.#socket = undefined;
  }

  #connect(): void {
    if (this.#stopped || this.#finished) return;
    const socket = this.#options.connect(
      matchStreamPath(this.#options.matchId),
      {
        onOpen: () => {},
        onMessage: (text) => {
          if (this.#socket === socket) this.#receive(text);
        },
        onClose: () => {
          if (this.#socket !== socket) return;
          this.#socket = undefined;
          this.#options.onLive?.(false);
          // Catch up over REST (also tells an unknown Match apart), then retry.
          this.reload();
          const delay = this.#delays[
            Math.min(this.#attempt, this.#delays.length - 1)
          ] ?? 1000;
          this.#attempt++;
          this.#timer = setTimeout(() => this.#connect(), delay);
        },
      },
    );
    this.#socket = socket;
  }

  #receive(text: string): void {
    const message = parse(text);
    if (message?.type === "snapshot") {
      this.#attempt = 0;
      this.#options.onLive?.(true);
      this.#options.onError(null);
      this.#accept(message.match as MatchView);
    } else if (message?.type === "event" && this.#view) {
      const next = applyMatchEvent(this.#view, message.event as MatchEvent);
      if (next !== this.#view) {
        if (next) this.#accept(next);
        this.reload(); // legal Moves (and the seed at the end) come from REST
      }
    }
    // The stream sends `error` only for client messages, which we never send.
  }

  #accept(view: MatchView): void {
    if (this.#stopped) return;
    if (this.#view && view.version < this.#view.version) return;
    this.#view = view;
    this.#options.onMatch(view);
    if (view.outcome !== null && !this.#finished) {
      // Nothing changes after the Outcome: stop listening (REST still reloads).
      this.#finished = true;
      clearTimeout(this.#timer);
      this.#socket?.close();
      this.#socket = undefined;
      this.#options.onLive?.(false);
    }
  }
}
