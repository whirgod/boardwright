---
status: accepted
---

# The Game supplies a Transposition key; graph-history errors are accepted

Engines key their transposition tables on a Position's text, `Notation.encodePosition`, which must capture everything that affects play. In chess, checkers and nine men's morris that includes the repetition history and the move clocks, so two Move orders that reach the same Position almost never share a table entry (in #77, score reuse saved chess only 2-5% of nodes). We add an optional `GameRules.transpositionKey(position)`, modelled on `isPass`: the Game's own key, which leaves out the earlier play that only decides Outcomes. The Engine libraries key their table by it when the Game supplies one (`tableKey` in `engines/search`), else by `encodePosition`. Chess, checkers and nine men's morris supply it; backgammon and tic-tac-toe Positions carry no history, so `encodePosition` already is their key.

Obligations, checked by the contract kits on the Positions of their random playouts (which reach dozens of transpositions per Game): the key is pure and total and survives `decodePosition(encodePosition(p))`; and among Positions **without an Outcome**, equal keys mean the same Seat to move, the same legal Moves in the same order (the table stores a Move as its index into `legalMoves`), the same Chance events, and the same Move (Chance result) leads to Positions with equal keys again. So Positions with equal keys have the same tree of play below them and differ only in which of its Positions are terminal by their history, and so in value. The last obligation goes beyond the issue (#83): without it, a key could merge, say, a roll's different results, which is state, not history, and the kit would not notice.

**Graph-history interaction (GHI) is accepted**, as in most engines. The searches check a Position's Outcome before they probe the table (minimax's `leafScore`, expectiminimax's `value`), so a Position that _is_ a draw by repetition or by a move clock is never answered from the table; tests in both libraries and in chess-minimax pin that. What remains: a stored score may come from a path with other history, where the subtree reached a repetition (or the clock's limit) that this path would not reach, or the other way round; and an entry whose subtree ended in Outcomes everywhere (depth `Infinity`) keeps answering at later depths, so such an error is not corrected by the next depth. Evidence that this is rare and cheap to accept: the only history-dependent Outcomes in these Games are draws by threefold repetition (the Position twice before) and by a 40-50 Move clock. The best Move and Score are the same with either key on every measured Position: the chess start, middlegame and Kiwipete at depth 5 and 6, checkers and morris from the start and history-rich Positions, and 85 Positions with 20-34 reversible plies of history (53 chess endgames at depth 6, 20 checkers kings endgames at depth 10, 12 morris moving-phase Positions at depth 7; in 25 of them the history holds the root twice, so a repetition is a few plies away), whose searches reached draws by repetition in 10 cases. Those quiet, history-rich Positions are also where the key gains most (-25% to -69% nodes there), so not storing results that reached a history-dependent Outcome would give up much of the gain.

## Considered Options

- **An Engine option** (`MinimaxOptions`) — leaves `core` unchanged, but which fields decide the legal Moves is Game knowledge: every Engine of a Game would repeat it, and the Game's contract kit could not check it.
- **Limit GHI**: do not store, or do not trust across depths, results whose subtree reached a history-dependent Outcome — `RulesOutcome.reason` is free-form, so this needs another core change to tell those Outcomes apart, and it drops the entries the key is for. Revisit if Analyses show GHI errors in practice.
- **The name `positionKey`** — reads as the Position's identity, which is what it is not (that is `encodePosition`); "Transposition key" says what it is for and is in the glossary.
- **A numeric (Zobrist) key** — out of scope: the table stores keys whole, so a hit is never another key's entry, while a numeric key brings collisions.

## Consequences

- A Game whose Positions carry repetition history or move clocks should supply a Transposition key; its contract kit checks it.
- With a key, a depth-limited result may differ from the one with `encodePosition` (GHI, or other entries letting a depth see further); none did in the measurements.
- Shorter keys also make table entries smaller, so a full table holds more of them.
