// Move-input state machine shared by renderers whose Moves are several clicks
// (a piece then its destinations, a mill then the piece to remove). DOM-free.
import type { MoveIntent, MoveTargets, Selection, TargetId } from "./board.ts";

/** The order in which a Move's targets are clicked: `path`, then `effects`. */
export function clickOrder(targets: MoveTargets): readonly TargetId[] {
  return [...targets.path, ...(targets.effects ?? [])];
}

const startsWith = (clicks: readonly TargetId[], prefix: Selection) =>
  prefix.every((t, i) => clicks[i] === t);

/**
 * Interprets a click while composing a Move. `targetsOf` gives the targets a
 * Move touches (see `clickOrder`). Only legal Moves can be completed:
 * - the click extends the selection to a prefix of some legal Move: the Move
 *   is played if the prefix completes it (and no longer Move continues it),
 *   otherwise the extended selection is returned;
 * - clicking the last selected target again takes it back (deselects);
 * - otherwise a click that starts some legal Move restarts the selection
 *   from it (re-picking another piece);
 * - anything else keeps the selection unchanged, so a stray click does not
 *   discard a partly composed Move; with nothing selected it is ignored.
 */
export function composeMove<Move>(
  targetsOf: (move: Move) => MoveTargets,
  legalMoves: readonly Move[],
  selection: Selection,
  target: TargetId,
): MoveIntent<Move> {
  const all = legalMoves.map((move) => ({
    move,
    clicks: clickOrder(targetsOf(move)),
  }));
  const extended = [...selection, target];
  for (const prefix of [extended, [target]]) {
    const matching = all.filter((m) => startsWith(m.clicks, prefix));
    if (matching.length === 0) {
      if (prefix === extended && selection.at(-1) === target) {
        return { kind: "select", selection: selection.slice(0, -1) };
      }
      continue;
    }
    const complete = matching.find((m) => m.clicks.length === prefix.length);
    if (complete && matching.length === 1) {
      return { kind: "move", move: complete.move };
    }
    return { kind: "select", selection: prefix };
  }
  return selection.length > 0
    ? { kind: "select", selection }
    : { kind: "ignore" };
}
