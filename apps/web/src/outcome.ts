// How the UI words an Outcome, from its structured kind (rules /
// Resignation / Forfeit). The only place that reads Outcome fields. Reason
// codes are never parsed: known ones get a label, others are shown as sent.
import type { Outcome, Seat } from "@boardwright/core";

export interface OutcomeText {
  /** "X wins" or "Draw". */
  readonly headline: string;
  readonly detail: string;
}

/** Reasons a Game's rules end a Match. */
const RULE_REASONS: Readonly<Record<string, string>> = {
  "three-in-a-row": "three in a row",
  "board-full": "the board is full",
};

/** Why the Game master imposed a Forfeit. */
const FORFEIT_REASONS: Readonly<Record<string, string>> = {
  "timeout": "ran out of time",
  "illegal-move": "played an illegal Move",
  "engine-error": "the Engine failed",
  "worker-error": "the Engine crashed",
  "unreadable-reply": "the Engine sent an unreadable reply",
  "not-registered": "the Engine is not available",
};

/** A Seat for display: "x" -> "X", "white" -> "White". */
export function seatLabel(seat: Seat): string {
  return seat.charAt(0).toUpperCase() + seat.slice(1);
}

export function describeOutcome(outcome: Outcome): OutcomeText {
  const headline = outcome.winner === undefined
    ? "Draw"
    : `${seatLabel(outcome.winner)} wins`;
  switch (outcome.kind) {
    case "rules":
      return {
        headline,
        detail: RULE_REASONS[outcome.reason] ?? outcome.reason,
      };
    case "resignation":
      return { headline, detail: `${seatLabel(outcome.seat)} resigned` };
    case "forfeit":
      return {
        headline,
        detail: `${seatLabel(outcome.seat)} forfeited: ${
          FORFEIT_REASONS[outcome.reason] ?? outcome.reason
        }`,
      };
  }
}
