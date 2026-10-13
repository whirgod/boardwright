# Engines

One workspace member per Engine: `engines/<game-id>-<engine-name>/` with a `deno.json` named
`@boardwright/engine-<game-id>-<engine-name>`, implementing `Engine` from `@boardwright/core`.
May depend on `@boardwright/core` and the Game it plays; never on the server.
See `docs/ARCHITECTURE.md`.
