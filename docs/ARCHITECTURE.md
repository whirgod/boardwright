# Architecture

Current state is a scaffold; sections marked _planned_ describe intent, not code.

## Layout

```
packages/core     Game-agnostic contracts: GameRules, Notation, Engine, Analysis
apps/server       Hono server: HTTP API (+ planned WebSocket) and host of the web UI
                  (hosts only the tic-tac-toe Game and its minimax Engine until the hosted catalog, #36, lands)
apps/web          (planned) Browser UI: board rendering, play, review, analysis overlay
packages/testing  Contract test kit every Game runs (assertGameRulesContract)
games/<game>      One package per Game implementing GameRules (games/tic-tac-toe is the reference)
engines/<algo>    Game-agnostic Engine libraries, e.g. engines/minimax (alpha-beta search)
engines/<game>-<name>  One package per Engine for one Game: an Engine library + an evaluation, e.g.
                  engines/tic-tac-toe-minimax (planned: engines/chess-minimax). It exports
                  `rules` and `engine`, so the server can load it by URL inside a Worker.
```

Each member has a `deno.json` with `name`/`version`/`exports`. Package names: `@boardwright/<dir>` (e.g. `@boardwright/core`, `@boardwright/game-chess`,
`@boardwright/engine-chess-minimax`).

## Dependency rules

```
core  <-  games/*  <-  engines/*
  ^          ^            ^
  └──── apps/server ──────┘        apps/web -> core (+ games/* for client-side rendering/move hints)
```

- `core` depends on nothing.
- `testing` depends only on `core` (+ `@std/assert`); only Games' tests import it.
- A Game depends only on `core`. It is pure: no I/O, no randomness except via inputs.
- An Engine library (`engines/<algorithm>`) depends only on `core`; it searches any Game
  through the `GameRules` it is given.
- An Engine (`engines/<game>-<name>`) depends on `core`, on the Game it plays (to generate
  moves while searching) and usually on an Engine library it composes with an evaluation.
- The server composes Games and Engines; Games and Engines never import the server.

## Key ideas

- **The server is the referee.** It holds the authoritative Position of every Match and applies
  Moves via `GameRules.play` after checking `legalMoves`. Engines are just Players (or
  analysis providers) and are never trusted to change state.
- **Positions and Moves are opaque** outside their Game. Everything crossing a process or
  network boundary uses the Game's `Notation` (strings), so the server, API, storage and UI
  stay game-agnostic.
