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
packages/core     contracts: GameRules, Notation, Engine, Analysis (no deps)
packages/testing  contract test kit for Games (assertGameRulesContract)
apps/server       Hono API + host of the web UI
apps/web          (planned) browser UI
games/<id>        one GameRules package per Game     (@boardwright/game-<id>)
engines/<algo>    Engine library, Game-agnostic       (@boardwright/engine-<algo>, e.g. minimax)
engines/<game>-<name>  one Engine per Game (library + evaluation)  (@boardwright/engine-<game>-<name>)
```

Dependencies flow `core <- games <- engines <- server`; never import the server from a Game or Engine.
`testing` depends only on `core` (+ `@std/assert`) and is used only by Games' tests.

## Commands

Deno 2.x; tasks are defined in `deno.json` (no npm, no `node_modules`).

- `deno task check` — `fmt --check`, `lint`, `check`, `test` + coverage thresholds (`deno.json`);
  must pass before committing. CI runs it on every PR; `main` requires it to pass.
- `deno task dev:server` — run the server with watch mode on port 3000
- `scripts/claude-usage.sh [--gate N]` — Claude plan usage snapshot (see `docs/WORKFLOW.md`)
- `deno add jsr:<pkg>` / `npm:<pkg>` in the member that needs it; prefer JSR packages

## Conventions

- Deno workspace (ADR 0001): every member has a `deno.json` with `name`, `version`,
  `exports`. Import local files with the `.ts` extension; no build step.
- Every Game runs `assertGameRulesContract` from `@boardwright/testing` in its tests (`games/README.md`).
- Tests use `Deno.test` + `@std/assert`, next to code as `*.test.ts`. Entry points (`main.ts`)
  are excluded from coverage; keep them thin.
- Grant minimal permissions in tasks (`--allow-net`, scoped `--allow-env=...`), never `-A`.
- Games are pure and deterministic. The server is the only authority over Match state (ADR 0002).
- Use `GLOSSARY.md` terms (Match, not "game instance"; Position, not "board state"; Seat, not "color").
- All changes land via PR (template in `.github/`); squash-merge.
- Update `docs/ROADMAP.md` when finishing or re-ordering roadmap work; record hard-to-reverse,
  surprising trade-offs as ADRs in `docs/adr/`.
- Look up library/tool docs with the `find-docs` skill rather than relying on memory.

## Agent skills

Project skills live in `.agents/skills/` (symlinked into `.claude/skills/`), pinned in
`skills-lock.json`; restore with `npx skills experimental_install`. Installed: `domain-modeling`,
`grilling`, `grill-with-docs`, `codebase-design`, `improve-codebase-architecture`, `find-docs`.
