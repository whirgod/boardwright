# Architecture

Current state is a scaffold; sections marked _planned_ describe intent, not code.

## Layout

```
packages/core     Game-agnostic contracts: GameRules (+ ChanceGameRules, ADR 0005), Notation, Engine, Analysis
apps/server       Hono server: HTTP API (+ planned WebSocket) and host of the web UI
apps/web          Browser UI (Preact, ADR 0004): Game list, new Match, play, Review, Engine analysis overlay
packages/testing  Contract test kits every Game / Engine runs (assertGameRulesContract,
                  assertChanceGameRulesContract, assertEngineContract) + diceRace, a tiny Game with chance
games/<game>      One package per Game implementing GameRules (games/tic-tac-toe is the reference;
                  games/backgammon implements ChanceGameRules)
engines/search    Shared search harness of the Engine libraries (iterative deepening, limits,
                  time/abort, multi-PV, score scale); chance-agnostic
engines/<algo>    Game-agnostic Engine libraries: engines/minimax (alpha-beta search),
                  engines/expectiminimax (Games with chance, ADR 0005)
engines/<game>-<name>  One package per Engine for one Game: an Engine library + an evaluation, e.g.
                  engines/tic-tac-toe-minimax (also engines/chess-minimax). It exports
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
- `testing` depends only on `core` (+ `@std/assert`); only tests import it.
- A Game depends only on `core`. It is pure: no I/O, no randomness except via inputs.
- An Engine library (`engines/<algorithm>`) depends only on `core` and the search harness
  (`engines/search`, itself only on `core`); it searches any Game through the `GameRules` it is
  given. The harness carries the plumbing, so each library's module is just its algorithm.
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
- **Analysis is a stream** (`/api/analysis/stream`). `Engine.analyze` yields progressively deeper `Analysis`
  (multiple `Line`s with a `Score`), which the server forwards to the UI for live overlays.
  "Best move" = first Move of the best Line once the search stops.
- **Chance events** (ADR 0005). A Game with dice implements `ChanceGameRules`, extending
  `GameRules`: a Position may have a pending Chance event (no Seat to move, no Outcome, no legal
  Moves), `chanceEvents(position)` lists its results with probabilities and
  `resolveChance(position, result)` applies one; results have their own Notation
  (`encodeChance`/`decodeChance`). Code that must tell the kinds apart uses the structural
  `hasChance(rules)` guard (`chancePending(rules, position)` for the state). Only the Game master
  resolves Chance events (see `game-master.ts`). While one is pending, Analysis has no Lines but an
  expected `score` with an explicit `seat` (the Score's perspective, since no Seat is to move);
  other Analyses have neither. A Line ends at the next Chance event. `pickChance(results, u)` in
  core is the one selection rule (used by the Game master and the kits). `engines/minimax` refuses
  Games with chance (type and run time); `engines/expectiminimax` searches them (and refuses
  Games without chance). A Game may mark its empty play with the optional `GameRules.isPass`; the
  Game master plays a Seat's only legal Move automatically when it is such a pass (`forcedPass`).
- **Engine contract kit, no shared limits validator.** Every Engine runs `assertEngineContract`
  (`@boardwright/testing`). `SearchLimits` validation is deliberately duplicated: the server's
  `parseLimits` validates untrusted JSON (shape, unknown fields, host caps), while each Engine
  must stand alone and throw `RangeError` for any host (the Engine libraries share
  `validateLimits` from `engines/search`); only three numeric predicates overlap.
  The kit's `badLimits` list is the shared source of truth for the Engine side.
- **In-process first, out-of-process later** _(open question)_: Engines start as TypeScript
  workspace members loaded in-process (run in Web Workers to keep the server responsive). A
  stdio/HTTP engine protocol (UCI-like) may be added so Engines in other languages can plug in.

## Server internals (`apps/server/src`)

- `games.ts` — `GameRegistry`: the Games this server hosts, by id.
- `chance.ts` — how the Game master draws Chance events: `newChanceSeed`, `drawChance(seed, n)`
  (details under `game-master.ts`; known-answer tests pin the algorithm).
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
    the Opponent wins; `reason` is a `ForfeitReason` code) or `{ kind: "chance" }` (resolve the
    pending Chance event; refused with `conflict` if none is). Overloads pair Actors with
    their kinds of change.
  - Chance events (ADR 0005), branching only via `hasChance`: a Match of a Game with chance gets a
    secret `seed` (`newSeed` option, default 256 random bits as 64 lowercase hex digits;
    `chance.ts`). Whenever a change, or creation, leaves a Chance event pending, the Game master
    applies `{ kind: "chance" }` itself right away, inside the same per-Match queue, as its own
    versioned change and `chance` event, until a Seat is to move; `apply`/`createMatch` return the
    view after the rolls. While one is pending, Moves and Forfeits are refused with
    `chance-pending` (409: refetch and retry); a Resignation is allowed.
  - Draw algorithm (public once the seed is revealed): the n-th Chance event of a Match (n = 0, 1,
    ... counting the Chance events before it in the Move list) takes `u = H / 2^48`, where `H` is
    the first 48 bits (12 hex digits) of SHA-256 of the UTF-8 text `"<seed>:<n>"` (n in decimal),
    and picks from the Game's `chanceEvents(position)`, in their order, the first result with
    `u < p1 + ... + pk` (cumulative sum in floating point), else the last (`pickChance`). E.g. seed
    `s`, n 6: `printf 's:6' | sha256sum` starts `ba7075967b55`, so `u ≈ 0.728`.
  - Failed rolls (e.g. a store error) are logged, never thrown (the change before them is
    committed). Recovery: retried after each delay of `rollRetryDelaysMs` (default 100, 500,
    2000 ms) inside the Match's queue; after that, the roll is tried again on the next trigger —
    any Move or Forfeit refused with `chance-pending`, or any `getMatch` of the Match (queued, not
    awaited, so a polling client heals it).
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
    `kind` (`created`, `move`, `resignation`, `forfeit`, `chance`), `matchId`, `version` (1 on
    create, +1 per change, equal to `MatchView.version`), `at`, the resulting
    `position`/`toMove`/`outcome`, plus `seat`/`move` (`chance` on `chance`, `gameId`/`seats` on
    `created`; `toMove` is `null` on an event that leaves a Chance event pending). Events never
    carry the seed. A Match's events arrive in version
    order. To follow a Match: subscribe first, then `getMatch` (version n), then apply only
    events with `version > n`. Listeners may be async; errors and rejections are logged; returns
    an unsubscribe.
  - `createMatch` refuses Engine Seats whose Engine the Game does not have (`invalid-seats`).
- `players.ts` — `Player`, a union discriminated by `kind`: `human` and
  `{ kind: "engine", engineId, limits }` (limits: `maxDepth`, `maxTimeMs` <= 60 s, `lines`;
  optional, default none). Engine Seats have no seat token.
- `engines.ts` — `EngineRegistry`: Engines per Game (`id`, `name`, `module` URL).
- `engine-driver.ts` — `EngineDriver` subscribes to `onMatchChanged`; `resumeAll()` (called once by
  `main.ts`) plays the Engine turns left waiting by a restart, which no event announces. It remembers each running
  Match's Engine Seats from its `created` event (loading a Match once if it was created before the
  driver subscribed) and, on an event that leaves an Engine Seat to move, searches from the event's
  Position through the Engine runner, takes the first Move of the best Line of the last Analysis
  that has one, and plays it with `apply(id, { engineSeat }, move, { expectedVersion })`, i.e.
  through the referee; a Match that moved on meanwhile drops the Move. A search that fails (any
  `SearchError`), proposes no Move or a Move the referee refuses is retried once; then the Game
  master imposes a Forfeit with a `ForfeitReason` code (`engine-error`, `worker-error`, `timeout`,
  `illegal-move`, `not-registered`, ...; raw error text is only logged), so a Match never hangs.
  `close()` aborts searches in flight (no forfeit); `idle()` awaits them (tests).
  The per-Match memory is bounded (`maxMatches`, default 1000, least recently moved forgotten and
  reloaded on its next event) and a load that a concurrent finish outran is not cached.
- `engine-runner.ts` — `EngineRunner`, the one place the server runs Engines. `main.ts` creates
  the one runner; the driver requires it, and the Analysis stream reuses it (purpose `analysis`), so the cap
  is server-wide. `analyze({ engine, position, limits }, { signal, purpose })` is an async iterable
  of `Analysis<string>` (Moves in Notation) in the Engine's order. Each one is checked against the
  Engine contract's shape (integer depth, at most `limits.lines` Lines, each with >= 1 Move and a
  well-formed Score, optional top-level expected Score per ADR 0005) or fails `unreadable-reply`;
  Analyses without Lines (terminal Position, pending Chance event) pass through. It owns: an unset
  `limits.maxTimeMs` becoming `DEFAULT_SEARCH_TIME_MS` (5 s), so no search is unbounded (invalid
  ones throw `RangeError`); the deadline `maxTimeMs` + grace (default 5 s, from getting a slot,
  clamped to the timer range); aborts; and failures as `SearchError` codes (`aborted`, `timeout`,
  `busy`, `engine-error`, `worker-error`, `unreadable-reply`). Breaking out of the loop, an abort
  or the deadline tells the adapter to stop the Engine and frees the slot.
  **Queueing policy:** at most `maxConcurrent` (default 4) searches run at once. `purpose: "match"`
  (the driver) is never refused, queues ahead of all Analysis requests and may use every slot;
  `purpose: "analysis"` (default; the Analysis stream) may use all but `reservedForMatches` (default 1) slots, and
  when `maxQueued` (default 8) Analysis requests already wait, one more fails at once with `busy`.
  So Engine Seats never starve behind clients; a Match search waits at most for other Match
  searches and for running searches' deadlines. Waiting while queued is abortable but not
  time-limited (bounded by the queue cap). How an Engine runs is an `EngineAdapter` (seam):
  `workerAdapter` in production; `inProcessAdapter` (`engine-runner.testing.ts`, tests only: a
  CPU-bound Engine there would block the thread and the deadline). Production adapters must
  isolate the Engine from the server's thread. Out-of-process Engines
  (#18, a further adapter) change only this module.
- `engine-worker.ts` / `engine-host.ts` — the worker adapter starts one Web Worker per search and
  always terminates it afterwards (end, error, timeout, abort or break). Messages carry only
  Notation strings and limits: `{ module, position, limits }` -> any number of
  `{ kind: "analysis", analysis }`, then `{ kind: "done" }` or `{ kind: "error", message }`
  (`HostRequest` / `WorkerMessage`, both in `engine-host.ts`).
  `engine-host.ts` (shared with the in-process adapter) loads the Engine module by URL (`rules` +
  `engine` exports), decodes the Position and encodes each Analysis's Moves, passing other fields
  through. Workers are sandboxed (ADR 0006): created with `deno.permissions` granting only
  `read` of `packages/`, `games/`, `engines/` (needed for the run-time `import(module)`), so
  Engine code cannot use net, env, write, subprocesses or any other file; attempts fail as
  `engine-error`. Needs `"unstable": ["worker-options"]` in the root `deno.json`. Not capped:
  CPU/memory inside the worker (the deadline terminates it).
- `catalog.ts` — `verifyCatalog`: the hosted catalog (`hosted-catalog.ts`: Games with their
  Engines, registered once) is checked at startup: Engine modules load, export `rules` and
  `engine`, and both match the Game id; a bad catalog stops the server. Hook for the ADR 0005
  library <-> Game kind check once `ChanceGameRules` exists. Hosts tic-tac-toe, nine men's morris,
  checkers and chess (minimax Engines), and backgammon (a Game with chance; expectiminimax
  Engine `engines/backgammon-expecti`).
- `main.ts` wires it: `GameMaster` with the verified catalog, the one `EngineRunner` and an
  `EngineDriver` using it,
  `buildApp({ master, webRoot })` serving the built web UI from `apps/web/dist`.
- `match-store.ts` — `MatchStore` interface (`create`/`get`/`update`/`list`) + `InMemoryMatchStore`;
  `sqlite-match-store.ts` — `SqliteMatchStore`, the persistent store (ADR 0007; `main.ts` opens
  `<data dir>/matches.db`, `BOARDWRIGHT_DATA_DIR`, default `data/`, `:memory:` for none). Records hold Notation
  strings only (Move list as typed entries `{ kind: "move", move }` / `{ kind: "chance", chance }`,
  Outcome, Seats with token hashes, the secret Chance `seed`, timestamps) and a `version` for
  optimistic concurrency. `match-store.contract.ts` is the contract test every store runs.
  **Liveness contract:** every `MatchStore` call must settle (resolve or reject) in bounded time;
  persistent adapters set their own timeouts (SQLite: `busy_timeout`, 2 s; its calls are synchronous, so `storeTimeoutMs` cannot fire for it and the late-commit caveat below does not apply; see ADR 0007). The Game master runs one change per Match at a
  time, so a hung call would block that Match; as a safety net it fails any call after
  `storeTimeoutMs` (default 10 s). It cannot cancel the call, so a timed-out `update` may still
  commit later: no `MatchEvent` is emitted for it, so listeners (clients, the `EngineDriver`) miss that
  version, and the next change sees it as a newer version. Store calls must not call back into
  the Game master, and nothing may await `apply` for a Match from inside a change to that Match
  (it queues behind itself and deadlocks).
  Failed Chance rolls are retried with backoff; recovery triggers (`getMatch`, a refused Move) then
  pause for `rollCooldownMs` (default 30 s) after a give-up.
- `tokens.ts` — seat tokens: 256-bit random hex; only their SHA-256 is stored.
- `requests.ts` — hand-written validation of JSON bodies (no schema library: the bodies are
  tiny and errors stay in our shape).
- `match-stream.ts` — `MatchFollower`: snapshot, then each `MatchEvent` once, built on
  `onMatchChanged` (subscribe first, then `getMatch`, drop events `<=` the snapshot's version).
- `analysis-stream.ts` — `AnalysisSession`: one connection's searches on the shared
  `EngineRunner` (purpose `analysis`); cancels on `stop`, replacement or close. Both modules only
  need a `send` callback, so tests drive them without a socket (`stream.testing.ts` has the
  loopback helpers for the end-to-end tests; `deno task test` allows `--allow-net=127.0.0.1`).
- `app.ts` — Hono routes; maps `MatchError` codes to HTTP statuses. `buildApp` builds its own
  `GameMaster` from `games`/`store`/`now`, or serves one passed as `master` (so an `EngineDriver` can attach
  to it first); `engines` is passed through to the built one. Request bodies on `/api/*`
  are capped (16 KiB, `bodyLimit`), POST bodies must be `Content-Type: application/json`, and
  client text echoed in error messages is truncated. The two WebSocket streams (see API) are
  wired here (`hono/deno` `upgradeWebSocket`); `runner` (the one from `main.ts`) enables the
  Analysis stream. With `webRoot`, every non-`/api/` GET is
  served from that directory (`@std/http` `serveDir`; missing files 404; `index.html` with
  `Cache-Control: no-cache`, all with `Referrer-Policy: no-referrer` and `nosniff`).

## Web UI (`apps/web`)

Preact SPA bundled by `deno bundle` from `index.html` into `dist/` (ADR 0004); hash routes
(`#/`, `#/games/:gameId/new`, `#/matches/:id`), so the server only serves files. It talks to the
API with Notation strings like any client and follows a Match over the Match stream; Moves and
Resignations stay REST.

- DOM-free, tested modules: `api.ts` (`ApiClient`, `ApiError` with the server's `code`, wire
  types incl. `MatchEvent`), `route.ts` (routes, share links), `seat-tokens.ts` (seat tokens per
  Match in `localStorage`), `match-state.ts` (Match status incl. "rolling" while a Chance event is
  pending, Move list rows of two Moves each with the Chance events before them, Seat assignment,
  the board request for the shown Position; renderers and invites see Moves only), `outcome.ts`
  (the only place that words an Outcome, by its kind; reason codes are labelled, never parsed),
  `socket.ts` (the WebSocket seam `Connect`; tests use `socket.testing.ts` fakes),
  `match-feed.ts`, `review.ts`, `analysis-client.ts`, `analysis-view.ts` (below). Components
  (`app.tsx`, `pages/*.tsx`, `board.tsx`, `move-list.tsx`, `analysis-panel.tsx`) stay thin.
- **Following a Match** (`match-feed.ts`): `MatchFeed` takes the stream's snapshot, applies each
  event (`applyMatchEvent`: the next version only; a repeated one is ignored, a gap reloads), then
  reloads the Match over REST, because events carry no legal Moves (nor the seed). Views are only
  ever replaced by ones with a version at least as high, so POST replies and events can arrive in
  any order. No polling: when the socket drops (or never opens) the feed reloads over REST and
  reconnects with backoff (1, 2, 5, 10 s), and the new snapshot catches up; a `404` stops it. Once
  the Match has an Outcome it closes the stream.
- **Review** (`review.ts`): the server sends only the current Position, so the UI rebuilds earlier
  ones by replaying the Move list with the Games' own rules (Moves via `play`, Chance events via
  `resolveChance`; every hosted Game, incl. ones without a renderer). The shown ply is `"live"`
  (follows the Match) or a fixed number that stays put while the Match goes on; buttons, clicking a
  Move list entry and the keys Left/Right/Home/End (not inside form fields or with modifiers)
  navigate. Earlier Positions are read-only; the current one stays playable.
- **Engine analysis** (`analysis-client.ts`, `analysis-view.ts`): one `AnalysisClient` per page
  keeps one Analysis-stream socket (opened lazily) and one search. A changed request (another
  Position, Engine, number of Lines or time) replaces the search after a short debounce, clears
  the shown Lines at once, and tags each `start` with a fresh `id`, so replies about a replaced
  search are dropped; `analysisOf` also shows only an Analysis of the shown Position. Errors
  (`busy`, connection lost, ...) become a state with "Try again". The panel is off by default while
  this browser plays a Seat of a running Match, on for Spectators and finished Matches. Scores:
  values signed, `Win in n` / `Loss in n` (Plies), from the Seat to move's perspective; while a
  Chance event is pending, the expected Score from the Analysis's `seat`. Line -> overlay
  (`overlay`): arrows for the first Move of each Line (best strongest); hovering, focusing or
  clicking (pins) a Line previews it Move by Move instead.
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
  highlights (last Move by replaying the Move list, selection, destinations) and arrows:
  `request.arrows` (one Move each from the Position, `kind: "line"`, `index` = rank) and
  `request.preview` (a Line drawn Move by Move, each decoded in the Position the earlier ones
  reach, `kind: "preview"`, `index` = step; it stops at the first Move that does not decode or
  apply); Moves that do not decode are skipped, and a Position that does not decode
  makes the page fall back to Notation text (pages also sit behind an error boundary). One generic
  `board.tsx` draws any scene as SVG. A renderer whose input does not follow `moveTargets`' click
  order provides `nextTargets` for the destination highlights. Implemented for tic-tac-toe, nine
  men's morris, checkers, chess and backgammon; Games without one fall back to Notation text and
  legal-Move buttons. Backgammon input: each Step (one die) is a checker then its destination
  (`bar` and the `off` tray are targets), in any playable order (the Game's `stepOrders`); the
  Move is played after its last Step; the dice start over, or play `pass`. A Move's arrow shows
  its first checker's journey (other Steps are `effects`). Its last Move is not highlighted (the
  replay needs the Chance events). Chess input: a Move is `from` then `to` (castling is the
  king's two-square Move); promotion is a third click, an effect on one of four picker targets (`=q`, `=r`, `=b`, `=n`) drawn below the board in the
  pieces of the Seat to move. The Move list shows chess Moves in SAN (`formatSan`),
  via a per-Game formatter registry in `move-labels.ts`; other Games show Notation.

## API

Implemented (JSON; Positions and Moves are Notation strings):

- `GET  /api/health`, `GET /api/games`
- `GET  /api/games/:gameId/engines` → `[{ id, name }]` (404 `unknown-game`)
- `POST /api/matches` `{ gameId, seats: { <seat>: { kind: "human" } | { kind: "engine", engineId,
  limits? } } }` → `201` `{ match, tokens: { <seat>: <seat token> } }` (tokens for human Seats
  only). Seats must be exactly the Game's Seats. Tokens are returned only here. After a Move,
  Engine Seats move on their own: follow the Match stream (below) or poll `GET /api/matches/:id`.
- `GET  /api/matches/:id` → `MatchView`: `{ id, gameId, seats: { <seat>: { kind } }, moves,
  position, toMove, legalMoves, outcome, seed?, version, createdAt, updatedAt }` (`moves` is the
  Move list: `{ kind: "move", move }` and, for Games with chance, `{ kind: "chance", chance }`
  entries; `toMove`/`outcome` are `null` when absent; `outcome` is an `Outcome` with a `kind`:
  `rules`, `resignation` or `forfeit`; `seed` only for Games with chance, once there is an
  Outcome; `version` counts changes, matching Match events). Never contains tokens.
- `GET  /api/matches?game=<id>&finished=true|false&limit=<1..100, default 20>&cursor=<opaque>` →
  `{ matches: MatchSummary[], nextCursor: string | null }`, newest first. `MatchSummary`: `{ id,
  gameId, seats: { <seat>: { kind } }, moveCount, outcome, version, createdAt, updatedAt }`:
  no Positions, Moves, seed or tokens. `finished` = has an Outcome. Pass `nextCursor` as `cursor`
  for the next page (`null` on the last); bad parameters give `400 invalid-request`.
- `POST /api/matches/:id/moves` `{ move, token }` → updated `MatchView`.
- `POST /api/matches/:id/resign` `{ token }` → updated `MatchView` with a Resignation Outcome
  (the Opponent wins). Allowed at any time, not only on the Seat's turn; Engine Seats have no
  token, so they cannot be resigned over HTTP.

Errors always have the body `{ "error": { "code", "message" } }`:

| Status | Codes                                                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid-request` (bad JSON/body), `invalid-seats`, `invalid-move` (undecodable), `illegal-move`                                                    |
| 403    | `invalid-token`, `not-your-turn`, `not-engine-seat` (internal `{ engineSeat }` Actor only), `forbidden-origin` (stream upgrade from another origin) |
| 404    | `unknown-game`, `unknown-match`, `not-found` (no such route)                                                                                        |
| 409    | `match-finished`, `conflict` (concurrent update; refetch and retry), `chance-pending` (dice being rolled; refetch and retry)                        |
| 413    | `payload-too-large`                                                                                                                                 |
| 415    | `unsupported-media-type`                                                                                                                            |
| 500    | `internal`                                                                                                                                          |

### Streams (WebSocket)

Browsers apply no same-origin rule to WebSockets, so both upgrades check `Origin`: no `Origin`
header (non-browser clients) or one whose host equals the request's `Host` passes, anything else
is answered `403 forbidden-origin` before upgrading. Both streams are WebSockets carrying one JSON object per text message; the `type` field names the
message. Errors have `{ "type": "error", "error": { "code", "message" } }` like REST errors, and
never close the socket (a protocol-level problem the server cannot recover from closes it with
1011). Browsers cannot set headers on a WebSocket, so nothing secret goes in the URL: **seat
tokens never appear on a stream.**

**Match stream** — `GET /api/matches/:id/stream` (WebSocket upgrade; an unknown Match answers
`404 unknown-match` before upgrading). Server to client only; the stream is public like
`GET /api/matches/:id`.

| `type`     | Fields              | Meaning                                                                                           |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------------- |
| `snapshot` | `match: MatchView`  | First message: the Match as `GET /api/matches/:id` returns it (incl. `version`).                  |
| `event`    | `event: MatchEvent` | After it, one per committed change, each exactly once, `version` rising by 1 from the snapshot's. |
| `error`    | `error`             | `invalid-request` if the client sends any message: the stream takes none.                         |

A `MatchEvent` has `matchId`, `version`, `at`, `position`, `toMove`, `outcome` (the state right
after the event) and a `kind`: `created` (`gameId`, `seats`), `move` (`seat`, `move`),
`resignation` (`seat`), `forfeit` (`seat`), or `chance` (`chance`, the Chance event's result in
Notation). The event that ends a Match carries its `outcome` (a Move that wins by the rules is
one `move` event with the `outcome`, a Resignation one `resignation` event, and so on); the
`seed` of a Game with chance is only in the `MatchView` fetched after that. The Match stays open
after the Outcome; clients close it. A client that reconnects gets a fresh snapshot (compare
`version`s to skip what it already has).

**Submitting Moves stays REST** (`POST /api/matches/:id/moves`, `POST /api/matches/:id/resign`)
rather than moving to the socket: one path with proper status codes and error bodies, seat tokens
stay out of the stream, a read-only stream is trivially safe to expose to spectators, and every
client already needs REST to create a Match. The reply of the POST and the `event` on the stream
are the same change; a client may apply whichever arrives first and drop events with a `version`
it has already seen.

**Analysis stream** — `GET /api/analysis/stream` (WebSocket upgrade; present when the server has
a runner). Chosen over SSE because the client must send a request and then _stop_ or replace it
while the connection stays open (stepping through a Match's Positions), which SSE (one-way,
request fixed in the URL, cancel only by dropping the connection) cannot do without a second
HTTP call; a WebSocket is also the transport the Match stream already needs.

Client to server (a message over 16 KiB is answered with `invalid-request`):

- `{ "type": "start", "id"?, "gameId", "engineId", "position", "limits"? }` — analyse `position`
  (the Game's Notation) with that Game's Engine; `limits` is `{ maxDepth?, maxTimeMs?, lines? }`
  as for an Engine Seat (`lines` = how many best Lines; unset `maxTimeMs` is the server default,
  capped at 60 s). `id` is an optional client string (<= 100 chars) echoed in every reply about
  this search. One search per connection: any `start` while one runs **replaces** it, even one
  that is then rejected with an `error` (the old search is cancelled and sends nothing more, not
  even `stopped`).
- `{ "type": "stop" }` — cancel the running search, if any.

Server to client:

| `type`     | Fields                            | Meaning                                                                                                                                                                                                                    |
| ---------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analysis` | `id?`, `analysis`                 | One `Analysis<string>` (`depth`, `lines` with `moves` in Notation and a `Score`), in the Engine's order, depth strictly increasing. A Position with a pending Chance event has no Lines but `score` and `seat` (ADR 0005). |
| `done`     | `id?`                             | The Engine finished (its limits were reached); nothing more for this search.                                                                                                                                               |
| `stopped`  | `id?`                             | Answer to `stop` (always sent, even with nothing running; `id` of the cancelled search if any).                                                                                                                            |
| `error`    | `id?`, `error: { code, message }` | The `start` was rejected or the search failed; no search runs afterwards (a rejected `start` also cancelled the previous one), the socket stays open.                                                                      |

Error codes: `invalid-request` (not JSON, not an object, unknown `type`, bad or extra fields,
bad `limits`, binary or oversized message), `unknown-game`, `unknown-engine`, `invalid-position`
(`position` does not decode), `busy` (the shared runner's Analysis queue is full, see
`engine-runner.ts`; retry later), and the runner's `timeout`, `engine-error`, `worker-error`,
`unreadable-reply` (details are only logged), plus `internal`. Analysis requests go through the
server's one `EngineRunner` with purpose `analysis`, so they never starve Engine Seats.

**Cancellation:** `stop`, a replacing `start` and a closed socket all abort the runner's search,
which stops the Engine (its Worker is terminated) and frees its slot at once.

## Open questions

Track these here until resolved (then record an ADR in `docs/adr/` if it meets the bar):

- Identity of human Players: per-Seat seat tokens for now (no accounts); accounts/sessions later?
- Time controls.
