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
- [x] Backgammon Engine (expectiminimax) + board renderer (#17)
- [x] Game master auto-plays a forced pass (#65)
- [x] External Engine protocol: out-of-process Engines over stdio (#18, ADR 0008)
- [x] Web UI: SAN in the Move list (#60); polish, accessible board state (#55)
- [x] Minimax transposition table: hash-Move ordering, score reuse, byte budget (#76)
- [x] Contract kit: decoded Positions must play identically (#78)
- [x] Minimax table: slot re-read test, lazy slots, 256 MiB default budget (#79)
- [x] Minimax Move ordering: captures-first hook (#81), killer Moves (#84), history heuristic (#85)
- [x] Minimax quiescence search (#88) with chess SEE and delta pruning (#95); check extensions (#89)
- [x] Expectiminimax transposition table; the table moved to the search harness (#82)
- [x] Transposition key supplied by the Game, leaving out history: chess, checkers, morris (#83, ADR 0009)

## Next

New work starts as GitHub issues (see [WORKFLOW.md](WORKFLOW.md)).

Engine search follow-ups, wave 11 (`wave:<n>` labels):

- [ ] Trustworthy `solved` results under a Transposition key (graph-history interaction) (#102)
- [ ] Chess SEE: pinned attackers and promoting recaptures (#103)
- [ ] Chess quiescence: knight underpromotions with check, no delta pruning of mating captures (#104)
