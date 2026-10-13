# @boardwright/game-backgammon

Backgammon as a `ChanceGameRules` package (`backgammon`, ADR 0005): the dice are Chance events
rolled by the Game master, a Move is the full play of one roll.

## Rules

- Standard board and initial Position; Seats `white` and `black`, 15 checkers each. Each Seat
  numbers the points from its own side: it moves its checkers from its 24-point towards its
  1-point, its home board is points 1-6, and its 24-point is the Opponent's 1-point.
- **Opening roll**: the first Chance event rolls one die per Seat, never equal (re-rolling ties
  is folded into the 30 equally likely results). The Seat with the higher die moves first and
  plays both dice as its roll.
- After every Move a Chance event rolls the Opponent's two dice (21 results; a non-double is twice
  as likely as a double). A double is played four times.
- A checker moves exactly the number of a die to a point that holds at most one Opponent checker;
  a single Opponent checker there (a blot) is hit and goes to the bar. Checkers on the bar must
  enter first (a die `d` enters on the mover's point `25 - d`); nothing else moves while one is
  on the bar.
- **Bearing off** needs every checker in the home board: a die bears off a checker from the
  point of that number; a higher die bears off from the highest occupied point only.
- **Dice use**: a Move uses as many dice as possible (both, or up to four of a double). If only
  one die of a non-double can be used, it must be the higher one when that is possible.
- **No legal play**: the only legal Move is `pass`; the turn goes to the Opponent, whose roll
  follows. (A Seat to move always has a legal Move, so the `GameRules` contract holds.)
- **Outcome**: the first Seat to bear off all 15 checkers wins, with reason `single` (the loser
  has borne off at least one checker), `gammon` (none) or `backgammon` (none, and a checker on
  the bar or in the winner's home board).
- **Not implemented**: the doubling cube (so no stakes, no Crawford rule) and match play;
  `gammon`/`backgammon` only name how the Match was won.

## Notation

- Move: the Steps of the play in order, each `<from>/<to>` in the mover's numbering, `bar` and
  `off` for the bar and borne off, separated by single spaces, e.g. `24/18 13/11`,
  `bar/22 6/off`; `pass` for no play. Each Step uses one die. Decoding also accepts chains
  (`24/18/13`), hit marks (`13/8*`, ignored: hits follow from the Position) and repeats
  (`13/10(2)`). Different Steps that lead to the same Position are the same Move: in a
  Position with a Seat to move, decoding matches by resulting Position and returns the canonical
  Move as listed by `legalMoves` (Steps from higher points first, the higher die first where both
  work), e.g. `13/8 8/2` decodes to `13/7 7/2` and `24/23 13/7` is listed rather than
  `13/7 24/23`. Steps must be in a playable order (`3/off 7/4` is refused when the 7 is not yet
  home), and one Step may stand for a chain ending in the same Position: with 65 and checkers
  on the 6- and 1-points, `6/off` decodes to `6/1 1/off`.
- Position: `<points> <bar> <turn> <dice>`:
  - `<points>`: 24 comma-separated entries for white's points 1 to 24 (black's 24 to 1): `0`,
    `w<n>` or `b<n>` for n checkers of a Seat.
  - `<bar>`: `<white>/<black>` checker counts on the bar; borne-off checkers are the rest of 15.
  - `<turn>`: `white` or `black` (to move, or to roll next), or `-` before the opening roll.
  - `<dice>`: the roll to play, higher die first (`62`, `33`), or `-` while the roll is pending.
  - The initial Position is
    `b2,0,0,0,0,w5,0,w3,0,0,0,b5,w5,0,0,0,b3,0,b5,0,0,0,0,w2 0/0 - -`.
- Chance results: a roll `<high><low>` such as `62` or `33`; the opening roll `<white>-<black>`,
  e.g. `3-6` (black moves first with 63).
