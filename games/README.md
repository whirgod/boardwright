# Games

One workspace member per Game: `games/<game-id>/` with a `deno.json` named `@boardwright/game-<game-id>`, implementing
`GameRules` (and its `Notation`) from `@boardwright/core`. Pure and deterministic: no I/O,
no hidden randomness. See `docs/ARCHITECTURE.md`.

## Reference Game

`games/tic-tac-toe` is the smallest complete Game; copy its shape. Contract decisions it
fixes for all Games:

- `play` **throws** on an illegal Move (not in `legalMoves`) and never mutates its input.
- `decodePosition` / `decodeMove` **throw** on invalid text.
- `toMove` is `undefined` exactly when `outcome` is defined (or, for a Game with chance, a
  Chance event is pending); terminal Positions have no legal Moves.

## Contract test kit

Every Game **must** run the shared kit from its tests (`@boardwright/testing`):

```ts
import { assertGameRulesContract } from "@boardwright/testing";
Deno.test("satisfies the GameRules contract", () => {
  assertGameRulesContract(myRules, { seed: 1, playouts: 200 });
});
```

It plays seeded random Matches and checks: `toMove`/`outcome` consistency, legal Moves in
non-terminal and none in terminal Positions, `play` not mutating its input, Position and Move
Notation round-trips, `decode*` throwing on garbage (extend with `garbage: [...]`), and replay
determinism. A decoded Position must play identically (same Seat, Outcome and legal Moves in
the same order), so `encodePosition` must include all play-relevant state. Failures print the seed and the Move list. Add game-specific rule tests next to it.

If the Position carries earlier play that only decides draws (repetition history, move clocks),
supply the optional `transpositionKey(position)` without it (ADR 0009), so Engines'
transposition tables recognise Move orders that reach the same Position. The kit then checks it
too: total and stable, the same for a decoded Position; Positions that share it have the same
Outcome unless it is a draw; and those without an Outcome have the same Seat to move, legal Moves
in the same order and Chance events, and each Move leads to Positions that share a key again.
Random playouts reach many such Positions (at least `minTranspositions`, default 1, must be
found), but rarely the fields that only matter now and then (castling rights, en passant, pieces
in hand): pass Positions that differ only in them as `keyPositions`, so a key that drops one is
caught (chess and nine men's morris do).

A Game with chance (dice, ADR 0005) implements `ChanceGameRules` (`chanceEvents`,
`resolveChance`, `encodeChance`/`decodeChance`) and runs `assertChanceGameRulesContract`
instead: the same checks with Chance events resolved at random by their probabilities, plus
identical `chanceEvents` for decoded Positions, probabilities summing to 1, every result resolving, nothing pending or resolvable outside a
pending Chance event, and replay through Chance events (shown as `[result]` in failures).
`diceRace` from `@boardwright/testing` is the smallest example; `games/backgammon` is the
real one.
