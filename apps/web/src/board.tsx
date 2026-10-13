// Draws any Game's BoardModel as SVG. Game-specific drawing lives in the
// DOM-free renderers (./renderers), never here.
import type { BoardModel, Shape, Target, TargetId } from "./renderers/mod.ts";

function ShapeView({ shape }: { shape: Shape }) {
  switch (shape.kind) {
    case "rect":
      return (
        <rect
          class={shape.className}
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
        />
      );
    case "line":
      return (
        <line
          class={shape.className}
          x1={shape.from.x}
          y1={shape.from.y}
          x2={shape.to.x}
          y2={shape.to.y}
        />
      );
    case "circle":
      return (
        <circle
          class={shape.className}
          cx={shape.center.x}
          cy={shape.center.y}
          r={shape.r}
        />
      );
    case "text":
      return (
        <text class={shape.className} x={shape.at.x} y={shape.at.y}>
          {shape.text}
        </text>
      );
  }
}

const center = (t: Target) => ({ x: t.x + t.width / 2, y: t.y + t.height / 2 });

export function Board(
  { model, onTarget }: {
    model: BoardModel;
    /** Called for clicks (and Enter/Space) on a target; omit for a read-only board. */
    onTarget?: ((target: TargetId) => void) | undefined;
  },
) {
  const { scene, highlights, arrows } = model;
  const targets = new Map(scene.targets.map((t) => [t.id, t]));
  return (
    <svg
      class={onTarget ? "board interactive" : "board"}
      viewBox={`0 0 ${scene.width} ${scene.height}`}
      role="group"
      aria-label="Board"
    >
      <defs>
        <marker
          id="arrow-head"
          viewBox="0 0 10 10"
          refX="5"
          refY="5"
          markerWidth="4"
          markerHeight="4"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" class="arrow-head" />
        </marker>
      </defs>
      {scene.board.map((shape, i) => <ShapeView key={`b${i}`} shape={shape} />)}
      {highlights.map((h, i) => {
        const t = targets.get(h.target);
        return t && (
          <rect
            key={`h${i}`}
            class={`highlight highlight-${h.kind}`}
            x={t.x}
            y={t.y}
            width={t.width}
            height={t.height}
          />
        );
      })}
      {scene.pieces.map((shape, i) => (
        <ShapeView
          key={`p${i}`}
          shape={shape}
        />
      ))}
      {arrows.map((a, i) => {
        const from = targets.get(a.from);
        const to = targets.get(a.to);
        if (!from || !to) return null;
        const [p, q] = [center(from), center(to)];
        // Line arrows: the best Line strongest. Preview arrows: numbered
        // steps, alternating between the two Seats.
        const className = a.kind === "line"
          ? `arrow ${a.index === 0 ? "arrow-best" : "arrow-alt"}`
          : `arrow arrow-preview arrow-step-${a.index % 2 === 0 ? "a" : "b"}`;
        return (
          <g key={`a${i}`}>
            {a.from === a.to
              ? (
                <circle
                  class={className}
                  cx={p.x}
                  cy={p.y}
                  r={from.width / 3}
                />
              )
              : (
                <line
                  class={className}
                  x1={p.x}
                  y1={p.y}
                  x2={q.x}
                  y2={q.y}
                  marker-end="url(#arrow-head)"
                />
              )}
            {a.kind === "preview" && (
              <text class="arrow-label" x={q.x} y={q.y}>{a.index + 1}</text>
            )}
          </g>
        );
      })}
      {scene.targets.map((t) => (
        <rect
          key={t.id}
          class="target"
          x={t.x}
          y={t.y}
          width={t.width}
          height={t.height}
          aria-label={t.label}
          {...(onTarget
            ? {
              role: "button",
              tabIndex: 0,
              onClick: () => onTarget(t.id),
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onTarget(t.id);
                }
              },
            }
            : { role: "img" })}
        />
      ))}
    </svg>
  );
}
