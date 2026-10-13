import type { GameId, GameRules } from "@boardwright/core";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import type {
  Arrow,
  BoardRenderer,
  BoardScene,
  Highlight,
  Selection,
  TargetId,
} from "./board.ts";
import { ticTacToeRenderer } from "./tic-tac-toe.ts";

export type * from "./board.ts";

/** What the UI knows about a Match, all in the Game's Notation (as the API sends it). */
export interface BoardRequest {
  readonly position: string;
  /** Move list from the initial Position; its last Move is highlighted. */
  readonly moves: readonly string[];
  /** Moves the Seat to move may play; empty when this client may not move. */
  readonly legalMoves: readonly string[];
  readonly selection: Selection;
  /** Moves from `position` to draw as arrows, e.g. the first Moves of Analysis Lines. */
  readonly arrows?: readonly string[];
}

export interface BoardModel {
  readonly scene: BoardScene;
  readonly highlights: readonly Highlight[];
  readonly arrows: readonly Arrow[];
}

/** A click's meaning, with any Move encoded in the Game's Notation. */
export type Click =
  | { readonly kind: "move"; readonly move: string }
  | { readonly kind: "select"; readonly selection: Selection }
  | { readonly kind: "ignore" };

/**
 * A Game's renderer bound to its rules, behind a Notation-string interface so
 * the UI stays Game-agnostic. Positions and Moves are decoded with the Game's
 * own Notation before they reach the renderer; Moves are encoded back.
 */
export interface GameView {
  readonly gameId: GameId;
  /**
   * Throws only if `request.position` does not decode; Moves that do not
   * decode (e.g. a stale Analysis Line) are skipped.
   */
  board(request: BoardRequest): BoardModel;
  /** Never throws; an undecodable Position ignores clicks. */
  click(request: BoardRequest, target: TargetId): Click;
}

export function bindRenderer<Position, Move>(
  rules: GameRules<Position, Move>,
  renderer: BoardRenderer<Position, Move>,
): GameView {
  const { notation } = rules;

  /** Decodes each Move text; ones that do not decode (stale or out of sync) are skipped. */
  const decodeMoves = (texts: readonly string[], position: Position): Move[] =>
    texts.flatMap((text) => {
      try {
        return [notation.decodeMove(text, position)];
      } catch {
        return [];
      }
    });

  /** Targets the Move touches, clicked in order to compose it. */
  const clicks = (move: Move, position: Position): readonly TargetId[] => {
    const { path, effects = [] } = renderer.moveTargets(move, position);
    return [...path, ...effects];
  };

  /** The last Move's highlights, found by replaying the Move list; none if it does not replay. */
  const lastMove = (moves: readonly string[]): Highlight[] => {
    if (moves.length === 0) return [];
    try {
      let position = rules.initialPosition();
      for (const text of moves.slice(0, -1)) {
        position = rules.play(position, notation.decodeMove(text, position));
      }
      const last = notation.decodeMove(moves[moves.length - 1]!, position);
      const { path, effects = [] } = renderer.moveTargets(last, position);
      return [
        ...path.map((target) => ({ target, kind: "last-move" as const })),
        ...effects.map((target) => ({
          target,
          kind: "last-move-effect" as const,
        })),
      ];
    } catch {
      return [];
    }
  };

  return {
    gameId: rules.id,
    board(request) {
      const position = notation.decodePosition(request.position);
      const legalMoves = decodeMoves(request.legalMoves, position);
      const highlights = lastMove(request.moves);
      const { selection } = request;
      for (const target of selection) {
        highlights.push({ target, kind: "selected" });
      }
      if (selection.length > 0) {
        const next = new Set<TargetId>();
        for (const move of legalMoves) {
          const targets = clicks(move, position);
          if (selection.every((t, i) => targets[i] === t)) {
            const target = targets[selection.length];
            if (target !== undefined) next.add(target);
          }
        }
        for (const target of next) {
          highlights.push({ target, kind: "destination" });
        }
      }
      const arrows: Arrow[] = [];
      for (const move of decodeMoves(request.arrows ?? [], position)) {
        const { path } = renderer.moveTargets(move, position);
        const from = path[0];
        const to = path[path.length - 1];
        if (from !== undefined && to !== undefined) {
          arrows.push({ from, to, kind: "line" });
        }
      }
      return { scene: renderer.scene(position), highlights, arrows };
    },
    click(request, target) {
      let position: Position;
      try {
        position = notation.decodePosition(request.position);
      } catch {
        return { kind: "ignore" };
      }
      const intent = renderer.input(
        position,
        decodeMoves(request.legalMoves, position),
        request.selection,
        target,
      );
      return intent.kind === "move"
        ? { kind: "move", move: notation.encodeMove(intent.move) }
        : intent;
    },
  };
}

const views: ReadonlyMap<GameId, GameView> = new Map(
  [bindRenderer(ticTacToe, ticTacToeRenderer)].map((v) => [v.gameId, v]),
);

/** The board for a Game, or `undefined` if no renderer exists for it yet. */
export function gameView(gameId: GameId): GameView | undefined {
  return views.get(gameId);
}
