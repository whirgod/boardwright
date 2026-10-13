---
status: accepted
---

# Chance events: rolled by the Game master from a secret per-Match seed

Games stay pure and Matches replayable (ADR 0002) while dice remain unpredictable to Players and Engines. A Game with chance implements `ChanceGameRules`, an interface extending `GameRules`: it signals a pending Chance event (no Seat to move and no Outcome), lists the possible results with probabilities (`chanceEvents`), and applies one result (`resolveChance`); chance results are a distinct type from Moves with their own Notation. Games without chance implement plain `GameRules`, whose contract stays "no Seat to move ⇔ the Match is over"; code that must tell them apart uses a structural `hasChance` guard (works across worker boundaries). The support is generic rather than backgammon-specific. The Game master resolves a pending Chance event automatically and immediately (including backgammon's opening roll) through the referee's `apply`, drawing the n-th result deterministically from a secret per-Match seed that is stored only server-side and revealed once the Match has an Outcome; every result is also recorded in the Match's Move list, which holds Moves and Chance events in order.

## Considered Options

- **Seed in the Position** — pure and replayable, but Positions are public (Spectators, Engines, browsers), so anyone could compute future rolls.
- **Players submit their own rolls** — no fairness guarantee.
- **The Game rolls inside `play` from an injected random source** — Engines still need the result distribution to search, `play` would stop being a function of (Position, Move), and the opening roll has no Move to attach to.
- **Optional chance methods on `GameRules`** — would push the pending-chance exception into every Game's contract; rejected in favour of the extending interface.
- **Class inheritance (abstract base classes)** — forces Games to become classes, relies on `instanceof` (breaks across worker realms) and still leaves the branching on the consumer side.
- **Commit-reveal fairness proofs** — unnecessary while the server is the trusted Game master; revealing the seed after the Match gives after-the-fact verifiability for free.

## Consequences

- A Line ends at the next Chance event; `win-in`/`loss-in` Scores only when forced regardless of the dice.
- Analysis of a Position with a pending Chance event has no Lines and an expected Score (optional `score` on Analysis); the Engine contract allows it.
- Chance search lives in a separate Engine library (`engines/expectiminimax`) sharing a search harness with `engines/minimax`, so Games without chance are untouched and each library shows one algorithm. Structurally a `ChanceGameRules` is also a `GameRules`, so the minimax library must refuse Games with chance (type-level `chanceEvents?: never` and/or a runtime `hasChance` check), and the hosted catalog verifies Engine library and Game kind match.
- Contract kits split the same way: `assertChanceGameRulesContract` builds on `assertGameRulesContract`.
- Amendment (backgammon, #15): a Seat to move with no legal play gets an explicit empty Move (`pass`); resolving a Chance event never skips a turn, so a Seat to move always has a legal Move and each roll is followed by exactly one Move.
