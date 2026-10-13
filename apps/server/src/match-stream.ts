/**
 * The Match stream: what a client following one Match over a WebSocket
 * receives (schema in `docs/ARCHITECTURE.md`). Transport-agnostic: it only
 * needs a way to send messages, so tests drive it without a network.
 */
import type { GameMaster, MatchEvent, MatchView } from "./game-master.ts";

/** Server-to-client messages of the Match stream. */
export type MatchStreamMessage =
  | { readonly type: "snapshot"; readonly match: MatchView }
  | { readonly type: "event"; readonly event: MatchEvent }
  | {
    readonly type: "error";
    readonly error: { readonly code: string; readonly message: string };
  };

/**
 * Follows one Match: sends a `snapshot` of it, then every later
 * {@link MatchEvent} exactly once, in version order. It subscribes before
 * reading the snapshot and drops events the snapshot already contains, as
 * `GameMaster.onMatchChanged` prescribes, so nothing is missed or repeated.
 */
export class MatchFollower {
  readonly #master: GameMaster;
  readonly #matchId: string;
  readonly #send: (message: MatchStreamMessage) => void;
  #unsubscribe: (() => void) | undefined;
  #closed = false;
  /** Events that arrive before the snapshot is sent. */
  #pending: MatchEvent[] | undefined = [];
  #lastVersion = 0;

  constructor(
    master: GameMaster,
    matchId: string,
    send: (message: MatchStreamMessage) => void,
  ) {
    this.#master = master;
    this.#matchId = matchId;
    this.#send = send;
  }

  /** Subscribe and send the snapshot. Rejects when the Match cannot be read. */
  async start(): Promise<void> {
    this.#unsubscribe = this.#master.onMatchChanged((event) => {
      if (event.matchId !== this.#matchId || this.#closed) return;
      if (this.#pending) this.#pending.push(event);
      else this.#deliver(event);
    });
    try {
      const snapshot = await this.#master.getMatch(this.#matchId);
      if (this.#closed) return;
      this.#lastVersion = snapshot.version;
      this.#send({ type: "snapshot", match: snapshot });
      const pending = this.#pending ?? [];
      this.#pending = undefined;
      for (const event of pending) this.#deliver(event);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Stop following; idempotent. */
  close(): void {
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  #deliver(event: MatchEvent): void {
    if (event.version <= this.#lastVersion) return;
    this.#lastVersion = event.version;
    this.#send({ type: "event", event });
  }
}
