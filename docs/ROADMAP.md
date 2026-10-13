# Roadmap

Ordered; keep it current. Check items off (and move details into docs/code) as they land.
Work items are tracked as GitHub issues (labels `wave:<n>`, `model:<size>`), see
[WORKFLOW.md](WORKFLOW.md).

## Done

- [x] Monorepo scaffold: Deno workspace, TypeScript, `deno fmt`/`lint`/`check`/`test`, CI
- [x] Draft contracts in `packages/core` (`GameRules`, `Notation`, `Engine`, `Analysis`)
- [x] Server skeleton: `/api/health`, `/api/games`
- [x] Reference Game tic-tac-toe + `GameRules` contract test kit (`@boardwright/testing`) (#2)
- [x] Server Match lifecycle for humans: create, play by seat token, referee (#6)
- [x] Game nine men's morris (`games/nine-mens-morris`) (#3)
- [x] Generic alpha-beta Engine library `@boardwright/engine-minimax` (#5)

## Next

Each step links its GitHub issues; waves run in order, tasks within a wave in parallel.

1. **First Games** — checkers (#4).
2. **Engines in play** — Engine Players in Matches, run in Web Workers (#7); morris and checkers
   Engines (#8).
3. **Live + UI** — WebSocket Match/Analysis streams (#9); web UI foundation served by the
   server (#10).
4. **Full experience + more Games** — morris/checkers renderers (#11), review mode and analysis
   overlay (#12), persistence (#13), chess rules (#14), backgammon rules + chance model (#15).
5. **Later** — chess Engine + renderer (#16), backgammon Engine + renderer (#17), external
   Engine protocol (#18).
