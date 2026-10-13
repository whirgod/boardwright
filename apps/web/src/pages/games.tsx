import { useEffect, useState } from "preact/hooks";
import type { ApiClient, GameInfo } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { seatLabel } from "../outcome.ts";
import { routeHash } from "../route.ts";

export function GamesPage({ api }: { api: ApiClient }) {
  const [games, setGames] = useState<GameInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listGames().then(setGames, (e) => setError(errorMessage(e)));
  }, [api]);

  return (
    <section>
      <h1>Games</h1>
      {error && <p class="error" role="alert">{error}</p>}
      {games === null && !error && <p>Loading…</p>}
      {games?.length === 0 && <p>This server hosts no Games.</p>}
      <ul class="games">
        {games?.map((game) => (
          <li key={game.id}>
            <a href={routeHash({ page: "new-match", gameId: game.id })}>
              {game.name}
            </a>
            <span class="muted seats-hint">
              Seats: {game.seats.map(seatLabel).join(", ")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
