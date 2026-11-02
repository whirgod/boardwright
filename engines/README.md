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
- `@boardwright/engine-search/table` (`src/table.ts`) — the transposition table both libraries
  use, one per `analyze` call: `createTranspositionTable(budget)` (a memory budget in bytes,
  `DEFAULT_TABLE_BYTES` = 256 MiB, `checkTableBytes`; details in the minimax section), entries
  with the best Move's index (the hash Move), the score, its bound and the depth searched
  (Infinity when no horizon was hit), and the mate-distance conversion `toTableScore` /
  `fromTableScore` (forced results are stored counted from the Position, which may recur at
  another ply). It only stores and finds entries: whose perspective a score takes and when it
  may answer a visit is up to the library. `tableKey(rules)` is the key both libraries use:
  the Game's Transposition key (`GameRules.transpositionKey`, ADR 0009) if it supplies one,
  else `Notation.encodePosition`.

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
- Quiescence search (`src/quiescence.ts`), with the optional Engine-supplied `quiescence`
  option: at the horizon the search goes on with the tactical Moves until the Position is quiet,
  instead of evaluating it mid-exchange (the horizon effect). `standPat(position)`: may the Seat
  to move decline them all and take the evaluation (a lower bound)? Return false where it may
  not (chess: in check; checkers: a capture is compulsory); every legal Move is searched there.
  `tactical(position, move)` picks the Moves (default `movePriority` > 0, none without it), in
  `movePriority` order. `maxPlies` caps the plies past the horizon (`DEFAULT_QUIESCENCE_PLIES` =
  16; RangeError unless an integer >= 0); at the cap a Position is evaluated as it stands.
  Quiescence Moves count as nodes (time limits and aborts interrupt them), their results are not
  stored in the table, and Lines include them, so a Line may be longer than the nominal `depth`.
  `gain(position, move)` (optional) is an upper bound on what a tactical Move can win beyond
  standing pat: where standing pat is allowed, a Move with `evaluate + gain <= alpha` is skipped
  (delta pruning; never in a Position that refuses stand pat, never at the cap, `Infinity` never
  prunes; a skipped Move still counts with its bound, so a fail-low result stays an upper bound).
  The bound is heuristic and does not cover mates: a skipped capture that would mate is a
  depth-limited weakness at the horizon, never a false forced result.
  Standing pat counts as a horizon (so the depth is not `solved`); a quiescence subtree that ends
  only in Outcomes does not. Forced results found in quiescence count their plies from the root;
  they are real wins, but a quiet Move past the horizon might win sooner. Without the option, a
  Position at the horizon is evaluated as it stands.
- Search extensions, with the optional Engine-supplied `extend(position)`: true for a non-terminal
  child Position that deserves one more ply (chess: the Seat to move is in check), which is then
  searched one ply deeper than the nominal depth, in the same iteration, so a forced sequence just
  past the horizon is seen. Applies in the main search only (never inside quiescence); at most
  `maxExtensions` per path from the root (`DEFAULT_MAX_EXTENSIONS` = 4; RangeError unless an
  integer >= 0), which bounds the tree in Games with endless checks. The table stores the depth
  actually searched, so a shallower entry never answers a probe that needs the extra ply.
  Without the option, the search is exactly as before.
- Games with chance are refused (ADR 0005): `rules` is typed `GameRulesWithoutChance`, and
  `createMinimaxEngine` throws a `TypeError` for rules that pass `hasChance`. Chance search
  belongs in `engines/expectiminimax`.
