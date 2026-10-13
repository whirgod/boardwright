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

## Planned API surface (sketch, not final)

- `GET  /api/health`, `GET /api/games` — _implemented_
- `GET  /api/games/:gameId/engines`
- `POST /api/matches` (game, seats → human / engine), `GET /api/matches/:id`
- `POST /api/matches/:id/moves` (Move in Notation)
- `WS   /api/matches/:id/stream` — Moves, Outcome, live Analysis
- `POST /api/analysis` (game, Position, engine, limits) → stream of Analysis

## Open questions

Track these here until resolved (then record an ADR in `docs/adr/` if it meets the bar):

- Chance (backgammon dice): model rolls as Moves by a "chance" Seat, or as part of `play`
  with an injected random source? Must keep Games deterministic and Matches replayable.
- Persistence for Matches (in-memory → SQLite?).
- Web UI framework and board rendering approach (SVG per Game?).
- Identity of human Players (anonymous session tokens first?).
- Time controls.
