import type { GameId, Outcome, Seat } from "@boardwright/core";
import type { Player } from "./players.ts";

export type MatchId = string;

/** One Seat of a stored Match: who plays it and, for token holders, the token's hash. */
export interface SeatRecord {
  readonly player: Player;
  /** SHA-256 (hex) of the seat token; absent for Players that need none. */
  readonly tokenHash?: string;
}

/**
 * Everything needed to restore a Match. Game-agnostic: Moves are Notation
 * strings, and the current Position is rebuilt by replaying them from the
 * Game's initial Position (Games are deterministic, ADR 0002).
 */
export interface MatchRecord {
  readonly id: MatchId;
  readonly gameId: GameId;
  readonly seats: Readonly<Record<Seat, SeatRecord>>;
  /** Moves in play order, each in the Game's Notation. */
  readonly moves: readonly string[];
  /** Set once the Match has ended, whatever the kind of ending. */
  readonly outcome?: Outcome;
  /** Incremented on every update; used for optimistic concurrency. */
  readonly version: number;
  /** ISO 8601 timestamps. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Where Matches live. The in-memory store is the default; a persistent store
 * implements the same interface (#13) and must pass `assertMatchStoreContract`.
 */
export interface MatchStore {
  /** Store a new Match. Throws if a Match with the same id exists. */
  create(record: MatchRecord): Promise<void>;
  get(id: MatchId): Promise<MatchRecord | undefined>;
  /**
   * Replace a Match if the stored version is `record.version - 1`.
   * Returns `false` (and changes nothing) if the Match is missing or another
   * update got there first.
   */
  update(record: MatchRecord): Promise<boolean>;
}

/** Keeps Matches in a Map; they are lost when the process exits. */
export class InMemoryMatchStore implements MatchStore {
  readonly #matches = new Map<MatchId, MatchRecord>();

  create(record: MatchRecord): Promise<void> {
    if (this.#matches.has(record.id)) {
      return Promise.reject(
        new Error(`Match ${JSON.stringify(record.id)} already exists`),
      );
    }
    this.#matches.set(record.id, structuredClone(record));
    return Promise.resolve();
  }

  get(id: MatchId): Promise<MatchRecord | undefined> {
    const record = this.#matches.get(id);
    return Promise.resolve(record && structuredClone(record));
  }

  update(record: MatchRecord): Promise<boolean> {
    const current = this.#matches.get(record.id);
    if (!current || current.version !== record.version - 1) {
      return Promise.resolve(false);
    }
    this.#matches.set(record.id, structuredClone(record));
    return Promise.resolve(true);
  }
}
