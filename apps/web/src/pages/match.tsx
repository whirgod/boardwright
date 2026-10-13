import type { Seat } from "@boardwright/core";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { analysisOf } from "../analysis-client.ts";
import {
  AnalysisPanel,
  type AnalysisSettings,
  useAnalysis,
} from "../analysis-panel.tsx";
import { overlay } from "../analysis-view.ts";
import {
  type ApiClient,
  ApiError,
  type EngineInfo,
  type MatchView,
} from "../api.ts";
import { Board } from "../board.tsx";
import { errorMessage } from "../errors.ts";
import { MatchFeed } from "../match-feed.ts";
import {
  analysisWanted,
  boardRequest,
  invites,
  type MatchStatus,
  matchStatus,
  playerLabel,
} from "../match-state.ts";
import { MoveList, ReviewBar } from "../move-list.tsx";
import { seatLabel } from "../outcome.ts";
import { type BoardModel, gameView, type Selection } from "../renderers/mod.ts";
import {
  keyAction,
  navigate,
  replay,
  type ReviewAction,
  type ReviewPly,
  shownPly,
} from "../review.ts";
import { routeHash, shareLink } from "../route.ts";
import {
  playingTokens,
  type SeatHolding,
  type SeatTokens,
} from "../seat-tokens.ts";
import type { Connect } from "../socket.ts";

