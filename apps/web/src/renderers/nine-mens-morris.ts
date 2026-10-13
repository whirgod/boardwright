import type {
  MorrisMove,
  MorrisPosition,
} from "@boardwright/game-nine-mens-morris";
import { MILLS, POINTS } from "@boardwright/game-nine-mens-morris";
import { composeMove } from "./compose.ts";
import type {
  BoardRenderer,
  MoveTargets,
  Point,
  Shape,
  Target,
} from "./board.ts";

const STEP = 100;
const MARGIN = 50;
const SIZE = 6 * STEP + 2 * MARGIN;
const HEIGHT = SIZE + 50;
const HIT = 70;
const RADIUS = 30;

/** Centre of a point; rank 7 is drawn at the top. */
export function pointCenter(name: string): Point {
  const file = name.charCodeAt(0) - "a".charCodeAt(0);
  const rank = Number(name.slice(1));
  return { x: MARGIN + file * STEP, y: MARGIN + (7 - rank) * STEP };
}

const SEATS = { w: "white", b: "black" } as const;

/**
 * Placement `[to]`, move or fly `[from, to]`; the removal after a mill is an
 * effect, so a mill-forming Move is composed in one go: piece, destination,
 * then the opponent piece to remove.
 */
function moveTargets(move: MorrisMove): MoveTargets {
  return {
    path: move.from === undefined ? [move.to] : [move.from, move.to],
    ...(move.remove === undefined ? {} : { effects: [move.remove] }),
  };
}

export const nineMensMorrisRenderer: BoardRenderer<
  MorrisPosition,
  MorrisMove
> = {
  scene(position) {
    const board: Shape[] = [
      {
        kind: "rect",
        x: 0,
        y: 0,
        width: SIZE,
        height: SIZE,
        className: "board",
      },
      ...MILLS.map((mill): Shape => ({
        kind: "line",
        from: pointCenter(mill[0]),
        to: pointCenter(mill[2]),
        className: "grid",
      })),
      ...POINTS.map((p): Shape => ({
        kind: "circle",
        center: pointCenter(p),
        r: 8,
        className: "point",
      })),
    ];
    const pieces: Shape[] = [];
    const targets: Target[] = [];
    POINTS.forEach((name, i) => {
      const cell = position.board[i]!;
      const center = pointCenter(name);
      if (cell !== ".") {
        pieces.push({
          kind: "circle",
          center,
          r: RADIUS,
          className: `disc disc-${SEATS[cell]}`,
        });
      }
      targets.push({
        id: name,
        label: `${name}: ${cell === "." ? "empty" : SEATS[cell]}`,
        x: center.x - HIT / 2,
        y: center.y - HIT / 2,
        width: HIT,
        height: HIT,
      });
    });
    // Each in-hand count sits next to a disc of its Seat's colour.
    (["white", "black"] as const).forEach((seat, i) => {
      const x = MARGIN + i * (SIZE / 2);
      board.push({
        kind: "circle",
        center: { x, y: SIZE + 5 },
        r: 12,
        className: `disc disc-${seat}`,
      }, {
        kind: "text",
        at: { x: x + 24, y: SIZE + 14 },
        text: `${seat === "white" ? "White" : "Black"} in hand: ${
          position.inHand[seat]
        }`,
        className: "caption",
      });
    });
    return { width: SIZE, height: HEIGHT, board, pieces, targets };
  },
  moveTargets,
  input: (_position, legalMoves, selection, target) =>
    composeMove(moveTargets, legalMoves, selection, target),
};
