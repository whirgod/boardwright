// The board-renderer seam: one BoardRenderer per Game turns that Game's typed
// Position into a DOM-free BoardScene and user input into Move intents. A
// generic component (`../board.tsx`) draws any BoardScene as SVG, so Games
// never touch the DOM and renderers are testable with `deno test`.

/** A clickable place on the board: a square, cell or point, named by the renderer. */
export type TargetId = string;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Drawing primitives in board coordinates; `className` selects the style. */
export type Shape =
  | {
    readonly kind: "rect";
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly className: string;
  }
  | {
    readonly kind: "line";
    readonly from: Point;
    readonly to: Point;
    readonly className: string;
  }
  | {
    readonly kind: "circle";
    readonly center: Point;
    readonly r: number;
    readonly className: string;
  }
  | {
    readonly kind: "text";
    readonly at: Point;
    readonly text: string;
    readonly className: string;
  };

/** A clickable region with an accessible label (e.g. "b2: x"). */
export interface Target {
  readonly id: TargetId;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Everything needed to draw one Position, in drawing order: the board, then
 * (above highlights) the pieces, then click targets.
 */
export interface BoardScene {
  readonly width: number;
  readonly height: number;
  readonly board: readonly Shape[];
  readonly pieces: readonly Shape[];
  readonly targets: readonly Target[];
}

export type HighlightKind = "selected" | "destination" | "last-move";

export interface Highlight {
  readonly target: TargetId;
  readonly kind: HighlightKind;
}

/**
 * An arrow between two targets, e.g. the first Move of an Engine's Line.
 * `from === to` marks a single target (a placement).
 */
export interface Arrow {
  readonly from: TargetId;
  readonly to: TargetId;
  readonly kind: "line";
}

/** Targets picked so far while composing a Move (e.g. a piece before its destination). */
export type Selection = readonly TargetId[];

/** What a click on the board means. */
export type MoveIntent<Move> =
  | { readonly kind: "move"; readonly move: Move }
  | { readonly kind: "select"; readonly selection: Selection }
  | { readonly kind: "ignore" };

/** Draws one Game. Receives typed Positions and Moves, decoded with the Game's Notation. */
export interface BoardRenderer<Position, Move> {
  scene(position: Position): BoardScene;
  /**
   * Targets a Move involves, in order: `[cell]` for a placement, `[from, to]`
   * (or more, for multi-step Moves) otherwise. Drives highlights and arrows.
   */
  moveTargets(move: Move, position: Position): readonly TargetId[];
  /** Interprets a click on `target`, given the Moves the Seat to move may play. */
  input(
    position: Position,
    legalMoves: readonly Move[],
    selection: Selection,
    target: TargetId,
  ): MoveIntent<Move>;
}
