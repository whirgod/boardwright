// How the Move list names Moves (DOM-free). Notation is exact but not always
// readable (chess UCI), so a Game may register a formatter; others fall back
// to Notation.
import type { GameId, GameRules } from "@boardwright/core";
import { chess, formatSan } from "@boardwright/game-chess";
import type { MoveListEntry } from "./api.ts";

/** Formats the Moves of a Game for people; Chance events are not handled. */
type Formatter = (
  moves: readonly string[],
  labels: string[],
) => void;

/** A formatter for a Game whose `format` writes a legal Move from the Position it is played in. */
function formatter<Position, Move>(
  rules: GameRules<Position, Move>,
  format: (position: Position, move: Move) => string,
): Formatter {
  return (moves, labels) => {
    let position = rules.initialPosition();
    try {
      for (const [i, text] of moves.entries()) {
        const move = rules.notation.decodeMove(text, position);
        labels[i] = format(position, move);
        position = rules.play(position, move);
      }
    } catch {
      // Out of sync: the rest stays in Notation.
    }
  };
}

const FORMATTERS: ReadonlyMap<GameId, Formatter> = new Map([
  [chess.id, formatter(chess, formatSan)],
]);

/**
 * The text of each Move list entry: Moves as the Game's formatter writes them
 * (chess: SAN), Chance events and Games without a formatter as Notation. A
 * Move that does not replay or format keeps its Notation, as does every entry
 * after it.
 */
export function entryLabels(
  gameId: GameId,
  entries: readonly MoveListEntry[],
): string[] {
  const labels = entries.map((e) => e.kind === "move" ? e.move : e.chance);
  const format = FORMATTERS.get(gameId);
  if (format === undefined) return labels;
  // Games with a formatter have no Chance events; stop at one if it shows up.
  const end = entries.findIndex((e) => e.kind !== "move");
  format(
    entries.slice(0, end < 0 ? entries.length : end).map((e) =>
      e.kind === "move" ? e.move : ""
    ),
    labels,
  );
  return labels;
}
