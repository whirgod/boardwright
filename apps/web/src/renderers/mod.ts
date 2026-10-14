import { type GameId, type GameRules, hasChance } from "@boardwright/core";
import { backgammon } from "@boardwright/game-backgammon";
import { checkers } from "@boardwright/game-checkers";
import { chess } from "@boardwright/game-chess";
import { nineMensMorris } from "@boardwright/game-nine-mens-morris";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import type {
  Arrow,
  BoardRenderer,
  BoardScene,
  Highlight,
  Selection,
  TargetId,
} from "./board.ts";
import { backgammonRenderer } from "./backgammon.ts";
import { clickOrder } from "./compose.ts";
import { checkersRenderer } from "./checkers.ts";
import { chessRenderer } from "./chess.ts";
import { nineMensMorrisRenderer } from "./nine-mens-morris.ts";
import { ticTacToeRenderer } from "./tic-tac-toe.ts";

export type * from "./board.ts";

/** One entry of a Match's Move list in Notation: a Move or a Chance event. */
export type BoardEntry =
  | { readonly kind: "move"; readonly move: string }
  | { readonly kind: "chance"; readonly chance: string };

/** What the UI knows about a Match, all in the Game's Notation (as the API sends it). */
export interface BoardRequest {
  readonly position: string;
  /**
   * Move list from the initial Position, with its Chance events; its last
   * Move is highlighted.
   */
  readonly entries: readonly BoardEntry[];
  /** Moves the Seat to move may play; empty when this client may not move. */
  readonly legalMoves: readonly string[];
  readonly selection: Selection;
  /** Moves from `position` to draw as arrows, e.g. the first Moves of Analysis Lines, best first; `null` keeps a rank without an arrow. */
  readonly arrows?: readonly (string | null)[];
  /**
   * A Line from `position` to draw Move by Move (numbered arrows), e.g. a
   * previewed Analysis Line. Drawing stops at a Move that does not decode or
   * apply.
   */
  readonly preview?: readonly string[];
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
    return clickOrder(renderer.moveTargets(move, position));
  };

  const arrowOf = (
    move: Move,
    position: Position,
    kind: Arrow["kind"],
    index: number,
  ): Arrow | undefined => {
    const { path } = renderer.moveTargets(move, position);
    const from = path[0];
    const to = path[path.length - 1];
    return from === undefined || to === undefined
      ? undefined
      : { from, to, kind, index };
  };

  /** A Line's Moves as numbered arrows, each from the Position the Moves before it lead to. */
  const previewArrows = (
    texts: readonly string[],
    start: Position,
  ): Arrow[] => {
    const arrows: Arrow[] = [];
    let position = start;
    try {
      for (const [index, text] of texts.entries()) {
        const move = notation.decodeMove(text, position);
        const arrow = arrowOf(move, position, "preview", index);
        if (arrow) arrows.push(arrow);
        position = rules.play(position, move);
      }
    } catch {
      // A stale or out-of-sync Line: draw the Moves that applied.
    }
    return arrows;
  };

  /** The last Move's highlights, found by replaying the Move list; none if it does not replay. */
  const lastMove = (entries: readonly BoardEntry[]): Highlight[] => {
    const at = entries.findLastIndex((e) => e.kind === "move");
    const lastEntry = entries[at];
    if (lastEntry?.kind !== "move") return [];
    try {
      let position = rules.initialPosition();
      for (const entry of entries.slice(0, at)) {
        if (entry.kind === "move") {
          position = rules.play(
            position,
            notation.decodeMove(entry.move, position),
          );
        } else if (hasChance(rules)) {
          position = rules.resolveChance(
            position,
            rules.notation.decodeChance(entry.chance, position),
          );
        } else {
          return [];
        }
      }
      const last = notation.decodeMove(lastEntry.move, position);
      const { path, effects = [], captures = [] } = renderer.moveTargets(
        last,
        position,
      );
      return [
        ...path.map((target) => ({ target, kind: "last-move" as const })),
        ...[...effects, ...captures].map((target) => ({
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
      const highlights = lastMove(request.entries);
      const { selection } = request;
      for (const target of selection) {
        highlights.push({ target, kind: "selected" });
      }
      if (selection.length > 0 && renderer.nextTargets) {
        for (
          const target of renderer.nextTargets(position, legalMoves, selection)
        ) {
          highlights.push({ target, kind: "destination" });
        }
      } else if (selection.length > 0) {
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
      for (const [index, text] of (request.arrows ?? []).entries()) {
        const [move] = text === null ? [] : decodeMoves([text], position);
        const arrow = move && arrowOf(move, position, "line", index);
        if (arrow) arrows.push(arrow);
      }
      arrows.push(...previewArrows(request.preview ?? [], position));
      return {
        scene: renderer.scene(position, request.selection),
        highlights,
        arrows,
      };
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
  [
    bindRenderer(ticTacToe, ticTacToeRenderer),
    bindRenderer(nineMensMorris, nineMensMorrisRenderer),
    bindRenderer(checkers, checkersRenderer),
    bindRenderer(chess, chessRenderer),
    bindRenderer(backgammon, backgammonRenderer),
  ].map((v) => [v.gameId, v]),
);

/** The board for a Game, or `undefined` if no renderer exists for it yet. */
export function gameView(gameId: GameId): GameView | undefined {
  return views.get(gameId);
}
