// The Analysis panel: Engine settings, the live Score and the best Lines.
// Logic lives in `analysis-client.ts` / `analysis-view.ts`; this stays thin.
import type { Analysis, Seat } from "@boardwright/core";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  AnalysisClient,
  type AnalysisRequest,
  type AnalysisState,
} from "./analysis-client.ts";
import { summarize } from "./analysis-view.ts";
import type { EngineInfo } from "./api.ts";
import type { Connect } from "./socket.ts";

/** One `AnalysisClient` for the page; searches `request` whenever it changes. */
export function useAnalysis(
  connect: Connect,
  request: AnalysisRequest | undefined,
): { state: AnalysisState; retry: () => void } {
  const [state, setState] = useState<AnalysisState>({ kind: "idle" });
  const client = useMemo(
    () => new AnalysisClient({ connect, onState: setState }),
    [connect],
  );
  useEffect(() => () => client.close(), [client]);
  const key = request && JSON.stringify(request);
  useEffect(() => client.analyze(request), [client, key]);
  return { state, retry: () => client.retry() };
}

export interface AnalysisSettings {
  readonly engineId: string | undefined;
  readonly lines: number;
  readonly maxTimeMs: number;
}

const LINE_CHOICES = [1, 2, 3, 5];
const TIME_CHOICES = [1000, 5000, 15000, 30000];

export function AnalysisPanel(
  {
    enabled,
    onEnabled,
    engines,
    settings,
    onSettings,
    state,
    analysis,
    toMove,
    previewed,
    onPreview,
    onRetry,
  }: {
    enabled: boolean;
    onEnabled: (enabled: boolean) => void;
    engines: readonly EngineInfo[];
    settings: AnalysisSettings;
    onSettings: (settings: AnalysisSettings) => void;
    state: AnalysisState;
    /** The Analysis of the shown Position, if any yet. */
    analysis: Analysis<string> | undefined;
    toMove: Seat | undefined;
    previewed: number | undefined;
    onPreview: (line: number | undefined) => void;
    onRetry: () => void;
  },
) {
  const [pinned, setPinned] = useState<number | undefined>(undefined);
  const summary = analysis && summarize(analysis, toMove);
  // Another Position unpins the previewed Line.
  const position = state.kind === "idle" ? undefined : state.request.position;
  useEffect(() => setPinned(undefined), [position]);
  return (
    <section class="analysis" aria-labelledby="analysis-heading">
      <h2 id="analysis-heading">Engine analysis</h2>
      {engines.length === 0
        ? <p class="muted">No Engine can analyse this Game.</p>
        : (
          <>
            <label class="toggle">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => onEnabled(e.currentTarget.checked)}
              />{" "}
              Analyse the shown Position
            </label>
            {enabled && (
              <div class="analysis-settings">
                <label>
                  <span>Engine</span>
                  <select
                    value={settings.engineId}
                    onChange={(e) =>
                      onSettings({
                        ...settings,
                        engineId: e.currentTarget.value,
                      })}
                  >
                    {engines.map((e) => (
                      <option key={e.id} value={e.id}>{e.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Lines</span>
                  <select
                    value={String(settings.lines)}
                    onChange={(e) =>
                      onSettings({
                        ...settings,
                        lines: Number(e.currentTarget.value),
                      })}
                  >
                    {LINE_CHOICES.map((n) => (
                      <option key={n} value={String(n)}>{n}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Time</span>
                  <select
                    value={String(settings.maxTimeMs)}
                    onChange={(e) =>
                      onSettings({
                        ...settings,
                        maxTimeMs: Number(e.currentTarget.value),
                      })}
                  >
                    {TIME_CHOICES.map((ms) => (
                      <option key={ms} value={String(ms)}>{ms / 1000} s</option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </>
        )}
      {enabled && state.kind !== "idle" && (
        <>
          <p class="analysis-status">
            {summary?.score && (
              <strong
                class="score"
                title={summary.score.description}
                aria-hidden="true"
              >
                {summary.expected ? "Expected " : ""}
                {summary.score.text}
              </strong>
            )}
            {summary && <span class="muted">depth {summary.depth}</span>}
            <span class="muted">
              {state.kind === "running"
                ? "searching…"
                : state.kind === "done"
                ? "done"
                : ""}
            </span>
          </p>
          {summary?.score && (
            <p class="visually-hidden">{summary.score.description}</p>
          )}
          {summary && summary.lines.length === 0 && !summary.score && (
            <p class="muted">No Lines: the Match is over in this Position.</p>
          )}
          {state.kind === "error" && (
            <p class="error" role="alert">
              {state.message}{" "}
              <button type="button" onClick={onRetry}>Try again</button>
            </p>
          )}
          {summary && summary.lines.length > 0 && (
            <ol class="lines" aria-label="Best Lines">
              {summary.lines.map((line) => (
                <li key={line.rank}>
                  <button
                    type="button"
                    class={previewed === line.rank ? "line previewed" : "line"}
                    aria-pressed={pinned === line.rank}
                    title={`${line.description}. Hover, focus or click to show it on the board.`}
                    onMouseEnter={() => onPreview(line.rank)}
                    onMouseLeave={() =>
                      onPreview(pinned)}
                    onFocus={() =>
                      onPreview(line.rank)}
                    onBlur={() => onPreview(pinned)}
                    onClick={() => {
                      const next = pinned === line.rank ? undefined : line.rank;
                      setPinned(next);
                      onPreview(next);
                    }}
                  >
                    <span class="score">{line.score}</span>{" "}
                    <span class="line-moves">{line.moves.join(" ")}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
