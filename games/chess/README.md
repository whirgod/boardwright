# @boardwright/game-chess

Chess (FIDE Laws of Chess) as a `GameRules` package (`chess`), plus SAN helpers for display.

## Rules

- Standard 8x8 board and initial Position; Seats `white` and `black`; white moves first.
- All piece moves, including **castling** (king and rook unmoved; squares between them empty; the
  king is not in check, does not pass through an attacked square and does not land on one — the
  rook may pass an attacked square, e.g. `b1`), **en passant** (only on the Move immediately after
  the double push) and **promotion** to queen, rook, bishop or knight (mandatory; the Move names
  the piece). No Move may leave the mover's own king in check.
- Loss `checkmate`: the Seat to move is in check and has no legal Move; the Opponent wins.
- Draws are applied automatically (there are no draw claims or offers in Boardwright):
  - `stalemate`: the Seat to move is not in check and has no legal Move.
  - `insufficient-material`: neither Seat can checkmate by any series of legal Moves, recognised
    by material only: no pawns, rooks or queens remain, and either the only minor piece is one
    knight (K v K, K+N v K), or all minor pieces are bishops standing on squares of one colour (K+B
    v K, K+B v K+B with same-coloured bishops, and more bishops on that colour). Other dead
    Positions (e.g. fully blocked pawn chains) are not detected. K+N v K+N, K+B v K+N, two knights
    and opposite-coloured bishops are **not** draws (mate is possible, if only with help).
  - `fifty-move-rule`: 100 plies (50 Moves by each Seat) without a capture or pawn Move. FIDE
    makes this a claim at 50 and automatic at 75 Moves; here it is automatic at 50.
  - `threefold-repetition`: the same Position occurs for the third time. FIDE makes this a claim
    (automatic at five); here it is automatic at three. Positions are the same when the same Seat
    is to move, the same pieces stand on the same squares, and the castling rights and the
    en passant possibility are the same; an en passant square only counts when an en passant
    capture is actually legal (FIDE Article 9.2.3).
- Precedence: checkmate and stalemate first (a mating Move that also reaches the fifty-move limit
  wins), then insufficient material, the fifty-move rule and repetition.

## Notation

- Move: UCI long algebraic, `<from><to>[promotion]` in lower case: `e2e4`, `g1f3`, `e7e8q`.
  Castling is the king's Move (`e1g1`, `e1c1`, `e8g8`, `e8c8`). Decoding checks only the syntax
  (squares `a1`-`h8`, distinct, optional `q`/`r`/`b`/`n`); `play` rejects illegal Moves, including
  a missing or superfluous promotion piece.
- Position: standard six-field FEN,
  `<placement> <w|b> <castling> <en passant> <halfmove clock> <fullmove number>`, e.g. the initial
  `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1`. The en passant square is written
  after every double pawn push (as in the FEN standard), whether or not a capture is possible.
- Repetition state is appended as a seventh field only when non-empty: the `|`-separated
  repetition keys of the earlier Positions since the last capture, pawn Move or change of castling
  rights (none of which can be undone), oldest first. A key is
  `<placement>:<w|b>:<castling>:<en passant or ->`, with the en passant square only when a capture
  is legal: `... w KQkq - 2 2 rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR:w:KQkq:-|rnbqkbnr/...:b:KQkq:-`.

Decoding is strict so text is canonical and the Position is reachable-looking:

- exactly 8 ranks of 8 squares with merged empty counts (`44` and `9` are rejected);
- one king per Seat, at most 16 pieces and 8 pawns per Seat, no pawns on the first or last rank;
- the Seat not to move is not in check;
- castling rights as `-` or a non-empty subset of `KQkq` in that order, each with its king and rook
  on their initial squares;
- an en passant square on rank 6 (white to move) or 3 (black to move), empty, with the empty square
  behind it and the pushed pawn in front, and a halfmove clock of 0;
- counters without leading zeros (up to 4 digits), fullmove number >= 1;
- history entries that are canonical, alternate in turn ending with the Opponent, share the
  current castling rights, and number at most the halfmove clock.

## SAN helpers

`formatSan(position, move)` writes Standard Algebraic Notation for a legal Move: piece letter
(`NBRQK`, none for pawns), disambiguation by file, else rank, else both — considering only other
**legal** Moves of the same piece type to the same square (a pinned piece does not force
disambiguation) — `x` for captures (pawns name their file: `exd6`, also en passant), `=Q` for
promotions, `O-O` / `O-O-O`, and a `+` or `#` suffix. `parseSan(position, text)` is the inverse;
the check suffix and trailing `!`/`?` annotations are optional. Both throw on illegal Moves.

## TypeScript

`ChessPosition` is `{ board, turn, castling, enPassant, halfmoveClock, fullmoveNumber, history }`
with `board` the 64 FEN piece letters (or `.`) indexed by `Square` (`a1` = 0, `h1` = 7, `h8` = 63;
see `squareName`/`parseSquare`). A `ChessMove` is `{ from, to, promotion? }`. `legalMoves` returns
`[]` on terminal Positions.

Internally Moves are generated on a mutable mailbox board with make/unmake (`src/board.ts`); the
public API wraps it immutably and memoizes legal Moves per Position object.

## Tests and perft

`perft(position, depth)` counts the leaves of the legal Move tree (ignoring draw rules). The tests
check it against the reference values of the
[Chess Programming Wiki](https://www.chessprogramming.org/Perft_Results) for the initial Position
(depth 4), Kiwipete (depth 3), positions 3 (depth 5), 4 and its mirror (depth 4), 5 and 6 (depth 3),
and through `legalMoves`/`play` at depth 2-3. Deeper counts (up to depth 6 for the initial
Position, depth 5 for Kiwipete; about a minute) run with:

```sh
deno task --cwd games/chess perft:deep
```
