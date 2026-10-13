/**
 * Nine men's morris Engine: the generic alpha-beta library with a heuristic
 * evaluation. The tree is far too large to solve, so callers should pass
 * `maxDepth` and/or `maxTimeMs`.
 *
 * Evaluation (from the Seat to move): material (board + hand) dominates;
 * closed mills, blocked opponent pieces and two-in-a-row mill threats (one
 * empty point left) refine it. A Seat reduced to three pieces flies, so its
 * pieces are never counted as blocked.
 *
 * Exports `rules` and `engine` so a host can load it by URL in a Worker.
 */
import type { Engine } from "@boardwright/core";
import { createMinimaxEngine } from "@boardwright/engine-minimax";
import {
  type Cell,
  MILLS,
  type MorrisMove,
  type MorrisPosition,
  neighborsOf,
  nineMensMorris,
  POINTS,
} from "@boardwright/game-nine-mens-morris";

export const rules = nineMensMorris;

const INDEX = new Map(POINTS.map((p, i) => [p, i]));
const LINES = MILLS.map((l) => l.map((p) => INDEX.get(p)!));
const NEIGHBORS = POINTS.map((p) => neighborsOf(p).map((n) => INDEX.get(n)!));

export const WEIGHTS = {
  piece: 100,
  mill: 25,
  blocked: 8,
  twoInRow: 12,
} as const;

function side(board: readonly Cell[], letter: Cell, inHand: number) {
  let onBoard = 0;
  let blocked = 0;
  board.forEach((c, i) => {
    if (c !== letter) return;
    onBoard++;
    if (NEIGHBORS[i]!.every((n) => board[n] !== ".")) blocked++;
  });
  let mills = 0;
  let twos = 0;
  for (const line of LINES) {
    const mine = line.filter((i) => board[i] === letter).length;
    if (mine === 3) mills++;
    else if (mine === 2 && line.some((i) => board[i] === ".")) twos++;
  }
  const pieces = onBoard + inHand;
  return { pieces, mills, twos, blocked: pieces === 3 ? 0 : blocked };
}

/** Heuristic value of `position` for the Seat to move (non-terminal). */
export function evaluate(position: MorrisPosition): number {
  const white = position.turn === "white";
  const a = side(
    position.board,
    white ? "w" : "b",
    position.inHand[position.turn],
  );
  const b = side(
    position.board,
    white ? "b" : "w",
    position.inHand[white ? "black" : "white"],
  );
  return WEIGHTS.piece * (a.pieces - b.pieces) +
    WEIGHTS.mill * (a.mills - b.mills) +
    WEIGHTS.blocked * (b.blocked - a.blocked) +
    WEIGHTS.twoInRow * (a.twos - b.twos);
}

export const engine: Engine<MorrisPosition, MorrisMove> = createMinimaxEngine<
  MorrisPosition,
  MorrisMove
>({ rules, evaluate, name: "Minimax" });
