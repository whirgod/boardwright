import type { Seat } from "@boardwright/core";
import { useEffect, useMemo, useState } from "preact/hooks";
import { type ApiClient, ApiError, type MatchView } from "../api.ts";
import { Board } from "../board.tsx";
import { errorMessage } from "../errors.ts";
import {
  boardRequest,
  type MatchStatus,
  matchStatus,
  moveListRows,
  playerLabel,
  shareableSeats,
} from "../match-state.ts";
import { seatLabel } from "../outcome.ts";
import { poll } from "../poller.ts";
import { gameView, type Selection } from "../renderers/mod.ts";
import { routeHash, shareLink } from "../route.ts";
import type { SeatTokens } from "../seat-tokens.ts";

const POLL_MS = 1000;

export function MatchPage(
  { api, tokens, matchId, invite }: {
    api: ApiClient;
    tokens: SeatTokens;
    matchId: string;
    invite?: { seat: Seat; token: string } | undefined;
  },
) {
  const [match, setMatch] = useState<MatchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState(() => tokens.get(matchId));
  const [selection, setSelection] = useState<Selection>([]);
  const [busy, setBusy] = useState(false);
  const [engineNames, setEngineNames] = useState(new Map<string, string>());
  const [reload, setReload] = useState(0);

  // A share link hands this browser a Seat: keep its token, drop it from the URL.
  useEffect(() => {
    if (invite) {
      tokens.add(matchId, { [invite.seat]: invite.token });
      history.replaceState(null, "", routeHash({ page: "match", matchId }));
    }
    setHeld(tokens.get(matchId));
  }, [tokens, matchId, invite?.seat, invite?.token]);

  useEffect(() => {
    const abort = new AbortController();
    poll({
      load: () => api.getMatch(matchId),
      onValue: (m) => {
        setMatch(m);
        setError(null);
      },
      onError: (e) => {
        setError(errorMessage(e));
        if (e instanceof ApiError && e.status === 404) abort.abort();
      },
      done: (m) => m.outcome !== null,
      intervalMs: POLL_MS,
      signal: abort.signal,
    });
    return () => abort.abort();
  }, [api, matchId, reload]);

  const gameId = match?.gameId;
  useEffect(() => {
    if (gameId === undefined) return;
    api.listEngines(gameId).then(
      (engines) => setEngineNames(new Map(engines.map((e) => [e.id, e.name]))),
      () => {}, // Names are cosmetic; fall back to Engine ids.
    );
  }, [api, gameId]);

  const status = useMemo(() => match && matchStatus(match, held), [
    match,
    held,
  ]);
  const view = gameId === undefined ? undefined : gameView(gameId);

  if (!match || !status) {
    return error
      ? <p class="error" role="alert">{error}</p>
      : <p>Loading Match…</p>;
  }

  async function play(move: string, current: MatchStatus) {
    if (current.kind !== "your-move" || busy) return;
    setBusy(true);
    try {
      setMatch(await api.playMove(matchId, move, current.token));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
      // The Match moved on (e.g. an Engine replied): show the current state.
      if (e instanceof ApiError && e.status === 409) setReload((n) => n + 1);
    } finally {
      setSelection([]);
      setBusy(false);
    }
  }

  const request = boardRequest(match, status, selection);
  const interactive = status.kind === "your-move" && !busy;
  const onTarget = view && interactive
    ? (target: string) => {
      const click = view.click(request, target);
      if (click.kind === "move") play(click.move, status);
      else if (click.kind === "select") setSelection(click.selection);
      else setSelection([]);
    }
    : undefined;

  return (
    <section class="match">
      <h1>Match {match.id}</h1>
      <p class="status" aria-live="polite">
        <StatusText status={status} engineNames={engineNames} />
      </p>
      {error && <p class="error" role="alert">{error}</p>}
      <div class="match-layout">
        <div>
          {view
            ? <Board model={view.board(request)} onTarget={onTarget} />
            : (
              <FallbackBoard
                match={match}
                onMove={interactive ? (move) => play(move, status) : undefined}
              />
            )}
        </div>
        <aside>
          <h2>Seats</h2>
          <ul class="seats">
            {Object.entries(match.seats).map(([seat, player]) => (
              <li key={seat}>
                <strong>{seatLabel(seat)}</strong>:{" "}
                {playerLabel(player, engineNames)}
                {held[seat] !== undefined && " (you)"}
              </li>
            ))}
          </ul>
          <ShareLinks match={match} held={held} />
          <h2>Move list</h2>
          {match.moves.length === 0
            ? <p class="muted">No Moves yet.</p>
            : (
              <ol class="moves">
                {moveListRows(match.moves).map((row) => (
                  <li key={row.number} value={row.number}>
                    {row.moves.join(" ")}
                  </li>
                ))}
              </ol>
            )}
        </aside>
      </div>
    </section>
  );
}

function StatusText(
  { status, engineNames }: {
    status: MatchStatus;
    engineNames: ReadonlyMap<string, string>;
  },
) {
  switch (status.kind) {
    case "finished":
      return (
        <>
          <strong>{status.outcome.headline}</strong> — {status.outcome.detail}
        </>
      );
    case "your-move":
      return <>Your Move ({seatLabel(status.seat)}).</>;
    case "waiting":
      return (
        <>
          {seatLabel(status.seat)} to move
          {status.player?.kind === "engine"
            ? ` (${playerLabel(status.player, engineNames)} is thinking…)`
            : " (waiting for the Opponent)"}.
        </>
      );
  }
}

/** Links that hand a human Seat this browser holds to an Opponent. */
function ShareLinks(
  { match, held }: {
    match: MatchView;
    held: Readonly<Record<Seat, string>>;
  },
) {
  const seats = shareableSeats(match, held);
  if (seats.length === 0) return null;
  const origin = `${location.origin}${location.pathname.replace(/\/$/, "")}`;
  return (
    <>
      <h2>Invite an Opponent</h2>
      <p class="muted">
        Send the link of the Seat you do not play. Whoever opens it plays that
        Seat, so share it only with your Opponent.
      </p>
      {seats.map((seat) => (
        <label key={seat} class="field">
          <span>Seat {seatLabel(seat)}</span>
          <input
            readOnly
            value={shareLink(origin, match.id, seat, held[seat]!)}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
      ))}
    </>
  );
}

/** For Games without a board renderer: the Position in Notation and its legal Moves. */
function FallbackBoard(
  { match, onMove }: {
    match: MatchView;
    onMove?: ((move: string) => void) | undefined;
  },
) {
  return (
    <div class="fallback-board">
      <p class="muted">No board for this Game yet. Position:</p>
      <pre>{match.position}</pre>
      {onMove && (
        <div class="legal-moves">
          {match.legalMoves.map((move) => (
            <button
              key={move}
              type="button"
              onClick={() => onMove(move)}
            >
              {move}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
