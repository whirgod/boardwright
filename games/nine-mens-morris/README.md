# @boardwright/game-nine-mens-morris

`GameRules` for standard nine men's morris. Exported as `nineMensMorris`.

## Rules

- Seats `white` and `black`; white moves first. 24 points: `a1 a4 a7 b2 b4 b6 c3 c4 c5 d1 d2 d3 d5
  d6 d7 e3 e4 e5 f2 f4 f6 g1 g4 g7` (file a-g, rank 1-7; there is no `d4`). Adjacent points are
  consecutive points on a line of three; the 16 lines are the mills.
- **Placing phase**: each Seat places its 9 pieces on empty points, alternating.
- **Moving phase**: a Seat with no pieces in hand moves one piece to an adjacent empty point. A
  Seat with exactly 3 pieces (on board, none in hand) may **fly** to any empty point.
- **Mills**: a placement or move that completes three in a row through the moved piece removes one
  opponent piece **as part of the same Move**. Pieces in a mill are protected unless all opponent
  pieces on the board are in mills. `legalMoves` lists one Move per removal choice.
- **Loss** (checked first): a Seat with fewer than 3 pieces (board + hand) loses, or the Seat to
  move loses when it has no legal Move.
- **Draw** (moving phase only):
  - `threefold-repetition`: the same Position (board and Seat to move) occurred 3 times since the
    last placement or removal;
  - `fifty-moves-without-removal`: 50 consecutive plies (both Seats combined) in the moving phase
    without a removal. The counter starts when the moving phase begins and resets on a removal.

## Notation

Move: `d1` (place), `d1-d2` (move or fly), with an `x<point>` suffix for the removal:
`d1xg7`, `d1-d2xg7`.

Position: `board:turn:whiteHand:blackHand:quietPlies:history`

- `board`: 24 characters in the point order above: `w`, `b` or `.`
- `turn`: `w` or `b`
- `whiteHand`, `blackHand`: pieces still to place
- `quietPlies`: plies since the last removal in the moving phase (0 while placing)
- `history`: comma-separated repetition keys (`board` + turn letter) of every Position since the
  last placement or removal, including the current one (empty while placing). It is bounded by
  the 50-ply rule and always satisfies `quietPlies = history length - 1` in the moving phase.
