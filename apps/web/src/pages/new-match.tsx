import type { GameId, Seat } from "@boardwright/core";
import { useEffect, useState } from "preact/hooks";
import type { ApiClient, EngineInfo, GameInfo } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type SeatChoice, seatPlayers } from "../match-state.ts";
import { seatLabel } from "../outcome.ts";
import { routeHash } from "../route.ts";
import type { SeatTokens } from "../seat-tokens.ts";

const HUMAN = "human";

export function NewMatchPage(
  { api, tokens, gameId }: {
    api: ApiClient;
    tokens: SeatTokens;
    gameId: GameId;
  },
) {
  const [game, setGame] = useState<GameInfo | null | undefined>(undefined);
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [choices, setChoices] = useState<Record<Seat, string>>({});
  const [maxTime, setMaxTime] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api.listGames(), api.listEngines(gameId)]).then(
      ([games, engines]) => {
        const found = games.find((g) => g.id === gameId) ?? null;
        setGame(found);
        setEngines(engines);
        if (found) {
          setChoices(Object.fromEntries(found.seats.map((s) => [s, HUMAN])));
        }
      },
      (e) => setError(errorMessage(e)),
    );
  }, [api, gameId]);

  async function submit(event: Event) {
    event.preventDefault();
    if (!game) return;
    const seats: Record<Seat, SeatChoice> = {};
    for (const seat of game.seats) {
      const choice = choices[seat] ?? HUMAN;
      seats[seat] = choice === HUMAN ? "human" : { engineId: choice };
    }
    const ms = maxTime.trim() === "" ? undefined : Number(maxTime);
    setBusy(true);
    setError(null);
    try {
      const created = await api.createMatch(game.id, seatPlayers(seats, ms));
      tokens.add(created.match.id, created.tokens);
      location.hash = routeHash({ page: "match", matchId: created.match.id });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  if (game === null) return <p class="error">Unknown Game “{gameId}”.</p>;
  return (
    <section>
      <h1>New Match{game && `: ${game.name}`}</h1>
      {error && <p class="error" role="alert">{error}</p>}
      {game === undefined && !error && <p>Loading…</p>}
      {game && (
        <form onSubmit={submit}>
          {game.seats.map((seat) => (
            <label key={seat} class="field">
              <span>Seat {seatLabel(seat)}</span>
              <select
                value={choices[seat] ?? HUMAN}
                onChange={(e) =>
                  setChoices({ ...choices, [seat]: e.currentTarget.value })}
              >
                <option value={HUMAN}>Human</option>
                {engines.map((engine) => (
                  <option key={engine.id} value={engine.id}>
                    Engine: {engine.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {engines.length > 0 && (
            <label class="field">
              <span>Engine time per Move (ms, optional)</span>
              <input
                type="number"
                min="0"
                max="60000"
                step="100"
                value={maxTime}
                onInput={(e) => setMaxTime(e.currentTarget.value)}
              />
            </label>
          )}
          <button type="submit" disabled={busy}>Start Match</button>
        </form>
      )}
    </section>
  );
}
