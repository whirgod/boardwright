---
status: accepted
---

# Chance events: rolled by the Game master from a secret per-Match seed

Games stay pure and Matches replayable (ADR 0002) while dice remain unpredictable to Players and Engines. A Game with chance signals a pending Chance event (no Seat to move and no Outcome), lists the possible results with probabilities (`chanceEvents`), and applies one result (`resolveChance`); chance results are a distinct type from Moves and the methods are optional, so the support is generic rather than backgammon-specific. The Game master resolves a pending Chance event automatically and immediately (including backgammon's opening roll) through the referee's `apply`, drawing the n-th result deterministically from a secret per-Match seed that is stored only server-side and revealed once the Match has an Outcome; every result is also recorded in the Match's Move list, which holds Moves and Chance events in order.

## Considered Options

- **Seed in the Position** — pure and replayable, but Positions are public (Spectators, Engines, browsers), so anyone could compute future rolls.
- **Players submit their own rolls** — no fairness guarantee.
- **The Game rolls inside `play` from an injected random source** — Engines still need the result distribution to search, `play` would stop being a function of (Position, Move), and the opening roll has no Move to attach to.
- **Commit-reveal fairness proofs** — unnecessary while the server is the trusted Game master; revealing the seed after the Match gives after-the-fact verifiability for free.

## Consequences

- A Line ends at the next Chance event; `win-in`/`loss-in` Scores only when forced regardless of the dice.
- Analysis of a Position with a pending Chance event has no Lines and an expected Score (optional `score` on Analysis); the Engine contract allows it.
- Chance search lives in a separate Engine library (`engines/expectiminimax`) sharing a search harness with `engines/minimax`, so Games without chance are untouched and each library shows one algorithm.
