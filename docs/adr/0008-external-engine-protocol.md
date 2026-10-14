---
status: accepted
---

# External Engines speak JSON lines over stdio

Engines in other languages plug in as **external Engines**: a process the server starts from a configured command, which speaks the external Engine protocol ([spec](../external-engine-protocol.md)) over its stdin/stdout, one JSON object per line. Positions and Moves cross as the Game's Notation strings, Analyses with the `Analysis` shape of `packages/core` (incl. the pending-chance shape `{ depth, lines: [], score, seat }`, ADR 0005). The server sends `hello` (protocol version, Game id) and expects `ready` (version, Game id, name); then, one search at a time, `analyze` (id, Position, limits) answered by any number of `analysis` and a final `done` (or `error`); `stop` ends a search early (the Engine still answers `done`); `quit` or end of stdin ends the process.

On the server an external Engine is another adapter behind the Engine runner's seam (`externalAdapter`, `external-engine.ts`), next to the worker adapter (ADR 0006); `routingAdapter` picks one per Engine. The runner keeps owning limits, deadlines, the concurrency cap and the Analysis shape check, so callers (the Engine driver, the Analysis stream) do not change. The adapter keeps a small pool of handshaken processes per Engine and reuses them search after search. Every failure is a `SearchError`: a process that cannot start or exits is `worker-error`, output outside the protocol `unreadable-reply`, an `error` message `engine-error`, a silent handshake `timeout`. A process that broke the protocol, crashed or ignored `stop` is killed and replaced on the next search; after 3 such failures in a row the Engine cools down for 30 s (searches fail at once), then gets another try.

External Engines are registered in a JSON config file read at startup (`BOARDWRIGHT_EXTERNAL_ENGINES`, default `external-engines.json` in the repo, optional). Startup checks each one (hosted Game, run permission, handshake) and fails on any problem. Deno's `--allow-run` must list each configured command; tasks grant it only for the example Engine (`deno task start:example-engine`) and the test Engines.

## Considered Options

- **stdio vs HTTP.** HTTP would let Engines run anywhere and scale out, but the server would have to manage ports or URLs, authentication and Engine liveness, and every Engine would need an HTTP server. stdio is what engine protocols (UCI, CECP, GTP) use: any language can read and write lines, the server owns the process lifecycle (start, kill, restart), there is no network surface, and a crash shows up at once as an exited process. A remote Engine can still be wrapped by a small stdio-to-HTTP bridge. Chosen: stdio.
- **JSON messages vs UCI-like text.** UCI's text commands are trivial to print but each message needs its own grammar (`info depth 3 multipv 2 score cp 15 pv e2e4 ...`), Scores and the chance shape would need new tokens, and Notation strings would have to be free of spaces. JSON lines carry the existing `Analysis` shape unchanged, are versionable (unknown fields are ignored) and every language has a parser. Chosen: JSON lines.
- **A process per search** (like the worker adapter) — simplest lifecycle and stop is a kill, but process start-up (tens of ms to seconds for some runtimes) would be paid on every Move and Engines could not keep state between searches. Rejected in favour of pooled, reused processes with an explicit `stop`.

## Consequences

- External Engines are trusted operator configuration: unlike Engine modules in Workers (ADR 0006) the server cannot sandbox a native process, so it runs only commands named in the config and allowed by `--allow-run`, without a shell, and inherits the server's environment. Sandboxing (e.g. a container) is up to whoever configures the command; the example runs under `deno run` with no permissions.
- Protocol violations cost the process, not the server: lines are capped at 1 MiB and fields outside the Analysis shape are dropped before reaching clients.
- Engine contract conformance is checked through the runner: `runnerEngine` (`engine-runner.testing.ts`) wraps the runner as a typed `Engine`, so `assertEngineContract` runs against the example Engine end to end.
- Not covered: CPU and memory of external processes (the runner's deadline stops a search; the process's resources are not capped), idle-process expiry, and hot reload of the config (restart the server).
