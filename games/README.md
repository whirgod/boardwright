# Games

One workspace member per Game: `games/<game-id>/` with a `deno.json` named `@boardwright/game-<game-id>`, implementing
`GameRules` (and its `Notation`) from `@boardwright/core`. Pure and deterministic: no I/O,
no hidden randomness. See `docs/ARCHITECTURE.md`.
