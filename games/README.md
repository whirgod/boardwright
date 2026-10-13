# Games

One workspace member per Game: `games/<game-id>/` with a `deno.json` named `@boardwright/game-<game-id>`, implementing
`GameRules` (and its `Notation`) from `@boardwright/core`. Pure and deterministic: no I/O,
no hidden randomness. See `docs/ARCHITECTURE.md`.

## Reference Game

`games/tic-tac-toe` is the smallest complete Game; copy its shape. Contract decisions it
fixes for all Games:

- `play` **throws** on an illegal Move (not in `legalMoves`) and never mutates its input.
- `decodePosition` / `decodeMove` **throw** on invalid text.
- `toMove` is `undefined` exactly when `outcome` is defined; terminal Positions have no legal Moves.

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
determinism. Failures print the seed and the Move list. Add game-specific rule tests next to it.
Add `"@boardwright/testing": "../../packages/testing/src/mod.ts"` to the Game's `deno.json` imports.