- Transposition table (`@boardwright/engine-search/table`), keyed by `tableKey(rules)` (the
  Game's Transposition key, else `Notation.encodePosition`):
  tries the best Move of the previous depth first (hash Move) and reuses stored scores where
  sound (searched at least as deep, bound settles the window, forced results counted from the
  Position, a stored horizon still counts against `solved`). Scores inside the window are
  searched again, so PVs stay complete. A stored deeper result may let a depth see further than a
  plain search of that depth.
- Move ordering: the hash Move first, then, with the optional Engine-supplied
  `movePriority(position, move)` (finite number, else RangeError), the rest by priority, highest
  first, the Game's order breaking ties; the root at depth 1 too. Convention (`src/ordering.ts`):
  priority > 0 is a tactical Move (capture, promotion), <= 0 a quiet one. Then the killer Moves:
  per ply, the last two quiet Moves that caused a beta cutoff (kept per depth, compared by
  `encodeMove` text, encoded lazily); then the history heuristic orders the other quiet Moves
  (equal priorities): a score per Seat and quiet Move, raised by beta cutoffs (depth squared),
  lowered for quiet Moves tried in vain, halved every depth, capped (65,536 entries). Its key is
  the `encodeMove` text unless the Engine supplies a cheaper `moveKey` (chess-minimax: squares). The hook runs once per Move at every interior node (once more for a Move that causes a cutoff); ordering never changes a value, only
  the node count.
- The key requirement is the Game's contract (checked by its contract kit): Positions without an
  Outcome that share a key have the same Seat to move and legal Moves in the same order (a
  stored Move is an index into `legalMoves`). An `encodePosition` key also fixes the Outcomes
  that follow (repetition history, move clocks). A Transposition key (`GameRules.transpositionKey`;
  chess, checkers and nine men's morris supply one) leaves out that earlier play, so Move orders
  that reach the same Position share entries. The search checks a Position's Outcome before it
  probes the table, so a draw by repetition is never answered from it, but a stored score may come
  from a path with other earlier play (graph-history interaction, accepted as in most engines:
  ADR 0009).
- One table per `analyze` call, bounded by a memory budget, the `tableBytes` option
  (`DEFAULT_TABLE_BYTES` = 256 MiB, 0 = no table; the server runs up to 4 searches at once, so
  the worst case is about 1 GiB). The table grows with the search (its slots are allocated on
  first use), so short searches stay small. It counts each entry as 160 bytes plus its key
  (V8 needs about 100-110 bytes plus the key). Keys are stored whole and an `encodePosition` key
  can be long: from a few dozen characters to about 2,000 in a quiet chess endgame with a long
  repetition history (a Transposition key leaves the history out). An entry
  that would exceed the budget is not stored; deeper entries win a slot, entries from earlier
  depths give way (also when the budget is full).

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
- Transposition table (`@boardwright/engine-search/table`), keyed by `Notation.encodePosition`,
  with the same key requirement as minimax (a pending Chance event must also list the same
  results). Decision nodes use it as minimax does: hash Move first, stored scores reused where
  sound, scores inside the window searched again so Lines stay complete. A Chance node stores
  its expected value (exact, as every result gets a full window, and with no Move), and any
  later visit searched at least as deep reuses it, as the Line ends there anyway. The value is
  stored for the Game's first Seat and negated for the other; that is exact without asking
  anything more of `evaluate`, since below a Chance event every horizon is evaluated for the
  Seat that just moved and every other value is negamax. Forced results are stored counted from
  the Position, an entry's depth counts Moves only, and a stored result that hit the horizon
  still counts against `solved`. A stored deeper result may let a depth see further than a plain
  search of that depth, so a depth may report a forced result that a deeper one finds faster.
- `tableBytes`: the table's memory budget, as in minimax (`DEFAULT_TABLE_BYTES` = 256 MiB per
  search, 0 = no table).
- Where a Chance event separates every two Moves (backgammon), alpha-beta prunes nothing: every
  decision node's children are Chance events, searched with a full window. The table then helps
  through transpositions only: different rolls (e.g. 61, 52 and 43) often lead to the same
  Position, whose next roll is valued once (5-9% fewer Moves at depth 3, see below).

## Game Engines

Each composes an Engine library with a heuristic evaluation and exports `rules` and `engine`:
`engines/minimax` (evaluation from the Seat to move) for Games without chance,
`engines/expectiminimax` for Games with chance. The trees are too large to solve: pass
`maxDepth` and/or `maxTimeMs`.

- `engines/tic-tac-toe-minimax`: neutral evaluation; the Game is solved outright.
- `engines/nine-mens-morris-minimax`: material (board + hand) dominates; closed mills, blocked
  opponent pieces and two-in-a-row mill threats refine it. Flying Seats are never "blocked". Move ordering: hash Move, then
  Moves that close a mill (`movePriority`; about -30% nodes at depth 6, -54% at depth 7).
- `engines/checkers-minimax`: man 100, king 160, plus small bonuses for advancement, back-row
  guards and central squares.
- `engines/chess-minimax`: material (P100 N320 B330 R500 Q900) plus piece-square tables from
  Michniewski's Simplified Evaluation Function (cited in the source), with the king table
  switching to an endgame table. Move ordering: the library's transposition table (hash Move), then
  captures by MVV-LVA (en passant included) and promotions (`movePriority`, about -43% to -77%
  nodes at depth 5, -32% to -97% at depth 6), then quiet Moves; chess keys include the move clocks
  and repetition history, so few transpositions share a key; use `maxDepth` (4-5) or `maxTimeMs`.
  Quiescence search (`quiescence`): captures (en passant included) and queen promotions past the
  horizon, no stand pat in check (`isInCheck` from `@boardwright/game-chess`); where stand pat is
  allowed, captures that lose material by static exchange evaluation (`see`) are dropped and
  delta pruning skips captures that cannot reach alpha (`gain`: victim + 200); in check every
  legal Move is searched. It wins most games against the same Engine without it, at equal depth
  and at equal time per Move. Check extension (`extend` = `isInCheck`): a Move that gives check is
  searched a ply deeper (up to 4 per path), so a forced mate by checks just past the depth is
  found; +0-25% nodes, 15/20 against the same Engine without it at equal time per Move.
- `engines/backgammon-expecti`: expectiminimax with a readable evaluation in pips (pip count,
  borne-off and bar checkers, blots within the Opponent's reach, made points, home-board points)
  squashed by `tanh` into (-1, 1), `winValue` 1; gammons are not valued. Searches without
  `maxDepth` stop at depth 2 (0.1-0.4 s), even with a `maxTimeMs` (which the server always sets):
  `maxTimeMs` alone never deepens. Depth 3 plays 400-500 times as many Moves (4-10 million) and
  takes one to three minutes. The transposition table saves only 5-9% of them, as alpha-beta
  prunes nothing here and only Positions that different rolls reach transpose, so the cap stays.
  Deeper searches need an explicit `maxDepth`, still bounded by `maxTimeMs`.
