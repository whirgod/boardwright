import type { ComponentChildren } from "preact";
import { useEffect, useErrorBoundary, useState } from "preact/hooks";
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

/** Keeps a failing page from blanking the whole UI. */
function PageGuard({ children }: { children: ComponentChildren }) {
  const [error, reset] = useErrorBoundary((e) => console.error(e));
  if (!error) return <>{children}</>;
  return (
    <div class="error" role="alert">
      <p>Something went wrong: {String(error?.message ?? error)}</p>
      <button type="button" onClick={reset}>Try again</button>
    </div>
  );
}

export function App({ api, tokens }: { api: ApiClient; tokens: SeatTokens }) {
  const route = useRoute();
  return (
    <>
      <header>
        <a class="brand" href={routeHash({ page: "games" })}>Boardwright</a>
      </header>
      <main>
        <PageGuard key={routeHash(route)}>
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
        </PageGuard>
      </main>
    </>
  );
}
