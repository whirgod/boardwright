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
 * One entry of a Match's Move list (GLOSSARY), in the Game's Notation: a
 * Move by a Seat, or a Chance event the Game master resolved (Games with
 * chance only, ADR 0005).
 */
export type MoveListEntry =
  | { readonly kind: "move"; readonly move: string }
  | { readonly kind: "chance"; readonly chance: string };

/**
 * Everything needed to restore a Match. Game-agnostic: the Move list holds
 * Notation strings, and the current Position is rebuilt by replaying it from
 * the Game's initial Position (Games are deterministic, ADR 0002).
 */
export interface MatchRecord {
  readonly id: MatchId;
  readonly gameId: GameId;
  readonly seats: Readonly<Record<Seat, SeatRecord>>;
  /** The Move list: Moves and Chance events in play order. */
  readonly moves: readonly MoveListEntry[];
  /**
   * Secret seed the Game master draws Chance events from (Games with chance
   * only, ADR 0005). Never shown to clients before the Match has an Outcome.
   */
  readonly seed?: string;
  /** Set once the Match has ended, whatever the kind of ending. */
  readonly outcome?: Outcome;
  /** Incremented on every update; used for optimistic concurrency. */
  readonly version: number;
  /** ISO 8601 timestamps. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Position in a listing: the `createdAt` and id of the last Match of a page. */
export interface MatchCursor {
  readonly createdAt: string;
  readonly id: MatchId;
}

/** Which Matches `MatchStore.list` returns; newest first. */
export interface MatchQuery {
  /** Only Matches of this Game. */
  readonly gameId?: GameId;
  /** `true`: only Matches with an Outcome; `false`: only running ones. */
  readonly finished?: boolean;
  /** Page size, at least 1. */
  readonly limit: number;
  /** Continue after this Match (the `next` of the previous page). */
  readonly after?: MatchCursor;
}

export interface MatchPage {
  readonly matches: readonly MatchRecord[];
  /** Pass as `after` for the next page; absent on the last page. */
  readonly next?: MatchCursor;
}

/** Orders Matches newest first: by `createdAt`, then id, both descending. */
export function compareNewestFirst(a: MatchCursor, b: MatchCursor): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

/**
 * Where Matches live. The in-memory store is the default; `SqliteMatchStore`
 * (ADR 0007) persists them. Every store must pass `assertMatchStoreContract`.
 *
 * Liveness: every call must settle (resolve or reject) in bounded time, so
 * an adapter sets its own timeouts on the database or file it talks to. The
 * Game master applies the changes of one Match one at a time, so a call that
 * never settles would block every later change and read of that Match; as a
 * safety net it gives up on a call after `storeTimeoutMs` (default 10 s) and
 * treats it as a failure, but cannot cancel it: a timed-out `update` may
 * still commit later, which the next change sees as a newer version.
 * Calls must not call back into the Game master.
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
  /**
   * One page of Matches, newest first (`createdAt`, then id, descending),
   * filtered by `query`. A Match is finished when it has an Outcome. The
   * records are complete, including seed and token hashes: callers strip
   * what clients must not see.
   */
  list(query: MatchQuery): Promise<MatchPage>;
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

  list(query: MatchQuery): Promise<MatchPage> {
    const matching = [...this.#matches.values()]
      .filter((m) =>
        (query.gameId === undefined || m.gameId === query.gameId) &&
        (query.finished === undefined ||
          (m.outcome !== undefined) === query.finished) &&
        (query.after === undefined || compareNewestFirst(m, query.after) > 0)
      )
      .sort(compareNewestFirst);
    const page = matching.slice(0, query.limit);
    const last = page.at(-1);
    return Promise.resolve({
      matches: structuredClone(page),
      ...(matching.length > page.length && last
        ? { next: { createdAt: last.createdAt, id: last.id } }
        : {}),
    });
  }
}
