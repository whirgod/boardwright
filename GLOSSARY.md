# Boardwright

A host that referees turn-based board games between humans and AI engines, and lets people watch, review, and analyze them.

## Language

### Games and play

**Game**:
A kind of board game with fixed rules, such as chess or nine men's morris.
_Avoid_: Game type, variant (unless it really is a variant)

**Match**:
One concrete playing of a Game between Players, from the initial Position to an Outcome.
_Avoid_: Game (for a single playing), session, round

**Move list**:
The Moves and Chance events of a Match, in order from its initial Position.
_Avoid_: History, record, score sheet

**Position**:
The complete state of play at one moment: the pieces, the Seat to move, and whatever earlier play the rules still depend on (such as repetitions). A Position exists independently of any Match, e.g. when analyzed.
_Avoid_: Board, state

**Move**:
One complete action of the Seat to move that turns one Position into the next. In backgammon, the full play of one roll.
_Avoid_: Turn, action

**Chance event**:
A random step of play, such as a dice roll, made by the Game master rather than by a Seat.
_Avoid_: Roll (as the general term), random Move

**Ply**:
One Move, used only as a unit of counting (search depth, distance to a forced win).
_Avoid_: Half-move

**Seat**:
One of the two sides of a Game that a Player occupies, such as white or black.
_Avoid_: Color, side, player (a Seat is not a person)

**Opponent**:
The other Seat, from the point of view of a given Seat.
_Avoid_: Enemy, other player

**Player**:
A human or an Engine occupying a Seat in a Match.
_Avoid_: User, participant

**Outcome**:
How a Match ended: the winning Seat or a draw, plus the reason (by the rules, Resignation or Forfeit).
_Avoid_: Result, score

**Resignation**:
A Player conceding the Match; the Opponent wins.
_Avoid_: Surrender, quit

**Forfeit**:
An Outcome the Game master imposes because a Player failed to play, such as an Engine producing no legal Move; the Opponent wins.
_Avoid_: Abort, disqualification

**Notation**:
The text encoding of Positions and Moves for one Game.
_Avoid_: Format, serialization

### Engines and analysis

**Engine**:
An AI that can choose Moves and analyze Positions for one Game.
_Avoid_: Bot, AI, solver

**Engine library**:
A Game-agnostic search algorithm (e.g. minimax) that becomes an Engine once given a Game's rules and an evaluation.
_Avoid_: Engine (for the library itself), framework

**Analysis**:
An Engine's assessment of a Position: one or more Lines, best first; while a Chance event is pending, only an expected Score.
_Avoid_: Evaluation (that is the Score)

**Line**:
A sequence of Moves an Engine expects from a Position, with its Score.
_Avoid_: Variation, PV (acceptable as shorthand in engine code)

**Score**:
An Engine's evaluation of a Line from the perspective of the Seat to move: either a heuristic value or a forced win or loss in a number of Plies.
_Avoid_: Eval, rating

### Hosting

**Seat token**:
A secret handed out when a Match is created that lets its holder play the Moves of one Seat.
_Avoid_: Password, session, API key

**Spectator**:
A person following a Match without occupying a Seat.
_Avoid_: Viewer, observer, watcher

**Review**:
Stepping through the Moves of a Match to examine its Positions, during or after play.
_Avoid_: Replay, playback

**Game master**:
The server's role as referee: it owns every Match's Position and accepts only legal Moves.
_Avoid_: Arbiter, controller
