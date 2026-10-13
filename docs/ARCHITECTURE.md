# Architecture

Current state is a scaffold; sections marked _planned_ describe intent, not code.

## Layout

```
packages/core     Game-agnostic contracts: GameRules, Notation, Engine, Analysis
apps/server       Hono server: HTTP API (+ planned WebSocket) and host of the web UI
apps/web          (planned) Browser UI: board rendering, play, review, analysis overlay
packages/testing  Contract test kit every Game runs (assertGameRulesContract)
games/<game>      One package per Game implementing GameRules (games/tic-tac-toe is the reference)
engines/<name>    (planned) One package per Engine implementing Engine, e.g. engines/chess-minimax
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
- An Engine depends on `core` and on the Game it plays (to generate moves while searching).
- The server composes Games and Engines; Games and Engines never import the server.

## Key ideas

- **The server is the referee.** It holds the authoritative Position of every Match and applies
  Moves via `GameRules.play` after checking `legalMoves`. Engines are just Players (or
  analysis providers) and are never trusted to change state.
- **Positions and Moves are opaque** outside their Game. Everything crossing a process or
  network boundary uses the Game's `Notation` (strings), so the server, API, storage and UI
  stay game-agnostic.
- **Analysis is a stream.** `Engine.analyze` yields progressively deeper `Analysis`
  (multiple `Line`s with a `Score`), which the server forwards to the UI for live overlays.
  "Best move" = first Move of the best Line once the search stops.
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
  - `onMatchChanged(listener)` runs listeners synchronously after every create and accepted Move
    (e.g. to schedule an Engine's Move or push to WebSocket clients); returns an unsubscribe.
- `players.ts` — `PlayerSpec`, a union discriminated by `kind` (today only `human`); new kinds
  such as `engine` extend it without reshaping requests, records or responses.
- `match-store.ts` — `MatchStore` interface + `InMemoryMatchStore`. Records hold Notation
  strings only (Move list, Outcome, Seats with token hashes, timestamps) and a `version` for
  optimistic concurrency. `match-store.contract.ts` is the contract test every store runs.
- `tokens.ts` — seat tokens: 256-bit random hex; only their SHA-256 is stored.
- `requests.ts` — hand-written validation of JSON bodies (no schema library: the bodies are
  tiny and errors stay in our shape).
- `app.ts` — Hono routes; maps `MatchError` codes to HTTP statuses. Request bodies on `/api/*`
  are capped (16 KiB, `bodyLimit`), POST bodies must be `Content-Type: application/json`, and
  client text echoed in error messages is truncated.

## API

Implemented (JSON; Positions and Moves are Notation strings):

- `GET  /api/health`, `GET /api/games`
- `POST /api/matches` `{ gameId, seats: { <seat>: { kind: "human" } } }` → `201`
  `{ match, tokens: { <seat>: <seat token> } }`. Seats must be exactly the Game's Seats.
  Tokens are returned only here.
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

- `GET  /api/games/:gameId/engines`; Seat kind `{ kind: "engine", engineId, limits }` (#7)
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
