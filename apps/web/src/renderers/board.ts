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

/**
 * `last-move`: the path of the last Move; `last-move-effect`: what else it
 * touched (e.g. a removed piece); `selected` / `destination`: composing a Move.
 */
export type HighlightKind =
  | "selected"
  | "destination"
  | "last-move"
  | "last-move-effect";

export interface Highlight {
  readonly target: TargetId;
  readonly kind: HighlightKind;
}

/**
 * An arrow between two targets. `from === to` marks a single target (a
 * placement). `line`: the first Move of an Engine's Line, `index` its rank
 * (0 = best Line); `preview`: one Move of a previewed Line, `index` its step
 * in the Line (0 = first).
 */
export interface Arrow {
  readonly from: TargetId;
  readonly to: TargetId;
  readonly kind: "line" | "preview";
  readonly index: number;
}

/** Targets picked so far while composing a Move (e.g. a piece before its destination). */
export type Selection = readonly TargetId[];

/**
 * The targets a Move touches. `path` is where the moving piece goes, in order:
 * `[cell]` for a placement, `[from, to]`, or `[from, land1, land2]` for a
 * multi-jump; it drives arrows and the last-Move highlight. `effects` are
 * further targets the Move picks without moving there, such as the point of a
 * piece removed after a mill. Clicking `[...path, ...effects]` in order
 * composes the Move.
 */
export interface MoveTargets {
  readonly path: readonly TargetId[];
  readonly effects?: readonly TargetId[];
}

/** What a click on the board means. */
export type MoveIntent<Move> =
  | { readonly kind: "move"; readonly move: Move }
  | { readonly kind: "select"; readonly selection: Selection }
  | { readonly kind: "ignore" };

/** Draws one Game. Receives typed Positions and Moves, decoded with the Game's Notation. */
export interface BoardRenderer<Position, Move> {
  scene(position: Position): BoardScene;
  /** The targets a Move touches (see `MoveTargets`). */
  moveTargets(move: Move, position: Position): MoveTargets;
  /** Interprets a click on `target`, given the Moves the Seat to move may play. */
  input(
    position: Position,
    legalMoves: readonly Move[],
    selection: Selection,
    target: TargetId,
  ): MoveIntent<Move>;
  /**
   * Optional: the targets a click may continue a non-empty `selection` with
   * (highlighted as destinations), for renderers whose `input` does not
   * follow `moveTargets`' click order (e.g. backgammon, whose Steps may be
   * entered in any order). Default: the next target of every legal Move's
   * click order that starts with `selection`.
   */
  nextTargets?(
    position: Position,
    legalMoves: readonly Move[],
    selection: Selection,
  ): readonly TargetId[];
}
