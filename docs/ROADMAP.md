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
- [x] Engine runner streaming Analysis (#34); hosted catalog of Games and Engines (#36)
- [x] Resignation (#31); morris/checkers renderers (#11); sandboxed Engine workers (#29, ADR 0006)
- [x] Chance events (ADR 0005): contract, kits, referee rolls, typed Move list (#15, part A)
- [x] Chess Engine + renderer (#16)
- [x] EngineDriver cache bounds, MatchStore liveness, chance roll cooldown (#46, #59)
- [x] Live Match stream and Analysis stream over WebSocket (#9)
- [x] Game backgammon (#15, part B)
- [x] Persistence in SQLite, Match listing (#13, ADR 0007)
- [x] Expectiminimax Engine library + shared search harness (#48)
- [x] Web UI review mode and Engine analysis overlay; play view follows the Match stream (#12)

## Next

Each step links its GitHub issues; waves run in order, tasks within a wave in parallel.

5. **Later** — backgammon Engine + renderer (#17), external Engine protocol (#18), auto-play a
   forced pass (#65), UI polish (#55), SAN in the Move list (#60).
