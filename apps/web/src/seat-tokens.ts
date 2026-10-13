// Seat tokens this browser holds, per Match. They never leave the client
// except in a Move request or a share link the user copies.
import type { Seat } from "@boardwright/core";

/** The subset of the Web Storage API this module needs. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PREFIX = "boardwright:seat-tokens:";

export class SeatTokens {
  readonly #storage: KeyValueStorage | undefined;

  /** Without storage (e.g. blocked), tokens live only as long as this object. */
  constructor(storage: KeyValueStorage | undefined) {
    this.#storage = storage;
  }

  readonly #memory = new Map<string, Record<Seat, string>>();

  /** Seat to token for a Match; empty when this browser holds no Seat. */
  get(matchId: string): Readonly<Record<Seat, string>> {
    return { ...this.#stored(matchId), ...this.#memory.get(matchId) };
  }

  #stored(matchId: string): Record<Seat, string> {
    try {
      const raw = this.#storage?.getItem(PREFIX + matchId);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (
        typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      ) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter(([, v]) => typeof v === "string"),
      );
    } catch {
      return {};
    }
  }

  /** Adds tokens for a Match, keeping those already held for other Seats. */
  add(matchId: string, tokens: Readonly<Record<Seat, string>>): void {
    const merged = { ...this.get(matchId), ...tokens };
    this.#memory.set(matchId, merged);
    try {
      this.#storage?.setItem(PREFIX + matchId, JSON.stringify(merged));
    } catch {
      // Storage full or blocked: keep the in-memory copy.
    }
  }
}
