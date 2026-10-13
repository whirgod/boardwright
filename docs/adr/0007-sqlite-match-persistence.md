---
status: accepted
---

# Matches persist in SQLite through `node:sqlite`

Matches survive a server restart: `SqliteMatchStore` implements `MatchStore` over one SQLite file, `<data dir>/matches.db`. It uses the SQLite that ships with Deno (`node:sqlite`). Each Match is one row holding the whole `MatchRecord` as JSON (typed Move list, structured Outcome, secret seed, Seat token hashes, version, timestamps), plus the columns listings filter and sort by (`game_id`, `finished`, `created_at`, each indexed together with `id`). Positions are never stored; the Game master rebuilds them by replay (ADR 0002). `MatchStore.list` serves `GET /api/matches` with keyset pagination (newest first, cursor = `createdAt` + id) and Game/finished filters; listings are built from records only and carry neither seed nor tokens. The schema version lives in `PRAGMA user_version`; a database of a newer version is refused.

Permissions stay minimal: the server tasks grant `--allow-read`/`--allow-write` of the repo's `data/` directory and the scoped `--allow-env=...,BOARDWRIGHT_DATA_DIR`. Another data dir needs a matching grant. `BOARDWRIGHT_DATA_DIR=:memory:` keeps Matches in memory (lost on exit). Tests write only to `.test-tmp/`.

Liveness (the `MatchStore` contract, #46): SQLite calls are synchronous, so a call settles as soon as it holds its lock; `PRAGMA busy_timeout` (2 s default) bounds the wait for a lock held by another process. The file runs in WAL mode. Two consequences of the synchronous driver: a wait for a lock blocks the whole event loop (every request, WebSocket stream and the EngineDriver) for up to the timeout, not just that Match; and the Game master's `storeTimeoutMs` safety net cannot fire for this store (its timer cannot run during a call, and the call has settled when control returns), so the "timed-out `update` may still commit later" caveat does not apply to it. `busy_timeout` does not bound CPU time either: a huge `list` scan is unbounded, which is why pages are capped at 100. After a restart, `EngineDriver.resumeAll()` (called from `main.ts`) plays the Engine turns that no event announces.

## Considered Options

- **Deno KV** (`Deno.openKv`) — built in and a natural fit for optimistic concurrency (versionstamps, atomic checks), but still unstable: it needs `--unstable-kv` and may change; listing with filters means hand-maintained secondary indexes; Deno KV on Deno Deploy is a different backend with different semantics. Local KV is SQLite underneath anyway.
- **SQLite via an npm/JSR driver** (e.g. `better-sqlite3`, WASM builds) — native dependency or extra WASM weight, and `--allow-ffi`/`--allow-scripts`; no gain over the built-in module.
- **JSON/NDJSON files** — no native or unstable pieces, but concurrency, atomic updates, filtering and crash safety would all be ours to build.

## Consequences

- No new dependency and no unstable flag. `node:sqlite` is Node-compatibility API in Deno; if it changes, the contract tests (run against both the in-memory and the SQLite store) catch it, and the adapter is the only file affected.
- Calls block the event loop for their duration (up to `busy_timeout` when contended); fine for single-row reads and writes at this scale, to revisit if listings over very large tables become slow.
- One server process owns the file for writes in practice; a second process is safe (the version check gives `conflict`) but not a supported deployment. A networked database would be another `MatchStore` adapter.
- Changing the stored record shape needs a migration step keyed on `user_version`.
