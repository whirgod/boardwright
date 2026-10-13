// The Move list and the review controls: every entry is a button that shows
// the Position after it. Navigation logic lives in `review.ts`.
import type { MoveListEntry } from "./api.ts";
import { moveListRows } from "./match-state.ts";
import { describePly, type ReviewAction } from "./review.ts";

export function ReviewBar(
  { entries, ply, onGo }: {
    entries: readonly MoveListEntry[];
    ply: number;
    onGo: (action: ReviewAction) => void;
  },
) {
  const atStart = ply === 0;
  const atEnd = ply === entries.length;
  return (
    <div class="review-bar">
      <div role="group" aria-label="Review">
        <button
          type="button"
          aria-label="Initial Position (Home)"
          title="Initial Position (Home)"
          disabled={atStart}
          onClick={() => onGo({ kind: "first" })}
        >
          «
        </button>
        <button
          type="button"
          aria-label="Previous (Left arrow)"
          title="Previous (Left arrow)"
          disabled={atStart}
          onClick={() => onGo({ kind: "previous" })}
        >
          ‹
        </button>
        <button
          type="button"
          aria-label="Next (Right arrow)"
          title="Next (Right arrow)"
          disabled={atEnd}
          onClick={() => onGo({ kind: "next" })}
        >
          ›
        </button>
        <button
          type="button"
          aria-label="Current Position (End)"
          title="Current Position (End)"
          disabled={atEnd}
          onClick={() => onGo({ kind: "last" })}
        >
          »
        </button>
      </div>
      <p class="muted" aria-live="polite">
        {describePly(entries, ply)}
        {!atEnd && " — reviewing"}
      </p>
    </div>
  );
}

export function MoveList(
  { entries, ply, onGo }: {
    entries: readonly MoveListEntry[];
    ply: number;
    /** Show the Position after that many entries. */
    onGo: (ply: number) => void;
  },
) {
  if (entries.length === 0) return <p class="muted">No Moves yet.</p>;
  return (
    <ol class="moves">
      {moveListRows(entries).map((row) => (
        <li key={row.number} value={row.number}>
          {row.entries.map((entry, i) => {
            const after = row.first + i + 1;
            const chance = entry.kind === "chance";
            const text = chance ? `(${entry.chance})` : entry.move;
            return (
              <button
                key={i}
                type="button"
                class={chance ? "entry chance" : "entry"}
                aria-current={after === ply ? "step" : undefined}
                title={chance ? "Chance event" : undefined}
                onClick={() => onGo(after)}
              >
                {text}
              </button>
            );
          })}
        </li>
      ))}
    </ol>
  );
}
