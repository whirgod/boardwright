// Review: stepping through the Positions of a Match (DOM-free). The server
// sends only the current Position, so earlier ones are rebuilt here by
// replaying the Move list with the Game's own rules.
import {
  type GameId,
  type GameRules,
  hasChance,
  type Seat,
} from "@boardwright/core";
import { backgammon } from "@boardwright/game-backgammon";
import { checkers } from "@boardwright/game-checkers";
import { chess } from "@boardwright/game-chess";
import { nineMensMorris } from "@boardwright/game-nine-mens-morris";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import type { MoveListEntry } from "./api.ts";

/** One Position of a Match, in Notation, with its Seat to move (none at an end or a pending Chance event). */
export interface ReplayStep {
  readonly position: string;
  readonly toMove: Seat | undefined;
}

export interface Replay {
  /** `steps[k]` is the Position after the first `k` Move list entries. */
  readonly steps: readonly ReplayStep[];
  /** Why the replay stopped early (an entry that does not decode or apply). */
  readonly error?: string;
}

/** Replays a Move list (Moves and Chance events) from the initial Position. */
export function replayMoveList<Position, Move>(
  rules: GameRules<Position, Move>,
  entries: readonly MoveListEntry[],
): Replay {
  const { notation } = rules;
  let position = rules.initialPosition();
  const step = (): ReplayStep => ({
    position: notation.encodePosition(position),
    toMove: rules.toMove(position),
  });
  const steps = [step()];
  for (const [i, entry] of entries.entries()) {
    try {
      if (entry.kind === "move") {
        position = rules.play(
          position,
          notation.decodeMove(entry.move, position),
        );
      } else if (hasChance(rules)) {
        position = rules.resolveChance(
          position,
          rules.notation.decodeChance(entry.chance, position),
        );
      } else {
        throw new Error("this Game has no Chance events");
      }
    } catch (error) {
      const text = entry.kind === "move" ? entry.move : entry.chance;
      return {
        steps,
        error: `Cannot replay entry ${i + 1} (${text}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    steps.push(step());
  }
  return { steps };
}

const REPLAYS: ReadonlyMap<
  GameId,
  (entries: readonly MoveListEntry[]) => Replay
> = new Map(
  [
    [ticTacToe.id, (e) => replayMoveList(ticTacToe, e)],
    [nineMensMorris.id, (e) => replayMoveList(nineMensMorris, e)],
    [checkers.id, (e) => replayMoveList(checkers, e)],
    [chess.id, (e) => replayMoveList(chess, e)],
    [backgammon.id, (e) => replayMoveList(backgammon, e)],
  ],
);

/** Replays a Match of `gameId`; `undefined` for a Game this UI does not know. */
export function replay(
  gameId: GameId,
  entries: readonly MoveListEntry[],
): Replay | undefined {
  return REPLAYS.get(gameId)?.(entries);
}

/**
 * Which Position is shown: `"live"` follows the latest one as the Match goes
 * on; a number is a fixed ply (Move list entries played, from 0).
 */
export type ReviewPly = number | "live";

export type ReviewAction =
  | { readonly kind: "first" | "previous" | "next" | "last" }
  | { readonly kind: "go"; readonly ply: number };

/** The ply shown, for a Move list of `length` entries. */
export function shownPly(review: ReviewPly, length: number): number {
  return review === "live" ? length : Math.max(0, Math.min(review, length));
}

/** Applies a navigation step; reaching the last ply follows the Match again. */
export function navigate(
  review: ReviewPly,
  action: ReviewAction,
  length: number,
): ReviewPly {
  const current = shownPly(review, length);
  let target: number;
  switch (action.kind) {
    case "first":
      target = 0;
      break;
    case "previous":
      target = current - 1;
      break;
    case "next":
      target = current + 1;
      break;
    case "last":
      target = length;
      break;
    case "go":
      target = action.ply;
  }
  const ply = Math.max(0, Math.min(target, length));
  return ply === length ? "live" : ply;
}

/** Names the shown Position, e.g. "After e2e4 (5 of 12)" or "Initial Position (0 of 12)". */
export function describePly(
  entries: readonly MoveListEntry[],
  ply: number,
  /** Text of each entry (see `entryLabels`); default: Notation. */
  labels?: readonly string[],
): string {
  const of = `(${ply} of ${entries.length})`;
  const entry = entries[ply - 1];
  if (ply === 0 || entry === undefined) return `Initial Position ${of}`;
  return entry.kind === "move"
    ? `After ${labels?.[ply - 1] ?? entry.move} ${of}`
    : `After the Chance event ${entry.chance} ${of}`;
}

/** A key press as far as navigation cares. */
export interface KeyPress {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  /** Tag name of the focused element, e.g. "INPUT". */
  readonly targetTag?: string | undefined;
  /** ARIA role of the focused element, if any. */
  readonly targetRole?: string | undefined;
  /** The focused element is `contenteditable`. */
  readonly targetEditable?: boolean | undefined;
  /** Focus is in a region that keeps its own keys (e.g. the Analysis panel). */
  readonly ownKeys?: boolean | undefined;
}

const KEYS: Readonly<Record<string, ReviewAction>> = {
  ArrowLeft: { kind: "previous" },
  ArrowRight: { kind: "next" },
  Home: { kind: "first" },
  End: { kind: "last" },
};

/** Fields whose own keys (arrows, Home, End) must keep working. */
const EDITABLE = new Set(["INPUT", "SELECT", "TEXTAREA"]);

/** ARIA widgets that use arrow keys themselves. */
const WIDGET_ROLES = new Set([
  "slider",
  "listbox",
  "menu",
  "menubar",
  "radiogroup",
  "spinbutton",
  "tablist",
  "tree",
  "grid",
  "combobox",
  "textbox",
]);

/** The navigation a key asks for: arrows step, Home/End jump; none with modifiers or in form fields. */
export function keyAction(press: KeyPress): ReviewAction | undefined {
  if (press.altKey || press.ctrlKey || press.metaKey || press.shiftKey) {
    return undefined;
  }
  if (press.targetTag !== undefined && EDITABLE.has(press.targetTag)) {
    return undefined;
  }
  if (
    press.targetEditable || press.ownKeys ||
    (press.targetRole !== undefined && WIDGET_ROLES.has(press.targetRole))
  ) {
    return undefined;
  }
  return KEYS[press.key];
}
