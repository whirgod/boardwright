// Client for the server's HTTP API (docs/ARCHITECTURE.md, "API"). Positions
// and Moves are Notation strings. DOM-free: `fetch` is injected for tests.
import type { GameId, Outcome, SearchLimits, Seat } from "@boardwright/core";

export interface GameInfo {
  readonly id: GameId;
  readonly name: string;
  readonly seats: readonly Seat[];
}

export interface EngineInfo {
  readonly id: string;
  readonly name: string;
}

export type PlayerSpec =
  | { readonly kind: "human" }
  | {
    readonly kind: "engine";
    readonly engineId: string;
    readonly limits?: SearchLimits;
  };

export interface MatchView {
  readonly id: string;
  readonly gameId: GameId;
  readonly seats: Readonly<Record<Seat, PlayerSpec>>;
  readonly moves: readonly string[];
  readonly position: string;
  readonly toMove: Seat | null;
  readonly legalMoves: readonly string[];
  readonly outcome: Outcome | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatedMatch {
  readonly match: MatchView;
  /** Seat tokens of the human Seats; the server shows them only once. */
  readonly tokens: Readonly<Record<Seat, string>>;
}

/** An error response (`{ error: { code, message } }`) or a failed request. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    /** The server's error code, or `network` / `bad-response` for client-side failures. */
    readonly code: string,
    message: string,
    /** HTTP status; 0 when no response arrived. */
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ApiClientOptions {
  readonly fetch?: typeof fetch;
  /** Prefix for API paths; default "" (same origin). */
  readonly baseUrl?: string;
}

function isErrorBody(
  body: unknown,
): body is { error: { code: string; message: string } } {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return false;
  }
  const { error } = body;
  return typeof error === "object" && error !== null &&
    "code" in error && typeof error.code === "string" &&
    "message" in error && typeof error.message === "string";
}

export class ApiClient {
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(options: ApiClientOptions = {}) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#baseUrl = options.baseUrl ?? "";
  }

  listGames(): Promise<GameInfo[]> {
    return this.#request("GET", "/api/games");
  }

  listEngines(gameId: GameId): Promise<EngineInfo[]> {
    return this.#request(
      "GET",
      `/api/games/${encodeURIComponent(gameId)}/engines`,
    );
  }

  createMatch(
    gameId: GameId,
    seats: Readonly<Record<Seat, PlayerSpec>>,
  ): Promise<CreatedMatch> {
    return this.#request("POST", "/api/matches", { gameId, seats });
  }

  getMatch(id: string): Promise<MatchView> {
    return this.#request("GET", `/api/matches/${encodeURIComponent(id)}`);
  }

  playMove(id: string, move: string, token: string): Promise<MatchView> {
    return this.#request(
      "POST",
      `/api/matches/${encodeURIComponent(id)}/moves`,
      { move, token },
    );
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(this.#baseUrl + path, {
        method,
        headers: body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new ApiError(
        "network",
        `Could not reach the server: ${
          error instanceof Error ? error.message : String(error)
        }`,
        0,
      );
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new ApiError(
        "bad-response",
        `Unexpected response (HTTP ${response.status})`,
        response.status,
      );
    }
    if (!response.ok) {
      if (isErrorBody(parsed)) {
        throw new ApiError(
          parsed.error.code,
          parsed.error.message,
          response.status,
        );
      }
      throw new ApiError(
        "bad-response",
        `Request failed (HTTP ${response.status})`,
        response.status,
      );
    }
    return parsed as T;
  }
}
