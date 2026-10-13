// DOM-free view logic of the Match page.
import type { Seat } from "@boardwright/core";
import type { MatchView, PlayerSpec } from "./api.ts";
import { describeOutcome, type OutcomeText } from "./outcome.ts";
import type { BoardRequest, Selection } from "./renderers/mod.ts";
import type { SeatHolding } from "./seat-tokens.ts";

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

/** A human Seat this browser holds, as offered in the "Invite an Opponent" box. */
export interface Invite {
  readonly seat: Seat;
  readonly token: string;
  /** Already given away: show its share link and offer to take it back. */
  readonly handedOver: boolean;
  /** May be given away now: before the first Move, and never the last Seat played here. */
  readonly canHandOver: boolean;
}

/**
 * Seats this browser can hand to an Opponent, when it holds more than one
 * human Seat (e.g. it created a human vs human Match). Handing over is
 * possible before the first Move; a handed-over Seat's link stays visible
 * until each Seat has moved (the Opponent has used it).
 */
export function invites(match: MatchView, holding: SeatHolding): Invite[] {
  if (match.outcome || match.moves.length >= 2) return [];
  const seats = Object.keys(match.seats).filter((seat) =>
    holding.tokens[seat] !== undefined && match.seats[seat]?.kind === "human"
  );
  if (seats.length < 2) return [];
  const playing = seats.filter((s) => !holding.handedOver.includes(s));
  const result = seats.map((seat) => ({
    seat,
    token: holding.tokens[seat]!,
    handedOver: holding.handedOver.includes(seat),
    canHandOver: match.moves.length === 0 && playing.length > 1 &&
      playing.includes(seat),
  }));
  return result.some((i) => i.handedOver || i.canHandOver) ? result : [];
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
