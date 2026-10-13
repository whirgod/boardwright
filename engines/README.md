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
- No transposition table yet; add one (keyed by `Notation.encodePosition`) when a Game's
  Engine shows it pays off.
