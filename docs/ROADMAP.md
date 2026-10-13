# Roadmap

Ordered; keep it current. Check items off (and move details into docs/code) as they land.

## Done

- [x] Monorepo scaffold: npm workspaces, TypeScript (run natively by Node, `tsc` for typecheck only), Vitest, CI
- [x] Draft contracts in `packages/core` (`GameRules`, `Notation`, `Engine`, `Analysis`)
- [x] Server skeleton: `/api/health`, `/api/games`

## Next

1. **First Game end-to-end** — nine men's morris (small, no chance, non-trivial phases) in
   `games/nine-mens-morris`. Validates the `GameRules` contract; adjust `core` as needed.
2. **First Engine** — generic minimax/alpha-beta over `GameRules` (with a per-Game
   evaluation function), streaming `Analysis` with multi-PV.
3. **Match lifecycle in the server** — create Match, seat humans/Engines, submit Moves,
   referee, Outcome; in-memory store.
4. **Live updates** — WebSocket stream for Moves and Analysis.
5. **Web UI (`apps/web`)** — board rendering, play vs human/Engine, review with move list,
   analysis overlay (evaluation + best Lines as arrows/highlights). Served by the server.
6. **More Games** — checkers, chess, backgammon (resolve the chance question first).
7. **Persistence** — store Matches for later review.
8. **External Engine protocol** — let Engines run out-of-process / in other languages.
