// DOM-free view logic of the Match page.
import type { Seat } from "@boardwright/core";
import type { MatchView, PlayerSpec } from "./api.ts";
import { describeOutcome, type OutcomeText } from "./outcome.ts";
import type { BoardRequest, Selection } from "./renderers/mod.ts";

export type MatchStatus =
  | { readonly kind: "finished"; readonly outcome: OutcomeText }
  /** This browser holds the token of the Seat to move. */
  | { readonly kind: "your-move"; readonly seat: Seat; readonly token: string }
  /** Someone else (an Engine or another person) is to move. */
  | {
    readonly kind: "waiting";
    readonly seat: Seat;
    readonly player: PlayerSpec | undefined;
  };

export function matchStatus(
  match: MatchView,
  tokens: Readonly<Record<Seat, string>>,
): MatchStatus {
  if (match.outcome) {
    return { kind: "finished", outcome: describeOutcome(match.outcome) };
  }
  // A Match without an Outcome always has a Seat to move.
  const seat = match.toMove ?? "";
  const token = tokens[seat];
  if (token !== undefined && match.seats[seat]?.kind === "human") {
    return { kind: "your-move", seat, token };
  }
  return { kind: "waiting", seat, player: match.seats[seat] };
}

/** What the board shows; legal Moves only when this browser may play. */
export function boardRequest(
  match: MatchView,
  status: MatchStatus,
  selection: Selection,
): BoardRequest {
  return {
    position: match.position,
    moves: match.moves,
    legalMoves: status.kind === "your-move" ? match.legalMoves : [],
    selection,
  };
}

export interface MoveListRow {
  /** 1-based Move number: one Move per Seat. */
  readonly number: number;
  readonly moves: readonly string[];
}

/** Move list grouped in pairs, as Seats alternate in two-Seat Games (ADR 0003). */
export function moveListRows(moves: readonly string[]): MoveListRow[] {
  const rows: MoveListRow[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    rows.push({ number: i / 2 + 1, moves: moves.slice(i, i + 2) });
  }
  return rows;
}

/**
 * Seats this browser may hand to an Opponent with a share link: its human
 * Seats while it holds more than one (e.g. right after creating a human vs
 * human Match) and the Match is not finished.
 */
export function shareableSeats(
  match: MatchView,
  tokens: Readonly<Record<Seat, string>>,
): Seat[] {
  if (match.outcome) return [];
  const seats = Object.keys(match.seats).filter((seat) =>
    tokens[seat] !== undefined && match.seats[seat]?.kind === "human"
  );
  return seats.length > 1 ? seats : [];
}

/** "Human", or the Engine's name when known (else its id). */
export function playerLabel(
  player: PlayerSpec | undefined,
  engineNames: ReadonlyMap<string, string> = new Map(),
): string {
  if (!player) return "Unknown";
  if (player.kind === "human") return "Human";
  return `Engine: ${engineNames.get(player.engineId) ?? player.engineId}`;
}

/** A Seat assignment from the new Match form: `"human"` or an Engine id. */
export type SeatChoice = "human" | { readonly engineId: string };

/**
 * Players for a new Match. `maxTimeMs` (if set) limits each Engine's thinking
 * time per Move.
 */
export function seatPlayers(
  choices: Readonly<Record<Seat, SeatChoice>>,
  maxTimeMs?: number,
): Record<Seat, PlayerSpec> {
  const players: Record<Seat, PlayerSpec> = {};
  for (const [seat, choice] of Object.entries(choices)) {
    players[seat] = choice === "human" ? { kind: "human" } : {
      kind: "engine",
      engineId: choice.engineId,
      ...(maxTimeMs === undefined ? {} : { limits: { maxTimeMs } }),
    };
  }
  return players;
}
