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

## Layout

```
packages/core   contracts: GameRules, Notation, Engine, Analysis (no deps)
apps/server     Fastify API + host of the web UI
apps/web        (planned) browser UI
games/<id>      one GameRules package per Game     (@boardwright/game-<id>)
engines/<name>  one Engine package per Engine      (@boardwright/engine-<game>-<name>)
```

Dependencies flow `core <- games <- engines <- server`; never import the server from a Game or Engine.

## Commands

- `npm install` — install all workspaces (Node >= 24, see `.nvmrc`)
- `npm run check` — typecheck (`tsc`) + tests (`vitest run`); must pass before committing
- `npm run dev:server` — run the server with watch mode on port 3000

## Conventions

- TypeScript run natively by Node; no build step. Use only erasable syntax (no `enum`,
  namespaces, or parameter properties) and import local files with the `.ts` extension.
- Packages export `./src/index.ts` directly. Tests live next to code as `*.test.ts`.
- Games are pure and deterministic. The server is the only authority over Match state (ADR 0002).
- Use `GLOSSARY.md` terms (Match, not "game instance"; Position, not "board state"; Seat, not "color").
- Update `docs/ROADMAP.md` when finishing or re-ordering roadmap work; record hard-to-reverse,
  surprising trade-offs as ADRs in `docs/adr/`.
- Look up library/tool docs with the `find-docs` skill rather than relying on memory.

## Agent skills

Project skills live in `.agents/skills/` (symlinked into `.claude/skills/`), pinned in
`skills-lock.json`; restore with `npx skills experimental_install`. Installed: `domain-modeling`,
`grilling`, `grill-with-docs`, `codebase-design`, `improve-codebase-architecture`, `find-docs`.
