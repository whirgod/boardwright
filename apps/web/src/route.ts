// Hash routes, so the server only serves static files (no fallback routing).
import type { GameId, Seat } from "@boardwright/core";

export type Route =
  | { readonly page: "games" }
  | { readonly page: "new-match"; readonly gameId: GameId }
  | {
    readonly page: "match";
    readonly matchId: string;
    /** A seat token handed over in a share link; stored, then dropped from the URL. */
    readonly invite?: { readonly seat: Seat; readonly token: string };
  }
  | { readonly page: "not-found"; readonly hash: string };

function decode(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}

/** Parses `location.hash`, e.g. `#/matches/abc?seat=o&token=...`. */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [path = "", query = ""] = raw.split("?", 2);
  const parts = path.split("/").filter((p) => p !== "").map(decode);
  if (parts.some((p) => p === undefined)) return { page: "not-found", hash };
  if (parts.length === 0) return { page: "games" };
  if (parts.length === 3 && parts[0] === "games" && parts[2] === "new") {
    return { page: "new-match", gameId: parts[1]! };
  }
  if (parts.length === 2 && parts[0] === "matches") {
    const params = new URLSearchParams(query);
    const seat = params.get("seat");
    const token = params.get("token");
    return seat && token
      ? { page: "match", matchId: parts[1]!, invite: { seat, token } }
      : { page: "match", matchId: parts[1]! };
  }
  return { page: "not-found", hash };
}

/** The hash for a route (without any invite). */
export function routeHash(route: Route): string {
  switch (route.page) {
    case "games":
      return "#/";
    case "new-match":
      return `#/games/${encodeURIComponent(route.gameId)}/new`;
    case "match":
      return `#/matches/${encodeURIComponent(route.matchId)}`;
    case "not-found":
      return route.hash;
  }
}

/**
 * A link that hands one Seat to another person: whoever opens it holds that
 * Seat's token. The token travels in the URL fragment, which browsers do not
 * send to the server.
 */
export function shareLink(
  origin: string,
  matchId: string,
  seat: Seat,
  token: string,
): string {
  const query = new URLSearchParams({ seat, token });
  return `${origin}/${routeHash({ page: "match", matchId })}?${query}`;
}
