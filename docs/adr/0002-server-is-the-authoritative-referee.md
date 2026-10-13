---
status: proposed
---

# The server referees every Match; Games are pure and Engines are untrusted Players

The server holds the authoritative Position of every Match and applies a Move only after checking it against the Game's `legalMoves`. Games are pure, deterministic `GameRules` implementations so Matches can be replayed from their Move list and reviewed exactly. Engines are treated like any other Player (or as analysis providers) and never mutate Match state. Positions and Moves cross process and network boundaries only as Notation strings, keeping the server, API, storage and UI game-agnostic.
