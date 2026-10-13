# Boardwright

A game master host for engines of simple rule-based board games — chess, checkers,
nine men's morris, backgammon. The server referees Matches, exposes an API for client
applications, and serves a web UI where you can review games, play against an Engine or
another human, and see Engine analysis (evaluation and best Lines) on the board.

> Status: early scaffold. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Quick start

Requires [Deno](https://deno.com) 2.x.

```sh
deno task check        # fmt + lint + typecheck + tests
deno task dev:server   # http://127.0.0.1:3000/api/health
```

## Docs

- [Vision](docs/VISION.md) — what we're building and why
- [Architecture](docs/ARCHITECTURE.md) — layout, dependency rules, planned API
- [Roadmap](docs/ROADMAP.md) — done / next
- [Glossary](GLOSSARY.md) — domain language
- [ADRs](docs/adr/) — decisions
- [AGENTS.md](AGENTS.md) — instructions for AI coding agents
