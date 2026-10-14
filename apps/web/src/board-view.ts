// DOM-free parts of the board component (`board.tsx`): what a screen reader
// hears for each target, and how wide the board may grow.
import type {
  BoardScene,
  Highlight,
  HighlightKind,
  TargetId,
} from "./renderers/mod.ts";

const STATE_TEXT: Readonly<Record<HighlightKind, string>> = {
  "selected": "selected",
  "destination": "possible destination",
  "last-move": "part of the last Move",
  "last-move-effect": "touched by the last Move",
};

/** Order the states are spoken in (what the user is doing now comes first). */
const ORDER: readonly HighlightKind[] = [
  "selected",
  "destination",
  "last-move",
  "last-move-effect",
];

/** The highlight kinds of each target, in speaking order, without repeats. */
export function targetStates(
  highlights: readonly Highlight[],
): Map<TargetId, HighlightKind[]> {
  const states = new Map<TargetId, HighlightKind[]>();
  for (const { target, kind } of highlights) {
    const kinds = states.get(target) ?? [];
    if (!kinds.includes(kind)) kinds.push(kind);
    states.set(target, kinds);
  }
  for (const kinds of states.values()) {
    kinds.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  }
  return states;
}

/** A target's label with its highlighted states, e.g. "e4: white pawn (selected)". */
export function targetLabel(
  label: string,
  kinds: readonly HighlightKind[] | undefined,
): string {
  if (kinds === undefined || kinds.length === 0) return label;
  return `${label} (${kinds.map((k) => STATE_TEXT[k]).join(", ")})`;
}

/** Boards at least this much wider than tall (e.g. backgammon) may use the whole column. */
const WIDE_RATIO = 1.25;

/** CSS classes of the board `svg`. */
export function boardClass(scene: BoardScene, interactive: boolean): string {
  const wide = scene.width >= scene.height * WIDE_RATIO;
  return ["board", interactive && "interactive", wide && "wide"]
    .filter(Boolean).join(" ");
}
