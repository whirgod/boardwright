// How the UI words an Outcome. The only place that reads Outcome fields, so a
// structured Outcome kind (#33: by the rules / Resignation / Forfeit) changes
// this module only. Reasons are never parsed; known codes get a label and
// anything else is shown as sent.
import type { Outcome, Seat } from "@boardwright/core";

export interface OutcomeText {
  /** "X wins" or "Draw". */
  readonly headline: string;
  readonly detail: string;
}

const REASONS: Readonly<Record<string, string>> = {
  "three-in-a-row": "three in a row",
  "board-full": "the board is full",
};

/** A Seat for display: "x" -> "X", "white" -> "White". */
export function seatLabel(seat: Seat): string {
  return seat.charAt(0).toUpperCase() + seat.slice(1);
}

export function describeOutcome(outcome: Outcome): OutcomeText {
  return {
    headline: outcome.winner === undefined
      ? "Draw"
      : `${seatLabel(outcome.winner)} wins`,
    detail: REASONS[outcome.reason] ?? outcome.reason,
  };
}
