import { useEffect, useState } from "preact/hooks";
import type { ApiClient } from "./api.ts";
import { GamesPage } from "./pages/games.tsx";
import { MatchPage } from "./pages/match.tsx";
import { NewMatchPage } from "./pages/new-match.tsx";
import { parseRoute, type Route, routeHash } from "./route.ts";
import type { SeatTokens } from "./seat-tokens.ts";

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  return route;
}

export function App({ api, tokens }: { api: ApiClient; tokens: SeatTokens }) {
  const route = useRoute();
  return (
    <>
      <header>
        <a class="brand" href={routeHash({ page: "games" })}>Boardwright</a>
      </header>
      <main>
        {route.page === "games" && <GamesPage api={api} />}
        {route.page === "new-match" && (
          <NewMatchPage api={api} tokens={tokens} gameId={route.gameId} />
        )}
        {route.page === "match" && (
          <MatchPage
            key={route.matchId}
            api={api}
            tokens={tokens}
            matchId={route.matchId}
            invite={route.invite}
          />
        )}
        {route.page === "not-found" && (
          <p class="error">
            Nothing here. <a href={routeHash({ page: "games" })}>Games</a>
          </p>
        )}
      </main>
    </>
  );
}
