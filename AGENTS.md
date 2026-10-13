# AGENTS.md

## Keeping this file current

**It is your responsibility (the agent's) to keep this file concise and up to date.** Whenever a
change adds, changes, or removes something this file describes — layout, commands, tooling,
conventions, workflow — update AGENTS.md **in the same change set**. Do not defer it to a follow-up.
Keep it short: link to `docs/` instead of duplicating them.

## What this project is

Boardwright is a game master host for engines of simple rule-based board games (chess, checkers,
nine men's morris, backgammon). The server referees Matches, offers an API to client applications,
and serves a web UI to review Matches, play against an Engine or a human, and visualize Engine
analysis (evaluation + best Lines). Monorepo: server, web UI, Games and Engines together.

Read before substantial work:

- `docs/VISION.md` — goal, scope, non-goals
- `docs/ARCHITECTURE.md` — layout, dependency rules, planned API, open questions
- `docs/ROADMAP.md` — what's done and what's next (pick up work from here)
- `GLOSSARY.md` — domain language; use these terms in code and docs
- `docs/adr/` — decisions and why

**Large, open-ended tasks** (e.g. "work through the roadmap"): follow the multi-agent
workflow in [`docs/WORKFLOW.md`](docs/WORKFLOW.md) — coordinator, implementer subagents in
worktrees, PRs, reviews on GitHub, fix loop, usage-limit checkpoints. Tasks are GitHub issues.

## Layout

```
packages/core     contracts: GameRules (+ ChanceGameRules), Notation, Engine, Analysis (no deps)
packages/testing  contract test kits: Games (assertGameRulesContract / assertChanceGameRulesContract),
                  Engines (assertEngineContract); diceRace, a tiny Game with chance for tests
apps/server       Hono API (+ WebSocket Match and Analysis streams) + host of the web UI
apps/web          browser UI: Preact, bundled to apps/web/dist (ADR 0004)
games/<id>        one GameRules package per Game     (@boardwright/game-<id>)
engines/search    shared search harness (iterative deepening, limits, multi-PV, score scale)
engines/<algo>    Engine library, Game-agnostic       (@boardwright/engine-<algo>: minimax,
                  expectiminimax for Games with chance); algorithm only, plumbing in engines/search
engines/<game>-<name>  one Engine per Game (library + evaluation)  (@boardwright/engine-<game>-<name>)
```

Dependencies flow `core <- games <- engines <- server`; never import the server from a Game or Engine.
`apps/web` imports only `core` and Games (to decode Positions for its board renderers), never the server.
`testing` depends only on `core` (+ `@std/assert`) and is used only by Games' tests.

## Commands

Deno >= 2.5; tasks are defined in `deno.json` (npm packages via `npm:` specifiers, no `node_modules`).

- `deno task check` — `fmt --check`, `lint`, `check`, `test` + coverage thresholds (`deno.json`);
  must pass before committing. CI runs it on every PR; `main` requires it to pass.
- `deno task dev` — rebuild the web UI on change and run the server in watch mode; open
  http://127.0.0.1:3000 (`dev:web` / `dev:server` run one side only)
- `deno task start` — build the web UI (`build:web`), then run the server
- `scripts/claude-usage.sh [--gate N]` — Claude plan usage snapshot (see `docs/WORKFLOW.md`)
- `deno add jsr:<pkg>` / `npm:<pkg>` in the member that needs it; prefer JSR packages

## Conventions

- Deno workspace (ADR 0001): every member has a `deno.json` with `name`, `version`,
  `exports`. Import local files with the `.ts` extension; no build step (except the web UI bundle).
- Every Game runs `assertGameRulesContract` from `@boardwright/testing` in its tests (`games/README.md`).
- Every Engine runs `assertEngineContract` from `@boardwright/testing` in its tests (checks the `Engine.analyze` guarantees).
- Tests use `Deno.test` + `@std/assert`, next to code as `*.test.ts`. Entry points (`main.ts`)
  are excluded from coverage; keep them thin.
- Web UI: logic goes in DOM-free `.ts` modules with tests; `.tsx` components stay thin (only
  modules a test loads count toward coverage). A Game's board is a `BoardRenderer` in
  `apps/web/src/renderers/` (see `docs/ARCHITECTURE.md`).
- Grant minimal permissions in tasks (`--allow-net`; tests only `--allow-net=127.0.0.1`, scoped `--allow-env=...`/`--allow-read=...`; Engine Workers need the read grant), never `-A`.
- Games are pure and deterministic. The server is the only authority over Match state (ADR 0002).
- Engine workers are sandboxed (ADR 0006): read of `packages/ games/ engines/` only; root `deno.json`
  enables `unstable: ["worker-options"]`. Test Engines load via `testWorkerAdapter()`.
- Use `GLOSSARY.md` terms (Match, not "game instance"; Position, not "board state"; Seat, not "color").
- All changes land via PR (template in `.github/`); squash-merge.
- Update `docs/ROADMAP.md` when finishing or re-ordering roadmap work; record hard-to-reverse,
  surprising trade-offs as ADRs in `docs/adr/`.
- Look up library/tool docs with the `find-docs` skill rather than relying on memory.

## Agent skills

Project skills live in `.agents/skills/` (symlinked into `.claude/skills/`), pinned in
`skills-lock.json`; restore with `npx skills experimental_install`. Installed: `domain-modeling`,
`grilling`, `grill-with-docs`, `codebase-design`, `improve-codebase-architecture`, `find-docs`.
