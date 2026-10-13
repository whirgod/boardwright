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
- [x] Game checkers (English draughts), `@boardwright/game-checkers` (#4)
- [x] Contract kit: bounded illegal-Move probing (#24)
- [x] Engine Players in Matches, run in Web Workers; tic-tac-toe Engine (#7)
- [x] Engines for nine men's morris and checkers (#8); Engine contract kit (#35); glossary drift (#37)
- [x] Referee applies every Match change; structured Outcomes; versioned Match events (#33)
- [x] Web UI foundation (Preact, bundled by Deno), served by the server (#10)
- [x] Game chess (#14)

## Next

Each step links its GitHub issues; waves run in order, tasks within a wave in parallel.

3. **Deepen before building on it** (architecture review 2026-10-13) — Engine runner streaming
   Analysis (#34); hosted catalog of Games and Engines (#36).
4. **Live + more Games** — Match/Analysis streams (#9), morris/checkers renderers (#11),
   persistence (#13), Chance events (ADR 0005) + backgammon rules (#15), sandboxed Engine
   workers (#29), Resignation (#31), EngineDriver cache bounds and store liveness (#46).
5. **Later** — review mode and analysis overlay (#12), chess Engine + renderer (#16), expectiminimax
   Engine library (#48), backgammon Engine + renderer (#17), external Engine protocol (#18).
