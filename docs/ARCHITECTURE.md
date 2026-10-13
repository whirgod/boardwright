# Architecture

Current state is a scaffold; sections marked _planned_ describe intent, not code.

## Layout

```
packages/core     Game-agnostic contracts: GameRules, Notation, Engine, Analysis
apps/server       Hono server: HTTP API (+ planned WebSocket) and host of the web UI
                  (hosts only the tic-tac-toe Game and its minimax Engine until the hosted catalog, #36, lands)
apps/web          Browser UI (Preact, ADR 0004): Game list, new Match, play; planned: Review, analysis overlay
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
  the current Position by replaying the stored Move list, and applies **every** Match change
  through one method, `apply(id, actor, change, { expectedVersion? })`:
  - `actor`: `{ token }` (a human Player proving its Seat), `{ engineSeat }` (the server playing
    for the Engine in that Seat; other Seats are refused with `not-engine-seat`) or
    `{ gameMaster: true }` (the Game master imposing a change).
  - `change`: a Player's `PlayerChange` — `{ kind: "move", move }` (Notation; only the Seat to
    move, only Moves among `legalMoves`, compared in Notation since Moves are opaque) or
    `{ kind: "resignation" }` (at any time; the Opponent wins) — or the Game master's
    `ImposedChange`: `{ kind: "forfeit", seat, reason }` (`seat` is to move and failed to play;
    the Opponent wins; `reason` is a `ForfeitReason` code). Overloads pair Actors with their
    kinds of change. A Chance event (#15) becomes one more imposed change.
  - One path for all kinds: load, check `expectedVersion` (`conflict`), authorize the Player,
    refuse a finished Match, judge the change (a pure function per kind), one versioned write
    (`conflict` if another process won), one event. Changes to one Match run one at a time.
    Refusals are `MatchError`s with a `code`, change nothing and emit nothing; a Game that refuses
    a Move its own `legalMoves` listed is a server fault (500). A stored Outcome ends the Match
    regardless of the Position.
  - Outcomes state their kind (`Outcome` in `packages/core`; Games return a `RulesOutcome`):
    `{ kind: "rules", winner?, reason }` (the Game's code), `{ kind: "resignation", winner,
    seat }` or `{ kind: "forfeit", winner, seat, reason }` (`seat` is the Seat that resigned or
    forfeited).
  - `onMatchChanged(listener)` delivers exactly one frozen `MatchEvent` per committed change:
    `kind` (`created`, `move`, `resignation`, `forfeit`), `matchId`, `version` (1 on create, +1
    per change, equal to `MatchView.version`), `at`, the resulting `position`/`toMove`/`outcome`,
    plus `seat`/`move` (or `gameId`/`seats` on `created`). A Match's events arrive in version
    order. To follow a Match: subscribe first, then `getMatch` (version n), then apply only
    events with `version > n`. Listeners may be async; errors and rejections are logged; returns
    an unsubscribe.
  - `createMatch` refuses Engine Seats whose Engine the Game does not have (`invalid-seats`).
- `players.ts` — `Player`, a union discriminated by `kind`: `human` and
  `{ kind: "engine", engineId, limits }` (limits: `maxDepth`, `maxTimeMs` <= 60 s, `lines`;
  optional, default none). Engine Seats have no seat token.
- `engines.ts` — `EngineRegistry`: Engines per Game (`id`, `name`, `module` URL).
- `engine-driver.ts` — `EngineDriver` subscribes to `onMatchChanged`. It remembers each running
  Match's Engine Seats from its `created` event (loading a Match once if it was created before the
  driver subscribed) and, on an event that leaves an Engine Seat to move, searches from the event's
  Position and plays the result with `apply(id, { engineSeat }, move, { expectedVersion })`, i.e.
  through the referee; a Match that moved on meanwhile drops the Move. A search that throws,
  exceeds `limits.maxTimeMs` + a grace period (default 5 s), returns no Move or a Move the referee
  refuses is retried once with a fresh Worker; then the Game master imposes a Forfeit with a
  `ForfeitReason` code (`engine-error`, `worker-error`, `timeout`, `illegal-move`,
  `not-registered`, ...; raw error text is only logged), so a Match never hangs. An unset
  `limits.maxTimeMs` becomes `DEFAULT_SEARCH_TIME_MS` (5 s) when searching, so no search is
  unbounded. At most `maxConcurrent` (default 4) searches run at once; the rest queue. `close()`
  aborts searches in flight (no forfeit); `idle()` awaits them (tests).
- `engine-search.ts` / `engine-worker.ts` — one Web Worker per search, always terminated
  afterwards (timeout, error, abort or reply). Messages carry only Notation strings and limits:
  `{ module, position, limits }` -> `{ ok: true, move } | { ok: false, message }`. The worker loads
  the Engine module by URL (`rules` + `engine` exports) and plays the first Move of the best Line
  of the deepest completed Analysis. Workers inherit the server's permissions (Deno's per-worker
  `deno.permissions` is still unstable; sandboxing is tracked in #29), so Engine code is trusted
  with the server's net/env/read access and the tasks grant `--allow-read` of the workspace
  source dirs, which loading the worker needs; Engines are first-party code.
- `main.ts` wires it: `GameMaster` with the `minimax` tic-tac-toe Engine, an `EngineDriver`,
  `buildApp({ master, webRoot })` serving the built web UI from `apps/web/dist`.
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
  client text echoed in error messages is truncated. With `webRoot`, every non-`/api/` GET is
  served from that directory (`@std/http` `serveDir`; missing files 404; `index.html` with
  `Cache-Control: no-cache`, all with `Referrer-Policy: no-referrer` and `nosniff`).

## Web UI (`apps/web`)

Preact SPA bundled by `deno bundle` from `index.html` into `dist/` (ADR 0004); hash routes
(`#/`, `#/games/:gameId/new`, `#/matches/:id`), so the server only serves files. It talks to the
API with Notation strings like any client and polls `GET /api/matches/:id` every second until the
Match has an Outcome (switch to the stream once #9 lands).

- DOM-free, tested modules: `api.ts` (`ApiClient`, `ApiError` with the server's `code`),
  `route.ts` (routes, share links), `seat-tokens.ts` (seat tokens per Match in `localStorage`),
  `match-state.ts` (Match status, Move list rows, Seat assignment), `outcome.ts` (the only place
  that words an Outcome, by its kind; reason codes are labelled, never parsed), `poller.ts`. Components (`app.tsx`, `pages/*.tsx`, `board.tsx`) stay thin.
- Seat tokens never leave the browser except in Move requests and share links, and a held token
  is never overwritten or deleted (the server shows it only once). The creator of a human vs
  human Match holds both Seats; before the first Move it can give one away, which keeps the token
  but stops playing that Seat here and shows its share link
  `#/matches/:id?seat=<seat>&token=<token>` until each Seat has moved (the fragment is not sent to
  the server; UI responses carry `Referrer-Policy: no-referrer`). Opening a link stores the token,
  unless a different one is already held for that Seat, and drops it from the URL.
- **Board-renderer seam** (`renderers/`): a Game's `BoardRenderer<Position, Move>` receives the
  Game's typed Position (decoded with its own Notation, never re-parsed) and returns a DOM-free
  `BoardScene` (board shapes, piece shapes, clickable targets such as squares or points, in board
  coordinates). `moveTargets(move)` returns `{ path, effects? }`: `path` is where the piece goes
  (`[cell]`, `[from, to]`, `[from, land1, land2]`) and drives arrows and the last-Move highlight;
  `effects` are further targets the Move picks, such as a piece removed after a mill; clicking
  `[...path, ...effects]` composes the Move. `input(position, legalMoves, selection, target)`
  turns clicks into a Move intent (`move`, `select` for multi-click Moves, `ignore`).
  `bindRenderer(rules, renderer)` wraps it behind Notation strings as a `GameView`, which adds
  highlights (last Move by replaying the Move list, selection, destinations) and arrows (for
  Analysis Lines later); Moves that do not decode are skipped, and a Position that does not decode
  makes the page fall back to Notation text (pages also sit behind an error boundary). One generic
  `board.tsx` draws any scene as SVG. Implemented for tic-tac-toe; Games without one fall back to
  Notation text and legal-Move buttons.

## API

Implemented (JSON; Positions and Moves are Notation strings):

- `GET  /api/health`, `GET /api/games`
- `GET  /api/games/:gameId/engines` → `[{ id, name }]` (404 `unknown-game`)
- `POST /api/matches` `{ gameId, seats: { <seat>: { kind: "human" } | { kind: "engine", engineId,
  limits? } } }` → `201` `{ match, tokens: { <seat>: <seat token> } }` (tokens for human Seats
  only). Seats must be exactly the Game's Seats. Tokens are returned only here. After a Move,
  Engine Seats move on their own: poll `GET /api/matches/:id` (live push comes with the WebSocket).
- `GET  /api/matches/:id` → `MatchView`: `{ id, gameId, seats: { <seat>: { kind } }, moves,
  position, toMove, legalMoves, outcome, version, createdAt, updatedAt }` (`toMove`/`outcome`
  are `null` when absent; `outcome` is an `Outcome` with a `kind`: `rules`, `resignation` or
  `forfeit`; `version` counts changes, matching Match events). Never contains tokens.
- `POST /api/matches/:id/moves` `{ move, token }` → updated `MatchView`.
- `POST /api/matches/:id/resign` `{ token }` → updated `MatchView` with a Resignation Outcome
  (the Opponent wins). Allowed at any time, not only on the Seat's turn; Engine Seats have no
  token, so they cannot be resigned over HTTP.

Errors always have the body `{ "error": { "code", "message" } }`:

| Status | Codes                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------ |
| 400    | `invalid-request` (bad JSON/body), `invalid-seats`, `invalid-move` (undecodable), `illegal-move` |
| 403    | `invalid-token`, `not-your-turn`, `not-engine-seat` (internal `{ engineSeat }` Actor only)       |
| 404    | `unknown-game`, `unknown-match`, `not-found` (no such route)                                     |
| 409    | `match-finished`, `conflict` (concurrent update; refetch and retry)                              |
| 413    | `payload-too-large`                                                                              |
| 415    | `unsupported-media-type`                                                                         |
| 500    | `internal`                                                                                       |

Planned (sketch, not final):

- `GET  /api/matches` listing (#13)
- `WS   /api/matches/:id/stream` — Match events (versioned, see `onMatchChanged`), live Analysis
- `POST /api/analysis` (game, Position, engine, limits) → stream of Analysis

## Open questions

Track these here until resolved (then record an ADR in `docs/adr/` if it meets the bar):

- Chance (backgammon dice): model rolls as Moves by a "chance" Seat, or as part of `play`
  with an injected random source? Must keep Games deterministic and Matches replayable.
- Persistence for Matches: in-memory `MatchStore` today; a persistent store comes with #13.
- Identity of human Players: per-Seat seat tokens for now (no accounts); accounts/sessions later?
- Time controls.
