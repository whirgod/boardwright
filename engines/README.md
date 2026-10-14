# Engines

Two kinds of workspace members live here. Both may depend on `@boardwright/core`; never on the
server. See `docs/ARCHITECTURE.md`.

- **Engine libraries** — `engines/<algorithm>/`, named `@boardwright/engine-<algorithm>`.
  Game-agnostic search over any `GameRules`; depend only on `core` and the search harness
  (Games only in tests). Each module is one algorithm, documented for learning.
- **Engines** — `engines/<game-id>-<engine-name>/`, named
  `@boardwright/engine-<game-id>-<engine-name>`, implementing `Engine` for one Game. Usually
  they compose an Engine library with a Game-specific evaluation.

## `engines/search` (`@boardwright/engine-search`)

The search harness the Engine libraries share (ADR 0005): the plumbing that is not the
algorithm. Depends only on `core` and knows nothing about chance.

- `validateLimits` — the `SearchLimits` contract (`RangeError`).
- `iterativeDeepening(limits, signal, searchDepth)` — runs depth 1, 2, ... and yields each
  completed depth's Analysis; honours `maxDepth`, `maxTimeMs` (depth 1 always completes) and
  the `AbortSignal`, stops once a depth is `solved`, and pauses for the event loop every few ms.
  A depth is a synchronous generator (`Search<T>`) that `yield`s every `NODES_PER_TICK` nodes
  (`createNodeCounter`), so the driver can pause or stop it.
- `rankRootMoves` / `toLines` — multi-PV bookkeeping at the root.
- Score scale: `MATE`, `MATE_BOUND`, `MAX_EVALUATION`, `terminalScore`, `horizonScore`
  (clamp, NaN check), `toScore`.

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
  belongs in `engines/expectiminimax`.
- No transposition table yet; add one (keyed by `Notation.encodePosition`) when a Game's
  Engine shows it pays off.

## `engines/expectiminimax` (`@boardwright/engine-expectiminimax`)

Expectiminimax for two-Seat, zero-sum Games with chance (`ChanceGameRules`, ADR 0005), e.g.
backgammon. Same limits and streaming as minimax; the module doc explains the algorithm.

```ts
import { createExpectiminimaxEngine } from "@boardwright/engine-expectiminimax";
export const engine = createExpectiminimaxEngine({
  rules: myChanceRules,
  name: "expectiminimax",
  // Heuristic value from `seat`'s perspective; may be a Position with a pending Chance event.
  evaluate: (position, seat) => pipLead(position, seat),
  // Required: a certain win on the evaluation's scale; evaluations are clamped to ±winValue.
  winValue: 1000,
});
```

- Decision nodes: negamax + alpha-beta. Chance nodes: the probability-weighted average over
  `chanceEvents`, each result searched with a full window (no Star1-style chance pruning).
- Depth counts Moves; resolving a Chance event is free. At the horizon a pending Chance event
  is evaluated as is (not rolled).
- Lines end at the next Chance event. While one is pending at the root, every Analysis is
  `{ depth, lines: [], score, seat }`; `seat` is the Seat that moves after the roll when all
  results agree, otherwise the Game's first Seat.
- `win-in` / `loss-in` only when forced whatever the dice (counting the slowest result); in a
  mixed average a forced win counts as `+winValue`, a loss as `-winValue`. Averages need
  _cardinal_ evaluations (e.g. expected points), unlike minimax, which only compares them.
- A pending Position without `chanceEvents` (a Game bug) throws a descriptive `TypeError`.
- Games without chance are refused with a `TypeError` (use minimax).

## Game Engines

Each composes an Engine library with a heuristic evaluation and exports `rules` and `engine`:
`engines/minimax` (evaluation from the Seat to move) for Games without chance,
`engines/expectiminimax` for Games with chance. The trees are too large to solve: pass
`maxDepth` and/or `maxTimeMs`.

- `engines/tic-tac-toe-minimax`: neutral evaluation; the Game is solved outright.
- `engines/nine-mens-morris-minimax`: material (board + hand) dominates; closed mills, blocked
  opponent pieces and two-in-a-row mill threats refine it. Flying Seats are never "blocked".
- `engines/checkers-minimax`: man 100, king 160, plus small bonuses for advancement, back-row
  guards and central squares.
- `engines/chess-minimax`: material (P100 N320 B330 R500 Q900) plus piece-square tables from
  Michniewski's Simplified Evaluation Function (cited in the source), with the king table
  switching to an endgame table. The library has no move-ordering hook yet, so search is plain
  alpha-beta; use `maxDepth` (3-4) or `maxTimeMs`.
- `engines/backgammon-expecti`: expectiminimax with a readable evaluation in pips (pip count,
  borne-off and bar checkers, blots within the Opponent's reach, made points, home-board points)
  squashed by `tanh` into (-1, 1), `winValue` 1; gammons are not valued. Searches without
  `maxDepth` stop at depth 2 (a few hundred ms; depth 3 takes about half a minute), even with a
  `maxTimeMs` (which the server always sets): `maxTimeMs` alone never deepens. Deeper searches
  need an explicit `maxDepth`, still bounded by `maxTimeMs`.
