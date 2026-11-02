---
status: accepted
---

# The Game supplies a Transposition key; graph-history errors are accepted, draws are not trusted across depths

Engines key their transposition tables on a Position's text, `Notation.encodePosition`, which must capture everything that affects play. In chess, checkers and nine men's morris that includes the repetition history and the move clocks, so two Move orders that reach the same Position almost never share a table entry (in #77, score reuse saved chess only 2-5% of nodes). We add an optional `GameRules.transpositionKey(position)`, modelled on `isPass`: the Game's own key, which leaves out the earlier play that only decides draws. The Engine libraries key their table by it when the Game supplies one (`tableKey` in `engines/search`), else by `encodePosition`. Chess, checkers and nine men's morris supply it; backgammon and tic-tac-toe Positions carry no history, so `encodePosition` already is their key.

Obligations, checked by the contract kits on the Positions of their random playouts (which reach dozens of transpositions per Game, and must reach at least one) and on `keyPositions` the Game names for fields playouts rarely meet (castling rights, en passant, pieces in hand): the key is pure and total and survives `decodePosition(encodePosition(p))`; equal keys mean the same Outcome unless it is a draw (history decides only draws, never a win); and among Positions **without an Outcome**, equal keys mean the same Seat to move, the same legal Moves in the same order (the table stores a Move as its index into `legalMoves`), the same Chance events, and the same Move (Chance result) leads to Positions with equal keys again. So Positions with equal keys have the same tree of play below them and differ only in which of its Positions are draws by their history, and so in value. The last two obligations go beyond the issue (#83): without the successor one, a key could merge, say, a roll's different results, which is state, not history; the draws-only one is what lets the search below trust every decisive Outcome.

**Graph-history interaction (GHI) is accepted**, as in most engines, with two safeguards:

- The searches check a Position's Outcome before they probe the table (minimax's `leafScore`, expectiminimax's `value`), so a Position that _is_ a draw by repetition or by a move clock is never answered from the table.
- **A draw is not trusted across depths.** With a Transposition key (`hasTranspositionKey`), a search counts every draw it reaches like a horizon: a result that rests on a draw is stored for its depth only, never as holding at any depth (`Infinity`), and the depth is not `solved`, so the next depth searches it again. Without this, a subtree ended by a history draw on one path was stored as solved and answered on another path at every later depth, and could make a whole depth `solved` and stop the search with a wrong result (the review of #100 showed a forced win missed that way). This is the "do not trust across depths" half of limiting GHI. It needs no way to tell history draws from others, as every draw is treated so, and it keeps every entry for its own depth. It rules out a false `solved` only in this direction (see below).

Tests in both libraries and in chess-minimax pin both. What remains accepted:

- Within one depth, a stored score may come from a path with other history (a repetition near on one path and not on the other).
- **The mirror case, across depths:** a decisive subtree solved on path A (stored as `Infinity`) answers on path B, where B's history would have drawn inside it. It answers at every later depth without counting as a horizon, so it can still make a depth `solved` and stop the search with a wrong result. The second review of #100 showed one: a loss through P stored for x answers Q's visit, where y would have been a draw, so the search stops at depth 5 with the loss instead of finding Q's draw. Counting answers from `Infinity` entries against `solved` would close this, but it would also stop decisive results from ever being solved, since iterative deepening relies on those entries from one depth to the next. The impact is small: it needs a fully decisive subtree that another path's history would draw, it can only end a search early, never make it loop, and the server always sets `maxTimeMs`, so its searches end at the time limit or at such an early stop.

Evidence that GHI is rare and cheap: the only history-dependent Outcomes in these Games are draws by threefold repetition (the Position twice before) and by a 40-50 Move clock. The best Move and Score are the same with either key on every measured Position: the chess start, middlegame and Kiwipete at depth 5 and 6, checkers and morris from the start and history-rich Positions, and 85 Positions with 20-34 reversible plies of history (53 chess endgames at depth 6, 20 checkers kings endgames at depth 10, 12 morris moving-phase Positions at depth 7; in 25 of them the history holds the root twice, so a repetition is a few plies away), whose searches reached draws by repetition in 10 cases. Those quiet, history-rich Positions are also where the key gains most (-25% to -69% nodes there).

## Considered Options

- **An Engine option** (`MinimaxOptions`) — leaves `core` unchanged, but which fields decide the legal Moves is Game knowledge: every Engine of a Game would repeat it, and the Game's contract kit could not check it.
- **Do not store results that reached a history-dependent Outcome** — needs another core change to tell those Outcomes apart (`RulesOutcome.reason` is free-form), and drops the entries the key is for. Not trusting draws across depths (adopted) needs neither.
- **Count only reused draw-tainted entries, not draws reached directly, against `solved`** — a draw reached on the search's own path is exact for that path, so a fully drawn tree could still be `solved`; but it needs a second counter, and the keyed Games are far too large to be solved anyway.
- **The name `positionKey`** — reads as the Position's identity, which is what it is not (that is `encodePosition`); "Transposition key" says what it is for and is in the glossary.
- **A numeric (Zobrist) key** — out of scope: the table stores keys whole, so a hit is never another key's entry, while a numeric key brings collisions.

## Consequences

- A Game whose Positions carry repetition history or move clocks should supply a Transposition key; its contract kit checks it, with `keyPositions` for rarely met fields.
- With a key, a search that reaches a draw is never `solved`: it ends only at `maxDepth`, `maxTimeMs` or an abort (the server always sets a time limit). A forced win or loss without draws in its tree is still solved, and, through the mirror case above, may rarely be solved wrongly where another path's history would have drawn it.
- With a key, a depth-limited result may differ from the one with `encodePosition` (GHI, or other entries letting a depth see further); none did in the measurements.
- Shorter keys also make table entries smaller, so a full table holds more of them.
