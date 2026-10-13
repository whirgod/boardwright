---
status: accepted
---

# Two-Seat, zero-sum Games only

Every Game Boardwright hosts has exactly two Seats, and one Seat's win is the other's loss (or the Match is drawn). This covers chess, checkers, nine men's morris and backgammon, and lets the domain speak of "the Opponent", Score from the perspective of the Seat to move (negamax), and Forfeit/Resignation handing the win to the other Seat. Games with more Seats or non-zero-sum Outcomes would require reworking Outcome, Score and the Engine library, and are deliberately out of scope.
