# Engines

Two kinds of workspace members live here. Both may depend on `@boardwright/core`; never on the
server. See `docs/ARCHITECTURE.md`.

- **Engine libraries** — `engines/<algorithm>/`, named `@boardwright/engine-<algorithm>`.
  Game-agnostic search over any `GameRules`; depend only on `core` (Games only in tests).
- **Engines** — `engines/<game-id>-<engine-name>/`, named
  `@boardwright/engine-<game-id>-<engine-name>`, implementing `Engine` for one Game. Usually
  they compose an Engine library with a Game-specific evaluation.

## `engines/minimax` (`@boardwright/engine-minimax`)

Negamax with alpha-beta and iterative deepening for two-Seat, zero-sum Games:

```ts
import { createMinimaxEngine } from "@boardwright/engine-minimax";
export const engine = createMinimaxEngine({
  rules: myRules,
  name: "minimax",
  // Heuristic value from the perspective of the Seat to move.
  evaluate: (position) => material(position),
});
```

- `analyze` yields one `Analysis` per completed depth; an interrupted depth is never yielded.
- Limits: `maxDepth`, `maxTimeMs` (depth 1 always completes), `lines` (multi-PV), and the
  `AbortSignal`. Without limits it stops once the tree is solved.
- Forced results are `win-in` / `loss-in` Scores counted in plies (faster wins and slower
  losses preferred); draws score `value: 0`. Evaluations are clamped to `±MAX_EVALUATION`.
- A Seat may move several times in a row; perspective flips only when the Seat to move changes.
- Games with chance are refused (ADR 0005): `rules` is typed `GameRulesWithoutChance`, and
  `createMinimaxEngine` throws a `TypeError` for rules that pass `hasChance`. Chance search
  belongs in its own Engine library (planned `engines/expectiminimax`).
- No transposition table yet; add one (keyed by `Notation.encodePosition`) when a Game's
  Engine shows it pays off.

## Game Engines

Each composes `engines/minimax` with a heuristic evaluation (from the Seat to move) and exports
`rules` and `engine`. The trees are too large to solve: pass `maxDepth` and/or `maxTimeMs`.

- `engines/tic-tac-toe-minimax`: neutral evaluation; the Game is solved outright.
- `engines/nine-mens-morris-minimax`: material (board + hand) dominates; closed mills, blocked
  opponent pieces and two-in-a-row mill threats refine it. Flying Seats are never "blocked".
- `engines/checkers-minimax`: man 100, king 160, plus small bonuses for advancement, back-row
  guards and central squares.
