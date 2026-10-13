// Move-input state machine shared by renderers whose Moves are several clicks
// (a piece then its destinations, a mill then the piece to remove). DOM-free.
import type { MoveIntent, Selection, TargetId } from "./board.ts";

const startsWith = (clicks: readonly TargetId[], prefix: Selection) =>
  prefix.every((t, i) => clicks[i] === t);

/**
 * Interprets a click while composing a Move. `clicksOf` gives the targets a
 * Move is composed from, in click order (`path` then `effects`). Only legal
 * Moves can be completed:
 * - the click extends the selection to a prefix of some legal Move: the Move
 *   is played if the prefix completes it (and no longer Move continues it),
 *   otherwise the extended selection is returned;
 * - otherwise a click that starts some legal Move restarts the selection
 *   from it (re-picking another piece);
 * - anything else is ignored (the caller clears the selection).
 */
export function composeMove<Move>(
  clicksOf: (move: Move) => readonly TargetId[],
  legalMoves: readonly Move[],
  selection: Selection,
  target: TargetId,
): MoveIntent<Move> {
  const all = legalMoves.map((move) => ({ move, clicks: clicksOf(move) }));
  for (const prefix of [[...selection, target], [target]]) {
    const matching = all.filter((m) => startsWith(m.clicks, prefix));
    if (matching.length === 0) continue;
    const complete = matching.find((m) => m.clicks.length === prefix.length);
    if (complete && matching.length === 1) {
      return { kind: "move", move: complete.move };
    }
    return { kind: "select", selection: prefix };
  }
  return { kind: "ignore" };
}
