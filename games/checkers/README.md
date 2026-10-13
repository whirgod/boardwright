# @boardwright/game-checkers

English draughts / American checkers as a `GameRules` package (`checkers`).

## Rules

- 8x8 board, 12 men each on the dark squares; Seats `black` and `white`; black moves first.
- Squares are numbered 1-32 (standard): 1-4 is the top row from black's side, black starts on
  1-12 and moves towards 32, white starts on 21-32 and moves towards 1.
- Men step diagonally forward; kings step in all four diagonal directions (one square).
- Captures are mandatory. A Move is a whole jump sequence, which must be completed (a partial
  sequence is not a Move). Any capturing sequence may be chosen; there is no maximum-capture rule.
  Captured pieces stay on the board until the Move ends, so they cannot be jumped twice or landed
  on; a king may pass through or land on its own starting square.
- A man that reaches the far row is crowned and its Move ends (even if it could keep jumping as a
  king). Men never move or capture backward.
- Loss: the Seat to move has no legal Move (no pieces, or all blocked). Outcome reason
  `no-legal-moves`. It takes precedence over the draw rules.
- Draw `forty-move-rule`: 80 plies (40 Moves by each side) without a capture or man move. The
  Position with the clock at 80 is terminal.
- Draw `threefold-repetition`: the same Position (pieces and Seat to move) has occurred three
  times since the last capture or man move (both are irreversible, so no earlier Position can
  recur). The third occurrence is terminal.

## Notation

- Move: squares joined by `-` for a step (`11-15`) or `x` for a capture (`22x15x8`); a capture
  names every landing square. Two squares two rows apart mean a jump.
- Position: PDN-style FEN `<B|W>:W<pieces>:B<pieces>`, the Seat to move first, kings prefixed `K`:
  `B:W21,22,K30:B1,2,3`. The encoder sorts pieces by square.
- Draw-rule state is appended only when non-zero: `:<clock>` (plies since the last capture or man
  move) and `:<history>` (the `|`-separated keys `<B|W>/<white pieces>/<black pieces>` of the
  earlier Positions in the same stretch, oldest first). `B:WK32:BK1:9` is a Position with clock 9
  and no repetition history; decoding a FEN without extras gives clock 0 and empty history.

## TypeScript

`CheckersPosition` is `{ board, turn, clock, history }`; a `CheckersMove` is the list of squares
visited (`[22, 15, 8]`). `legalMoves` returns `[]` on terminal Positions.
