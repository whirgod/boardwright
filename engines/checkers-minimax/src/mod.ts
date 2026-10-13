/**
 * Checkers Engine: the generic alpha-beta library with a heuristic
 * evaluation. The tree is too large to solve, so callers should pass
 * `maxDepth` and/or `maxTimeMs`.
 *
 * Evaluation (from the Seat to move): material (man 100, king 160), men's
 * advancement towards the crowning row, a bonus for men on their own back
 * row (they guard against enemy crowning) and for pieces on central squares.
 *
 * Exports `rules` and `engine` so a host can load it by URL in a Worker.
 */
import type { Engine } from "@boardwright/core";
import { createMinimaxEngine } from "@boardwright/engine-minimax";
import {
  type Cell,
  checkers,
  type CheckersMove,
  type CheckersPosition,
} from "@boardwright/game-checkers";

export const rules = checkers;

export const WEIGHTS = {
  man: 100,
  king: 160,
  /** Per row advanced by a man. */
  advance: 4,
  backRow: 10,
  center: 3,
} as const;

/** Central squares (0-based indices): rows 2-5, columns 2-5. */
const CENTER = new Set([9, 10, 13, 14, 17, 18, 21, 22]);

function pieceValue(cell: Cell, index: number): number {
  const black = cell === "b" || cell === "B";
  const king = cell === "B" || cell === "W";
  const row = Math.floor(index / 4);
  let v = king ? WEIGHTS.king : WEIGHTS.man;
  if (!king) {
    v += WEIGHTS.advance * (black ? row : 7 - row);
    if (row === (black ? 0 : 7)) v += WEIGHTS.backRow;
  }
  if (CENTER.has(index)) v += WEIGHTS.center;
  return v;
}

/** Heuristic value of `position` for the Seat to move (non-terminal). */
export function evaluate(position: CheckersPosition): number {
  const black = position.turn === "black";
  let sum = 0;
  position.board.forEach((cell, i) => {
    if (cell === ".") return;
    const mine = (cell === "b" || cell === "B") === black;
    sum += mine ? pieceValue(cell, i) : -pieceValue(cell, i);
  });
  return sum;
}

export const engine: Engine<CheckersPosition, CheckersMove> =
  createMinimaxEngine<CheckersPosition, CheckersMove>({
    rules,
    evaluate,
    name: "Minimax",
  });