- **Analysis is a stream** _(planned, #9)_. `Engine.analyze` yields progressively deeper `Analysis`
  (multiple `Line`s with a `Score`), which the server forwards to the UI for live overlays.
  "Best move" = first Move of the best Line once the search stops.
- **Engine contract kit, no shared limits validator.** Every Engine runs `assertEngineContract`
  (`@boardwright/testing`). `SearchLimits` validation is deliberately duplicated: the server's
  `parseLimits` validates untrusted JSON (shape, unknown fields, host caps), while each Engine
  must stand alone and throw `RangeError` for any host; only three numeric predicates overlap.
  The kit's `badLimits` list is the shared source of truth for the Engine side.
- **In-process first, out-of-process later** _(open question)_: Engines start as TypeScript
  workspace members loaded in-process (run in Web Workers to keep the server responsive). A
  stdio/HTTP engine protocol (UCI-like) may be added so Engines in other languages can plug in.

## Server internals (`apps/server/src`)

- `games.ts` — `GameRegistry`: the Games this server hosts, by id.
- `game-master.ts` — `GameMaster`, the referee, independent of HTTP: creates Matches, rebuilds
  the current Position by replaying the stored Move list, and accepts a Move only from the Seat
  to move, if it decodes in the Game's Notation and is among `legalMoves` (compared in Notation,
  since Moves are opaque). Refusals are `MatchError`s with a `code`; a Game that refuses a Move
  its own `legalMoves` listed is a server fault (500). A stored Outcome (e.g. a forfeit) ends
  the Match regardless of the Position. Seams for #7/#9:
  - `playAs(id, seat, move)` plays for Seats the server drives itself (Engines); token-holding
    Seats are refused (`not-server-driven`).
  - `forfeit(id, seat, reason)` ends the Match for a server-driven Seat that is to move and failed: the other
    Seat wins (two-Seat Games), `reason` is the Outcome's reason.
  - `onMatchChanged(listener)` starts (sync or async) listeners with a frozen copy of the Match after every create, accepted Move
    and forfeit (e.g. to schedule an Engine's Move or push to WebSocket clients); errors and rejections are logged; returns an unsubscribe.
  - `createMatch` refuses Engine Seats whose Engine the Game does not have (`invalid-seats`).
- `players.ts` — `PlayerSpec`, a union discriminated by `kind`: `human` and
  `{ kind: "engine", engineId, limits }` (limits: `maxDepth`, `maxTimeMs` <= 60 s, `lines`;
  optional, default none). Engine Seats have no seat token.
- `engines.ts` — `EngineRegistry`: Engines per Game (`id`, `name`, `module` URL).
- `engine-driver.ts` — `EngineDriver` subscribes to `onMatchChanged`; when an Engine Seat is to
  move it searches and plays the result with `playAs`, i.e. through the referee. A search that
  throws, exceeds `limits.maxTimeMs` + a grace period (default 5 s), returns no Move or a Move the
  referee refuses is retried once with a fresh Worker; then the Seat forfeits with reason
  `engine-failure: <engineId> for <seat>: <code>` (code: `engine-error`, `worker-error`, `timeout`, `illegal-move`, ...; raw error text is only logged), so a Match never hangs. An unset `limits.maxTimeMs` becomes `DEFAULT_SEARCH_TIME_MS` (5 s) when searching, so no search is unbounded. At most `maxConcurrent` (default 4) searches run at once; the rest queue. `close()` aborts
  searches in flight (no forfeit); `idle()` awaits them (tests).
- `engine-search.ts` / `engine-worker.ts` — one Web Worker per search, always terminated
  afterwards (timeout, error, abort or reply). Messages carry only Notation strings and limits:
  `{ module, position, limits }` -> `{ ok: true, move } | { ok: false, message }`. The worker loads
  the Engine module by URL (`rules` + `engine` exports) and plays the first Move of the best Line
  of the deepest completed Analysis. Workers inherit the server's permissions (Deno's per-worker
  `deno.permissions` is still unstable; sandboxing is tracked in #29), so Engine code is trusted
  with the server's net/env/read access and the tasks grant `--allow-read` of the workspace
  source dirs, which loading the worker needs; Engines are first-party code.
- `main.ts` wires it: `GameMaster` with the `minimax` tic-tac-toe Engine, an `EngineDriver`, `buildApp({ master })`.
- `match-store.ts` — `MatchStore` interface + `InMemoryMatchStore`. Records hold Notation
  strings only (Move list, Outcome, Seats with token hashes, timestamps) and a `version` for
  optimistic concurrency. `match-store.contract.ts` is the contract test every store runs.
- `tokens.ts` — seat tokens: 256-bit random hex; only their SHA-256 is stored.
- `requests.ts` — hand-written validation of JSON bodies (no schema library: the bodies are
  tiny and errors stay in our shape).
- `app.ts` — Hono routes; maps `MatchError` codes to HTTP statuses. `buildApp` builds its own
  `GameMaster` from `games`/`store`/`now`, or serves one passed as `master` (so an `EngineDriver` can attach
  to it first); `engines` is passed through to the built one. Request bodies on `/api/*`
  are capped (16 KiB, `bodyLimit`), POST bodies must be `Content-Type: application/json`, and
  client text echoed in error messages is truncated.

## API

Implemented (JSON; Positions and Moves are Notation strings):

- `GET  /api/health`, `GET /api/games`
- `GET  /api/games/:gameId/engines` → `[{ id, name }]` (404 `unknown-game`)
- `POST /api/matches` `{ gameId, seats: { <seat>: { kind: "human" } | { kind: "engine", engineId,
  limits? } } }` → `201` `{ match, tokens: { <seat>: <seat token> } }` (tokens for human Seats
  only). Seats must be exactly the Game's Seats. Tokens are returned only here. After a Move,
  Engine Seats move on their own: poll `GET /api/matches/:id` (live push comes with the WebSocket).
- `GET  /api/matches/:id` → `MatchView`: `{ id, gameId, seats: { <seat>: { kind } }, moves,
  position, toMove, legalMoves, outcome, createdAt, updatedAt }` (`toMove`/`outcome` are
  `null` when absent). Never contains tokens.
- `POST /api/matches/:id/moves` `{ move, token }` → updated `MatchView`.

Errors always have the body `{ "error": { "code", "message" } }`:

| Status | Codes                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------ |
| 400    | `invalid-request` (bad JSON/body), `invalid-seats`, `invalid-move` (undecodable), `illegal-move` |
| 403    | `invalid-token`, `not-your-turn`, `not-server-driven` (internal `playAs` only)                   |
| 404    | `unknown-game`, `unknown-match`, `not-found` (no such route)                                     |
| 409    | `match-finished`, `conflict` (concurrent update; refetch and retry)                              |
| 413    | `payload-too-large`                                                                              |
| 415    | `unsupported-media-type`                                                                         |
| 500    | `internal`                                                                                       |

Planned (sketch, not final):

- `GET  /api/matches` listing (#13)
- `WS   /api/matches/:id/stream` — Moves, Outcome, live Analysis
- `POST /api/analysis` (game, Position, engine, limits) → stream of Analysis

## Open questions

Track these here until resolved (then record an ADR in `docs/adr/` if it meets the bar):

- Chance (backgammon dice): model rolls as Moves by a "chance" Seat, or as part of `play`
  with an injected random source? Must keep Games deterministic and Matches replayable.
- Persistence for Matches: in-memory `MatchStore` today; a persistent store comes with #13.
- Web UI framework and board rendering approach (SVG per Game?).
- Identity of human Players: per-Seat seat tokens for now (no accounts); accounts/sessions later?
- Time controls.
