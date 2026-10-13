// How the UI shows an Analysis (DOM-free): Score text and what the board
// overlays. Moves stay in the Game's Notation.
import type { Analysis, Score, Seat } from "@boardwright/core";
import { seatLabel } from "./outcome.ts";

/** A heuristic value with its sign; integers stay integers. */
function signed(value: number): string {
  if (value === 0) return "0";
  const text = Number.isInteger(value)
    ? String(Math.abs(value))
    : Math.abs(value).toFixed(2);
  return `${value > 0 ? "+" : "-"}${text}`;
}

const plies = (n: number) => `${n} ${n === 1 ? "Ply" : "Plies"}`;

/** Short Score text: "+35", "-0.50", "0", "Win in 3", "Loss in 2". */
export function formatScore(score: Score): string {
  switch (score.kind) {
    case "value":
      return signed(score.value);
    case "win-in":
      return `Win in ${score.plies}`;
    case "loss-in":
      return `Loss in ${score.plies}`;
  }
}

/**
 * The Score as a sentence from `seat`'s perspective (whose view the Engine
 * took), e.g. "White wins in 3 Plies", "Black: +35".
 */
export function describeScore(score: Score, seat: Seat | undefined): string {
  const who = seat === undefined ? undefined : seatLabel(seat);
  switch (score.kind) {
    case "value":
      return who === undefined
        ? signed(score.value)
        : `${who}: ${signed(score.value)}`;
    case "win-in":
      return `${who ?? "The Seat to move"} wins in ${plies(score.plies)}`;
    case "loss-in":
      return `${who ?? "The Seat to move"} loses in ${plies(score.plies)}`;
  }
}

export interface LineRow {
  /** 0 for the best Line. */
  readonly rank: number;
  readonly score: string;
  readonly description: string;
  /** The Line's Moves in Notation. */
  readonly moves: readonly string[];
}

/** What the Analysis panel shows for one Analysis of a Position. */
export interface AnalysisSummary {
  readonly depth: number;
  /**
   * The headline Score: the best Line's, or the expected Score while a Chance
   * event is pending; absent when there is neither (an end of the Match).
   */
  readonly score?: { readonly text: string; readonly description: string };
  /** True for a pending Chance event's expected Score. */
  readonly expected: boolean;
  readonly lines: readonly LineRow[];
}

/**
 * Summarises an Analysis of a Position whose Seat to move is `toMove`. Line
 * Scores take the Seat to move's perspective; a pending Chance event's
 * expected Score takes `analysis.seat`'s (ADR 0005).
 */
export function summarize(
  analysis: Analysis<string>,
  toMove: Seat | undefined,
): AnalysisSummary {
  const lines = analysis.lines.map((line, rank) => ({
    rank,
    score: formatScore(line.score),
    description: describeScore(line.score, toMove),
    moves: line.moves,
  }));
  const best = lines[0];
  if (best) {
    return {
      depth: analysis.depth,
      score: { text: best.score, description: best.description },
      expected: false,
      lines,
    };
  }
  if (analysis.score) {
    return {
      depth: analysis.depth,
      score: {
        text: formatScore(analysis.score),
        description: `Expected: ${
          describeScore(analysis.score, analysis.seat)
        }`,
      },
      expected: true,
      lines,
    };
  }
  return { depth: analysis.depth, expected: false, lines };
}

/** What the board draws for an Analysis (see `BoardRequest`). */
export interface Overlay {
  /** The first Move of each Line, best first. */
  readonly arrows: readonly string[];
  /** A previewed Line's Moves, drawn step by step. */
  readonly preview?: readonly string[];
}

/**
 * Line -> overlay: arrows for the first Moves of the best Lines; while a
 * Line is previewed (hovered or focused), only that Line, Move by Move.
 */
export function overlay(
  analysis: Analysis<string> | undefined,
  previewed?: number,
): Overlay {
  if (!analysis) return { arrows: [] };
  const line = previewed === undefined ? undefined : analysis.lines[previewed];
  if (line) return { arrows: [], preview: line.moves };
  return {
    arrows: analysis.lines.flatMap((l) =>
      l.moves[0] === undefined ? [] : [l.moves[0]]
    ),
  };
}
