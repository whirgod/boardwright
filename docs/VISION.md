# Vision

Boardwright is a **game master host for engines of simple, rule-based board games**:
chess, checkers (draughts), nine men's morris, backgammon, and similar games.

## Goal

One server that:

1. **Referees Matches.** It owns the authoritative rules of every Game it hosts, validates
   every Move, and decides the Outcome. Players (human or Engine) never mutate state directly.
2. **Exposes an API** that client applications use to create and join Matches, submit Moves,
   follow Matches live, and request Engine analysis.
3. **Serves a web UI** that visualizes Games, where a human can:
   - **review** finished or ongoing Matches move by move,
   - **play** against an Engine (AI) or against another human,
   - **see Engine analysis**: evaluation of the current Position and the best Lines
     (principal variations), drawn on the board.
4. **Hosts multiple Engines per Game**, so Engines can be swapped, compared, and played
   against each other.

The repository is a **monorepo**: the server, the web UI, the game rules, and the Engine
implementations live together and share one set of contracts (`packages/core`).

## Non-goals (for now)

- Real-money play, accounts with payments, ranking/matchmaking at scale.
- Games with hidden information, or with more than two Seats or non-zero-sum Outcomes (ADR 0003).
  Backgammon's dice (chance) **is** in scope.
- Competing with dedicated engines (Stockfish et al.) on strength. Engines here are
  for play, teaching, and experimentation. Plugging in external strong engines later is welcome.

## Users

- **Players** in the browser: play, review, analyze.
- **Client application developers**: drive Matches via the API (bots, other front-ends).
- **Engine authors**: add a new Engine or a new Game to the monorepo.

## Success looks like

- Adding a new Game means implementing one `GameRules` package plus a board renderer;
  the server, API, and review/analysis UI work for it without game-specific changes.
- Adding a new Engine for an existing Game means implementing one `Engine`;
  it appears in the UI as an opponent and as an analysis source.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the shape of the system and
[ROADMAP.md](ROADMAP.md) for what is done and what comes next.
