// DOM-free view logic of the Match page.
import type { Seat } from "@boardwright/core";
import type { Overlay } from "./analysis-view.ts";
import type { MatchView, MoveListEntry, PlayerSpec } from "./api.ts";
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
  }
  /** A Chance event is pending: the Game master is about to roll. */
  | { readonly kind: "chance" };

export function matchStatus(
  match: MatchView,
  tokens: Readonly<Record<Seat, string>>,
): MatchStatus {
  if (match.outcome) {
    return { kind: "finished", outcome: describeOutcome(match.outcome) };
  }
  // Without an Outcome, no Seat to move means a pending Chance event.
  if (match.toMove === null) return { kind: "chance" };
  const seat = match.toMove;
  const token = tokens[seat];
  if (token !== undefined && match.seats[seat]?.kind === "human") {
    return { kind: "your-move", seat, token };
  }
  return { kind: "waiting", seat, player: match.seats[seat] };
}

/** A Position reviewed instead of the current one. */
export interface ShownPosition {
  /** Move list entries played to reach it. */
  readonly ply: number;
  /** It in Notation (rebuilt by replaying the Move list). */
  readonly position: string;
}

/**
 * What the board shows: the current Position, or `shown` (an earlier one,
 * read-only); legal Moves only at the current Position when this browser may
 * play. `overlay` adds Analysis arrows.
 */
export function boardRequest(
  match: MatchView,
  status: MatchStatus,
  selection: Selection,
  shown?: ShownPosition,
  overlay?: Overlay,
): BoardRequest {
  const current = shown === undefined || shown.ply >= match.moves.length;
  return {
    position: current ? match.position : shown.position,
    entries: current ? match.moves : match.moves.slice(0, shown.ply),
    legalMoves: current && status.kind === "your-move" ? match.legalMoves : [],
    selection: current ? selection : [],
    ...(overlay
      ? {
        arrows: overlay.arrows,
        ...(overlay.preview ? { preview: overlay.preview } : {}),
      }
      : {}),
  };
}

/** The Moves of a Move list, without its Chance events. */
export function movesOnly(entries: readonly MoveListEntry[]): string[] {
  return entries.flatMap((e) => e.kind === "move" ? [e.move] : []);
}

export interface MoveListRow {
  /** 1-based Move number: one Move per Seat. */
  readonly number: number;
  /** Up to two Moves, each with the Chance events right before it. */
  readonly entries: readonly MoveListEntry[];
  /** Index of the row's first entry in the Move list (reviewing entry `i` shows ply `i + 1`). */
  readonly first: number;
}

/**
 * Move list grouped in pairs of Moves, as Seats alternate in two-Seat Games
 * (ADR 0003). A Chance event goes in the row of the Move that follows it.
 */
export function moveListRows(entries: readonly MoveListEntry[]): MoveListRow[] {
  const rows: MoveListRow[] = [];
  let row: MoveListEntry[] = [];
  let first = 0;
  let moves = 0;
  for (const [i, entry] of entries.entries()) {
    if (moves === 2) {
      rows.push({ number: rows.length + 1, entries: row, first });
      row = [];
      first = i;
      moves = 0;
    }
    row.push(entry);
    if (entry.kind === "move") moves++;
  }
  if (row.length > 0) {
    rows.push({ number: rows.length + 1, entries: row, first });
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
  const moves = movesOnly(match.moves).length;
  if (match.outcome || moves >= 2) return [];
  const seats = Object.keys(match.seats).filter((seat) =>
    holding.tokens[seat] !== undefined && match.seats[seat]?.kind === "human"
  );
  if (seats.length < 2) return [];
  const playing = seats.filter((s) => !holding.handedOver.includes(s));
  const result = seats.map((seat) => ({
    seat,
    token: holding.tokens[seat]!,
    handedOver: holding.handedOver.includes(seat),
    canHandOver: moves === 0 && playing.length > 1 &&
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

/**
 * Whether Engine analysis runs: the viewer's choice (`override`) if made;
 * otherwise off while this browser plays a Seat of a running Match (no help
 * during play), on for Spectators and finished Matches.
 */
export function analysisWanted(
  match: MatchView | null,
  playing: Readonly<Record<Seat, string>>,
  override: boolean | undefined,
): boolean {
  if (override !== undefined) return override;
  return (match !== null && match.outcome !== null) ||
    Object.keys(playing).length === 0;
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
