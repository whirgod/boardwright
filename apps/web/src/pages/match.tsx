import type { Seat } from "@boardwright/core";
import { useEffect, useMemo, useState } from "preact/hooks";
import { type ApiClient, ApiError, type MatchView } from "../api.ts";
import { Board } from "../board.tsx";
import { errorMessage } from "../errors.ts";
import {
  boardRequest,
  invites,
  type MatchStatus,
  matchStatus,
  moveListRows,
  playerLabel,
} from "../match-state.ts";
import { seatLabel } from "../outcome.ts";
import { poll } from "../poller.ts";
import { type BoardModel, gameView, type Selection } from "../renderers/mod.ts";
import { routeHash, shareLink } from "../route.ts";
import {
  playingTokens,
  type SeatHolding,
  type SeatTokens,
} from "../seat-tokens.ts";

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
  const [holding, setHolding] = useState(() => tokens.get(matchId));
  const [notice, setNotice] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>([]);
  const [busy, setBusy] = useState(false);
  const [engineNames, setEngineNames] = useState(new Map<string, string>());
  const [reload, setReload] = useState(0);

  // A share link hands this browser a Seat: keep its token (never replacing
  // one already held), drop it from the URL.
  useEffect(() => {
    if (invite) {
      const kept = tokens.add(matchId, { [invite.seat]: invite.token });
      history.replaceState(null, "", routeHash({ page: "match", matchId }));
      if (kept.length > 0) {
        setNotice(
          `This browser already holds Seat ${
            seatLabel(invite.seat)
          }; the link was not used.`,
        );
      }
    }
    setHolding(tokens.get(matchId));
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

  const playing = useMemo(() => playingTokens(holding), [holding]);
  const status = useMemo(() => match && matchStatus(match, playing), [
    match,
    playing,
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

  async function resign(token: string) {
    if (busy) return;
    setBusy(true);
    try {
      setMatch(await api.resign(matchId, token));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.status === 409) setReload((n) => n + 1);
    } finally {
      setSelection([]);
      setBusy(false);
    }
  }

  const request = boardRequest(match, status, selection);
  const interactive = status.kind === "your-move" && !busy;
  let board: BoardModel | undefined;
  let boardError: string | undefined;
  try {
    board = view?.board(request);
  } catch (e) {
    // E.g. a UI bundle out of sync with the server's Notation: show the text.
    boardError = errorMessage(e);
  }
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
      {notice && <p class="notice">{notice}</p>}
      <div class="match-layout">
        <div>
          {boardError && (
            <p class="error" role="alert">
              Cannot draw this Position: {boardError}
            </p>
          )}
          {board ? <Board model={board} onTarget={onTarget} /> : (
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
                {playing[seat] !== undefined && " (you)"}
                {holding.handedOver.includes(seat) && " (handed over)"}
              </li>
            ))}
          </ul>
          {match.outcome === null &&
            Object.entries(playing).map(([seat, token]) => (
              <div key={seat} class="field">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (
                      confirm(
                        `Resign as ${seatLabel(seat)}? The Opponent wins.`,
                      )
                    ) {
                      resign(token);
                    }
                  }}
                >
                  Resign as {seatLabel(seat)}
                </button>
              </div>
            ))}
          <InviteBox
            match={match}
            holding={holding}
            onHandOver={(seat) => {
              tokens.handOver(matchId, seat);
              setHolding(tokens.get(matchId));
              setSelection([]);
            }}
            onTakeBack={(seat) => {
              tokens.takeBack(matchId, seat);
              setHolding(tokens.get(matchId));
            }}
          />
          <h2>Move list</h2>
          {match.moves.length === 0
            ? <p class="muted">No Moves yet.</p>
            : (
              <ol class="moves">
                {moveListRows(match.moves).map((row) => (
                  <li key={row.number} value={row.number}>
                    {row.entries.map((entry, i) =>
                      entry.kind === "move"
                        ? <span key={i}>{i > 0 && " "}{entry.move}</span>
                        : (
                          <span key={i} class="chance" title="Chance event">
                            {i > 0 && " "}({entry.chance})
                          </span>
                        )
                    )}
                  </li>
                ))}
              </ol>
            )}
          {match.seed !== undefined && (
            <p class="muted seed">
              Chance events were drawn from seed <code>{match.seed}</code>.
            </p>
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
    case "chance":
      return <>The Game master is rolling…</>;
  }
}

/**
 * Hands a human Seat to an Opponent: this browser stops playing it (the token
 * is kept, so it can be taken back) and shows its share link.
 */
function InviteBox(
  { match, holding, onHandOver, onTakeBack }: {
    match: MatchView;
    holding: SeatHolding;
    onHandOver: (seat: Seat) => void;
    onTakeBack: (seat: Seat) => void;
  },
) {
  const list = invites(match, holding);
  if (list.length === 0) return null;
  const origin = `${location.origin}${location.pathname.replace(/\/$/, "")}`;
  return (
    <>
      <h2>Invite an Opponent</h2>
      <p class="muted">
        Give away the Seat you do not play, then send its link. Whoever opens it
        plays that Seat, so share it only with your Opponent.
      </p>
      {list.map((invite) =>
        invite.handedOver
          ? (
            <div key={invite.seat} class="field">
              <label>
                <span>Link for Seat {seatLabel(invite.seat)}</span>
                <input
                  readOnly
                  value={shareLink(
                    origin,
                    match.id,
                    invite.seat,
                    invite.token,
                  )}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </label>
              <button type="button" onClick={() => onTakeBack(invite.seat)}>
                Play Seat {seatLabel(invite.seat)} here again
              </button>
            </div>
          )
          : invite.canHandOver && (
            <div key={invite.seat} class="field">
              <button type="button" onClick={() => onHandOver(invite.seat)}>
                Give Seat {seatLabel(invite.seat)} to my Opponent
              </button>
            </div>
          )
      )}
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
