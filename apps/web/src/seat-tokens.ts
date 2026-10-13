// Seat tokens this browser holds, per Match. They never leave the client
// except in a Move request or a share link the user copies. The server shows
// a token only once, so a held token is never overwritten or deleted.
import type { Seat } from "@boardwright/core";

/** The subset of the Web Storage API this module needs. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** What this browser holds for one Match. */
export interface SeatHolding {
  /** Seat to token, for every Seat this browser ever received. */
  readonly tokens: Readonly<Record<Seat, string>>;
  /**
   * Seats handed to an Opponent via a share link: their tokens are kept (so
   * nothing is lost), but this browser no longer plays them.
   */
  readonly handedOver: readonly Seat[];
}

const PREFIX = "boardwright:seat-tokens:";
const EMPTY: SeatHolding = { tokens: {}, handedOver: [] };

function parse(raw: string | null | undefined): SeatHolding {
  if (!raw) return EMPTY;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return EMPTY;
  const { tokens, handedOver } = parsed as Record<string, unknown>;
  return {
    tokens: typeof tokens === "object" && tokens !== null &&
        !Array.isArray(tokens)
      ? Object.fromEntries(
        Object.entries(tokens).filter(([, v]) => typeof v === "string"),
      )
      : {},
    handedOver: Array.isArray(handedOver)
      ? handedOver.filter((s): s is string => typeof s === "string")
      : [],
  };
}

/** Tokens of the Seats this browser plays: held and not handed over. */
export function playingTokens(
  holding: SeatHolding,
): Readonly<Record<Seat, string>> {
  return Object.fromEntries(
    Object.entries(holding.tokens).filter(([seat]) =>
      !holding.handedOver.includes(seat)
    ),
  );
}

export class SeatTokens {
  readonly #storage: KeyValueStorage | undefined;
  readonly #memory = new Map<string, SeatHolding>();

  /** Without storage (e.g. blocked), tokens live only as long as this object. */
  constructor(storage: KeyValueStorage | undefined) {
    this.#storage = storage;
  }

  get(matchId: string): SeatHolding {
    const remembered = this.#memory.get(matchId);
    if (remembered) return remembered;
    try {
      return parse(this.#storage?.getItem(PREFIX + matchId));
    } catch {
      return EMPTY;
    }
  }

  /**
   * Adds tokens for a Match. A Seat that already has a different token keeps
   * it (a wrong or malicious share link cannot lock its holder out); those
   * Seats are returned.
   */
  add(matchId: string, tokens: Readonly<Record<Seat, string>>): Seat[] {
    const current = this.get(matchId);
    const kept: Seat[] = [];
    const merged: Record<Seat, string> = { ...current.tokens };
    for (const [seat, token] of Object.entries(tokens)) {
      const held = merged[seat];
      if (held === undefined) merged[seat] = token;
      else if (held !== token) kept.push(seat);
    }
    this.#save(matchId, { ...current, tokens: merged });
    return kept;
  }

  /** Stops playing `seat` here after sharing it; its token is kept. */
  handOver(matchId: string, seat: Seat): void {
    const current = this.get(matchId);
    if (current.handedOver.includes(seat)) return;
    this.#save(matchId, {
      ...current,
      handedOver: [...current.handedOver, seat],
    });
  }

  /** Plays a handed-over Seat here again. */
  takeBack(matchId: string, seat: Seat): void {
    const current = this.get(matchId);
    this.#save(matchId, {
      ...current,
      handedOver: current.handedOver.filter((s) => s !== seat),
    });
  }

  #save(matchId: string, holding: SeatHolding): void {
    this.#memory.set(matchId, holding);
    try {
      this.#storage?.setItem(PREFIX + matchId, JSON.stringify(holding));
    } catch {
      // Storage full or blocked: keep the in-memory copy.
    }
  }
}