export function MatchPage(
  { api, connect, tokens, matchId, invite }: {
    api: ApiClient;
    connect: Connect;
    tokens: SeatTokens;
    matchId: string;
    invite?: { seat: Seat; token: string } | undefined;
  },
) {
  const [match, setMatch] = useState<MatchView | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [holding, setHolding] = useState(() => tokens.get(matchId));
  const [notice, setNotice] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>([]);
  const [busy, setBusy] = useState(false);
  const [engines, setEngines] = useState<readonly EngineInfo[]>([]);
  const [review, setReview] = useState<ReviewPly>("live");
  const [analysisOn, setAnalysisOn] = useState<boolean | undefined>();
  const [settings, setSettings] = useState<AnalysisSettings>({
    engineId: undefined,
    lines: 3,
    maxTimeMs: 5000,
  });
  const [previewed, setPreviewed] = useState<number | undefined>();
  const feed = useRef<MatchFeed | undefined>(undefined);

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

  // Follow the Match over its stream (REST catches up when it drops).
  useEffect(() => {
    const following = new MatchFeed({
      matchId,
      connect,
      load: (id) => api.getMatch(id),
      onMatch: setMatch,
      onError: (e) => setFeedError(e === null ? null : errorMessage(e)),
      onLive: setLive,
    });
    feed.current = following;
    return () => following.close();
  }, [api, connect, matchId]);

  const gameId = match?.gameId;
  useEffect(() => {
    if (gameId === undefined) return;
    api.listEngines(gameId).then(
      (list) => {
        setEngines(list);
        setSettings((s) => ({ ...s, engineId: s.engineId ?? list[0]?.id }));
      },
      () => {}, // Names are cosmetic; without the list there is no analysis.
    );
  }, [api, gameId]);
  const engineNames = useMemo(
    () => new Map(engines.map((e) => [e.id, e.name])),
    [engines],
  );

  const playing = useMemo(() => playingTokens(holding), [holding]);
  const status = useMemo(() => match && matchStatus(match, playing), [
    match,
    playing,
  ]);
  const moves = match?.moves;
  const replayed = useMemo(
    () => gameId === undefined || !moves ? undefined : replay(gameId, moves),
    [gameId, moves],
  );
  const length = moves?.length ?? 0;
  const ply = shownPly(review, length);
  const current = ply === length;
  // The current Position comes from the server; earlier ones from the replay.
  const step = !match
    ? undefined
    : current
    ? { position: match.position, toMove: match.toMove ?? undefined }
    : replayed?.steps[ply];

  const go = (action: ReviewAction) => {
    setReview((r) => navigate(r, action, length));
    setSelection([]);
  };

  // Keyboard review: arrows step, Home/End jump (not while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const action = keyAction({
        key: e.key,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        targetTag: target?.tagName,
        targetRole: target?.getAttribute("role") ?? undefined,
        targetEditable: target instanceof HTMLElement &&
          target.isContentEditable,
        // Keys in the Analysis panel (Line buttons, selects) stay there.
        ownKeys: target !== null && target.closest(".analysis") !== null,
      });
      if (!action) return;
      e.preventDefault();
      go(action);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [length]);

  // Analysis: off by default while this browser plays a Seat in a running
  // Match; on for Spectators and finished Matches.
  const wanted = analysisWanted(match, playing, analysisOn);
  const analysing = wanted && engines.length > 0 && step !== undefined;
  const analysis = useAnalysis(
    connect,
    analysing && gameId !== undefined && settings.engineId !== undefined
      ? {
        gameId,
        engineId: settings.engineId,
        position: step.position,
        lines: settings.lines,
        maxTimeMs: settings.maxTimeMs,
      }
      : undefined,
  );
  const shownAnalysis = analysing
    ? analysisOf(analysis.state, step?.position)
    : undefined;
  useEffect(() => setPreviewed(undefined), [step?.position]);

  const view = gameId === undefined ? undefined : gameView(gameId);

  if (!match || !status) {
    return feedError
      ? <p class="error" role="alert">{feedError}</p>
      : <p>Loading Match…</p>;
  }

  async function play(move: string, now: MatchStatus) {
    if (now.kind !== "your-move" || busy) return;
    setBusy(true);
    try {
      feed.current?.offer(await api.playMove(matchId, move, now.token));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
      // The Match moved on (e.g. an Engine replied): show the current state.
      if (e instanceof ApiError && e.status === 409) feed.current?.reload();
    } finally {
      setSelection([]);
      setBusy(false);
    }
  }

  async function resign(token: string) {
    if (busy) return;
    setBusy(true);
    try {
      feed.current?.offer(await api.resign(matchId, token));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.status === 409) feed.current?.reload();
    } finally {
      setSelection([]);
      setBusy(false);
    }
  }

  const request = step && boardRequest(
    match,
    status,
    selection,
    { ply, position: step.position },
    overlay(shownAnalysis, previewed),
  );
  const interactive = current && status.kind === "your-move" && !busy;
  let board: BoardModel | undefined;
  let boardError: string | undefined;
  try {
    board = request && view?.board(request);
  } catch (e) {
    // E.g. a UI bundle out of sync with the server's Notation: show the text.
    boardError = errorMessage(e);
  }
  const onTarget = view && request && interactive
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
      {feedError && <p class="error" role="alert">{feedError}</p>}
      {!live && match.outcome === null && !feedError && (
        <p class="notice">Reconnecting to the Match…</p>
      )}
      {error && <p class="error" role="alert">{error}</p>}
      {notice && <p class="notice">{notice}</p>}
      <div class="match-layout">
        <div>
          {boardError && (
            <p class="error" role="alert">
              Cannot draw this Position: {boardError}
            </p>
          )}
          {!step && (
            <p class="error" role="alert">
              Cannot show this Position{replayed?.error
                ? `: ${replayed.error}`
                : "."}
            </p>
          )}
          {step &&
            (board
              ? <Board model={board} onTarget={onTarget} />
              : (
                <FallbackBoard
                  position={step.position}
                  legalMoves={interactive ? match.legalMoves : []}
                  onMove={interactive
                    ? (move) => play(move, status)
                    : undefined}
                />
              ))}
          <ReviewBar entries={match.moves} ply={ply} onGo={go} />
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
          <AnalysisPanel
            enabled={wanted}
            onEnabled={setAnalysisOn}
            engines={engines}
            settings={settings}
            onSettings={setSettings}
            state={analysis.state}
            analysis={shownAnalysis}
            toMove={step?.toMove}
            previewed={previewed}
            onPreview={setPreviewed}
            onRetry={analysis.retry}
          />
          <h2>Move list</h2>
          <MoveList
            entries={match.moves}
            ply={ply}
            onGo={(target) => go({ kind: "go", ply: target })}
          />
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
  { position, legalMoves, onMove }: {
    position: string;
    legalMoves: readonly string[];
    onMove?: ((move: string) => void) | undefined;
  },
) {
  return (
    <div class="fallback-board">
      <p class="muted">No board for this Game yet. Position:</p>
      <pre>{position}</pre>
      {onMove && (
        <div class="legal-moves">
          {legalMoves.map((move) => (
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
