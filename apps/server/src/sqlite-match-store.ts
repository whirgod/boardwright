import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  MatchId,
  MatchPage,
  MatchQuery,
  MatchRecord,
  MatchStore,
} from "./match-store.ts";

/** Version of the table layout, kept in SQLite's `user_version`. */
const SCHEMA_VERSION = 1;

export interface SqliteMatchStoreOptions {
  /**
   * How long (ms) a call waits for a lock held by another connection or
   * process before it fails; default 2000. Calls are
   * synchronous, so the wait blocks the whole event loop (every request, the
   * EngineDriver) for up to this long, and the Game master's `storeTimeoutMs`
   * cannot fire for this store (its timer cannot run during a call). This
   * bound is what makes calls settle (the `MatchStore` liveness contract).
   */
  readonly busyTimeoutMs?: number;
}

/**
 * Persists Matches in a SQLite file (ADR 0007), using the SQLite that ships
 * with Deno (`node:sqlite`): no native dependency to install, no unstable
 * flag. Needs read and write access to the database file and its directory
 * (SQLite creates `-wal`/`-shm` files next to it).
 *
 * Each Match is one row: the whole {@link MatchRecord} as JSON in `data`
 * (seed, seat token hashes, typed Move list, structured Outcome, versions,
 * timestamps), plus the columns listings filter and sort by. Current
 * Positions are never stored; they are rebuilt by replay.
 *
 * Calls run synchronously inside SQLite, so a call settles as soon as it got
 * its lock, which `busyTimeoutMs` bounds. Close the store when done; use
 * `":memory:"` for a throwaway database.
 */
export class SqliteMatchStore implements MatchStore {
  readonly #db: DatabaseSync;
  readonly #insert: StatementSync;
  readonly #replace: StatementSync;
  readonly #select: StatementSync;
  /** Prepared `list` statements by filter shape (at most 8). */
  readonly #lists = new Map<string, StatementSync>();

  constructor(path: string, options: SqliteMatchStoreOptions = {}) {
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(
        `PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? 2000)}`,
      );
      if (path !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL");
      this.#migrate();
      this.#insert = this.#db.prepare(
        `INSERT INTO matches (id, game_id, finished, version, created_at, data)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      );
      this.#replace = this.#db.prepare(
        `UPDATE matches SET game_id = ?, finished = ?, version = ?,
           created_at = ?, data = ? WHERE id = ? AND version = ?`,
      );
      this.#select = this.#db.prepare("SELECT data FROM matches WHERE id = ?");
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #migrate(): void {
    // IMMEDIATE takes the write lock first, so two processes cannot both
    // read an old version and both migrate.
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#migrateLocked();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #migrateLocked(): void {
    const row = this.#db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (row.user_version > SCHEMA_VERSION) {
      throw new Error(
        `Database has schema version ${row.user_version}, newer than this ` +
          `server's ${SCHEMA_VERSION}`,
      );
    }
    if (row.user_version === SCHEMA_VERSION) return;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        finished INTEGER NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS matches_by_created ON matches (created_at, id);
      CREATE INDEX IF NOT EXISTS matches_by_game ON matches (game_id, created_at, id);
      CREATE INDEX IF NOT EXISTS matches_by_finished ON matches (finished, created_at, id);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  /** Runs `work` as a promise, so a throw becomes a rejection. */
  #run<T>(work: () => T): Promise<T> {
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  create(record: MatchRecord): Promise<void> {
    return this.#run(() => {
      const { changes } = this.#insert.run(
        record.id,
        record.gameId,
        record.outcome ? 1 : 0,
        record.version,
        record.createdAt,
        JSON.stringify(record),
      );
      if (changes === 0) {
        throw new Error(`Match ${JSON.stringify(record.id)} already exists`);
      }
    });
  }

  get(id: MatchId): Promise<MatchRecord | undefined> {
    return this.#run(() => {
      const row = this.#select.get(id) as { data: string } | undefined;
      return row && (JSON.parse(row.data) as MatchRecord);
    });
  }

  update(record: MatchRecord): Promise<boolean> {
    return this.#run(() => {
      const { changes } = this.#replace.run(
        record.gameId,
        record.outcome ? 1 : 0,
        record.version,
        record.createdAt,
        JSON.stringify(record),
        record.id,
        record.version - 1,
      );
      return changes === 1;
    });
  }

  list(query: MatchQuery): Promise<MatchPage> {
    return this.#run(() => {
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (query.gameId !== undefined) {
        where.push("game_id = ?");
        args.push(query.gameId);
      }
      if (query.finished !== undefined) {
        where.push("finished = ?");
        args.push(query.finished ? 1 : 0);
      }
      if (query.after) {
        where.push("(created_at, id) < (?, ?)");
        args.push(query.after.createdAt, query.after.id);
      }
      const sql = `SELECT data FROM matches ${
        where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
      } ORDER BY created_at DESC, id DESC LIMIT ?`;
      let statement = this.#lists.get(sql);
      if (!statement) {
        statement = this.#db.prepare(sql);
        this.#lists.set(sql, statement);
      }
      const rows = statement.all(...args, query.limit + 1) as {
        data: string;
      }[];
      const matches = rows.slice(0, query.limit)
        .map((row) => JSON.parse(row.data) as MatchRecord);
      const last = matches.at(-1);
      return {
        matches,
        ...(rows.length > matches.length && last
          ? { next: { createdAt: last.createdAt, id: last.id } }
          : {}),
      };
    });
  }

  /** Close the database; the store is unusable afterwards. */
  close(): void {
    this.#db.close();
  }
}

/** Where `main.ts` keeps the database inside the data directory. */
export const DATABASE_FILE = "matches.db";

/** Open (creating if needed) the database of the server's data directory. */
export function openMatchStore(dataDir: string): SqliteMatchStore {
  Deno.mkdirSync(dataDir, { recursive: true });
  return new SqliteMatchStore(`${dataDir}/${DATABASE_FILE}`);
}
