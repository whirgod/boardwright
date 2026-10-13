// Backgammon board: 24 points, the bar, the borne-off tray, the dice and the
// Seat to move. DOM-free, like every renderer.
//
// Move input: a Move is the full play of a roll, so it is composed Step by
// Step, each a checker then its destination (the bar and the tray are
// targets too), one die per Step. Steps may be entered in any order that can
// be played (the Game's `stepOrders`), not just the canonical order the
// legal Moves list; the Move is played once its last Step is entered.
// Clicking the dice starts over, or plays `pass` when no checker can move.
import {
  backgammon,
  type BackgammonMove,
  type BackgammonPosition,
  type BackgammonSeat,
  BAR,
  OFF,
  stepOrders,
} from "@boardwright/game-backgammon";
import type {
  BoardRenderer,
  MoveIntent,
  MoveTargets,
  Selection,
  Shape,
  Target,
  TargetId,
} from "./board.ts";

const MARGIN = 10;
/** Width of one point. */
const W = 60;
/** Height of one point (a half of the board). */
const H = 230;
/** Gap between the two halves, where the dice sit. */
const GAP = 80;
const BAR_WIDTH = 60;
const TRAY = 70;
const R = 26;
/** Distance between stacked checkers; more than {@link SHOWN} are counted. */
const STACK = 2 * R - 2;
const SHOWN = 4;
const BOARD_WIDTH = MARGIN * 2 + 12 * W + BAR_WIDTH + TRAY;
const BOARD_HEIGHT = MARGIN * 2 + 2 * H + GAP;
const HEIGHT = BOARD_HEIGHT + 50;
const MIDDLE = MARGIN + H + GAP / 2;
const BAR_X = MARGIN + 6 * W;
const TRAY_X = BAR_X + BAR_WIDTH + 6 * W;
const DIE = 44;

/** Target ids besides the points (`p1`-`p24`, numbered from white's side). */
export const BAR_TARGET = "bar";
export const OFF_TARGET = "off";
export const DICE_TARGET = "dice";

const SEATS = ["white", "black"] as const;
const label = (seat: BackgammonSeat) => seat === "white" ? "White" : "Black";

/** Target id of `seat`'s own point `p` (1-24, {@link BAR} or {@link OFF}). */
export function targetOf(seat: BackgammonSeat, p: number): TargetId {
  if (p === BAR) return BAR_TARGET;
  if (p === OFF) return OFF_TARGET;
  return `p${seat === "white" ? p : 25 - p}`;
}

/** Left edge of white's point `n` (1-24) and whether it is in the top half. */
function pointBox(n: number): { x: number; top: boolean } {
  // Top row, left to right: 13-24; bottom row, left to right: 12-1.
  const top = n >= 13;
  const column = top ? n - 13 : 12 - n;
  return { x: MARGIN + column * W + (column >= 6 ? BAR_WIDTH : 0), top };
}

/** Checkers stacked from `start` towards `direction` (+1 down, -1 up). */
function stack(
  shapes: Shape[],
  x: number,
  start: number,
  direction: 1 | -1,
  count: number,
  seat: BackgammonSeat,
): void {
  for (let i = 0; i < Math.min(count, SHOWN); i++) {
    shapes.push({
      kind: "circle",
      center: { x, y: start + direction * i * STACK },
      r: R - 2,
      className: `disc disc-${seat}`,
    });
  }
  if (count > SHOWN) {
    shapes.push({
      kind: "text",
      at: { x, y: start + direction * (SHOWN - 1) * STACK },
      text: String(count),
      className: `checker-count checker-count-${seat}`,
    });
  }
}

/** `seat`'s pip count: the distance its checkers still have to travel. */
export function pipCount(
  position: BackgammonPosition,
  seat: BackgammonSeat,
): number {
  let pips = 25 * position.bar[seat];
  position.points.forEach((v, i) => {
    if (seat === "white" && v > 0) pips += v * (i + 1);
    if (seat === "black" && v < 0) pips += -v * (24 - i);
  });
  return pips;
}

/** The caption under the board: whose turn it is, the dice and the pip counts. */
export function caption(position: BackgammonPosition): string {
  const { turn, dice } = position;
  const winner = SEATS.find((s) => position.off[s] === 15);
  const state = winner !== undefined
    ? `${label(winner)} won`
    : turn === null
    ? "Opening roll"
    : dice === null
    ? `${label(turn)} to roll`
    : `${label(turn)} to play ${dice[0]}-${dice[1]}`;
  return `${state} · pips: white ${pipCount(position, "white")}, black ${
    pipCount(position, "black")
  }`;
}

function scene(position: BackgammonPosition) {
  const board: Shape[] = [{
    kind: "rect",
    x: 0,
    y: 0,
    width: BOARD_WIDTH,
    height: BOARD_HEIGHT,
    className: "board",
  }, {
    kind: "rect",
    x: BAR_X,
    y: 0,
    width: BAR_WIDTH,
    height: BOARD_HEIGHT,
    className: "bg-bar",
  }, {
    kind: "rect",
    x: TRAY_X,
    y: 0,
    width: TRAY + MARGIN,
    height: BOARD_HEIGHT,
    className: "bg-bar",
  }];
  const pieces: Shape[] = [];
  const targets: Target[] = [];
  // Point numbers are the Seat to move's (white's before the opening roll),
  // as Move Notation uses them.
  const viewer = position.turn ?? "white";
  for (let n = 1; n <= 24; n++) {
    const { x, top } = pointBox(n);
    board.push({
      kind: "rect",
      x: x + 6,
      y: top ? MARGIN : MARGIN + H + GAP,
      width: W - 12,
      height: H,
      className: `bg-point bg-point-${n % 2 === 0 ? "dark" : "light"}`,
    }, {
      kind: "text",
      at: { x: x + W / 2, y: top ? MARGIN + H + 18 : MARGIN + H + GAP - 8 },
      text: String(viewer === "white" ? n : 25 - n),
      className: "point-number",
    });
    const v = position.points[n - 1]!;
    const seat: BackgammonSeat = v > 0 ? "white" : "black";
    const count = Math.abs(v);
    if (count > 0) {
      stack(
        pieces,
        x + W / 2,
        top ? MARGIN + R : MARGIN + 2 * H + GAP - R,
        top ? 1 : -1,
        count,
        seat,
      );
    }
    targets.push({
      id: `p${n}`,
      label: `point ${viewer === "white" ? n : 25 - n}: ${
        count === 0 ? "empty" : `${count} ${seat}`
      }`,
      x,
      y: top ? MARGIN : MARGIN + H + GAP,
      width: W,
      height: H,
    });
  }
  // On the bar, white's checkers sit below the middle, black's above.
  stack(pieces, BAR_X + W / 2, MIDDLE + R + 4, 1, position.bar.white, "white");
  stack(pieces, BAR_X + W / 2, MIDDLE - R - 4, -1, position.bar.black, "black");
  targets.push({
    id: BAR_TARGET,
    label: `bar: ${position.bar.white} white, ${position.bar.black} black`,
    x: BAR_X,
    y: 0,
    width: BAR_WIDTH,
    height: BOARD_HEIGHT,
  });
  // Borne-off checkers as slabs: white's from the bottom, black's from the top.
  for (const seat of SEATS) {
    for (let i = 0; i < position.off[seat]; i++) {
      pieces.push({
        kind: "rect",
        x: TRAY_X + 10,
        y: seat === "white"
          ? MARGIN + 2 * H + GAP - (i + 1) * 14
          : MARGIN + i * 14,
        width: TRAY - 20,
        height: 12,
        className: `checker-off disc-${seat}`,
      });
    }
  }
  targets.push({
    id: OFF_TARGET,
    label:
      `borne off: ${position.off.white} white, ${position.off.black} black`,
    x: TRAY_X,
    y: 0,
    width: TRAY + MARGIN,
    height: BOARD_HEIGHT,
  });
  // The dice, in the right half's middle, in the colour of the Seat to play.
  const diceX = BAR_X + BAR_WIDTH + 3 * W;
  if (position.dice !== null && position.turn !== null) {
    position.dice.forEach((d, i) => {
      const x = diceX + (i === 0 ? -DIE - 6 : 6);
      board.push({
        kind: "rect",
        x,
        y: MIDDLE - DIE / 2,
        width: DIE,
        height: DIE,
        className: `die disc-${position.turn}`,
      }, {
        kind: "text",
        at: { x: x + DIE / 2, y: MIDDLE },
        text: String(d),
        className: `die-face die-face-${position.turn}`,
      });
    });
  }
  targets.push({
    id: DICE_TARGET,
    label: position.dice === null
      ? "dice: not rolled"
      : `dice: ${position.dice[0]}-${position.dice[1]} (start the Move over)`,
    x: diceX - DIE - 10,
    y: MIDDLE - DIE / 2 - 4,
    width: 2 * DIE + 20,
    height: DIE + 8,
  });
  board.push({
    kind: "text",
    at: { x: MARGIN, y: BOARD_HEIGHT + 34 },
    text: caption(position),
    className: "caption",
  });
  return { width: BOARD_WIDTH, height: HEIGHT, board, pieces, targets };
}

interface Entry {
  readonly move: BackgammonMove;
  /** Targets clicked to enter the Move in one order: from, to, from, to, ... */
  readonly clicks: readonly TargetId[];
}

/**
 * Every way to click each of `legalMoves`: one entry per order of
 * single-die Steps that plays it (the Game's `stepOrders`).
 */
function entries(
  position: BackgammonPosition,
  legalMoves: readonly BackgammonMove[],
): Entry[] {
  const seat = position.turn;
  if (seat === null) return [];
  const { encodeMove } = backgammon.notation;
  const allowed = new Map(legalMoves.map((m) => [encodeMove(m), m]));
  return stepOrders(position).flatMap(({ move, steps }) => {
    const legal = allowed.get(encodeMove(move));
    return legal === undefined ? [] : [{
      move: legal,
      clicks: steps.flatMap((s) => [
        targetOf(seat, s.from),
        targetOf(seat, s.to),
      ]),
    }];
  });
}

const startsWith = (clicks: readonly TargetId[], prefix: Selection) =>
  prefix.length <= clicks.length && prefix.every((t, i) => clicks[i] === t);

/**
 * The targets that continue `selection` towards some legal Move: the
 * checkers that may move next, or the destinations of the picked checker.
 */
export function nextTargets(
  position: BackgammonPosition,
  legalMoves: readonly BackgammonMove[],
  selection: Selection,
): TargetId[] {
  const next = new Set<TargetId>();
  for (const { clicks } of entries(position, legalMoves)) {
    const target = clicks[selection.length];
    if (target !== undefined && startsWith(clicks, selection)) next.add(target);
  }
  return [...next];
}

/**
 * A click while composing a Move. The selection holds the Steps entered so
 * far as `from, to` pairs, then possibly a picked checker:
 * - a click that continues some legal Move extends the selection, and plays
 *   the Move when it completes it;
 * - clicking the picked checker again drops it; clicking another checker that
 *   may move instead picks that one;
 * - the dice start over, or play `pass` when that is the only legal Move;
 * - anything else keeps the selection.
 */
export function input(
  position: BackgammonPosition,
  legalMoves: readonly BackgammonMove[],
  selection: Selection,
  target: TargetId,
): MoveIntent<BackgammonMove> {
  const keep: MoveIntent<BackgammonMove> = selection.length > 0
    ? { kind: "select", selection }
    : { kind: "ignore" };
  if (target === DICE_TARGET) {
    const [only] = legalMoves;
    if (legalMoves.length === 1 && only!.steps.length === 0) {
      return { kind: "move", move: only! };
    }
    return selection.length > 0 ? { kind: "select", selection: [] } : keep;
  }
  const all = entries(position, legalMoves);
  const picked = selection.length % 2 === 1;
  const done = picked ? selection.slice(0, -1) : selection;
  const extend = (
    prefix: Selection,
  ): MoveIntent<BackgammonMove> | undefined => {
    const matching = all.filter((e) => startsWith(e.clicks, prefix));
    if (matching.length === 0) return undefined;
    const complete = matching.find((e) => e.clicks.length === prefix.length);
    return complete
      ? { kind: "move", move: complete.move }
      : { kind: "select", selection: prefix };
  };
  const extended = extend([...selection, target]);
  if (extended) return extended;
  if (!picked) return keep;
  if (selection.at(-1) === target) return { kind: "select", selection: done };
  // Picking another checker instead of the one picked.
  return extend([...done, target]) ?? keep;
}

/**
 * The points a Move touches, in order (a checker moved on is not repeated:
 * `24/18 18/13` is `p1, p7, p12` for white); `pass` touches the dice.
 */
function moveTargets(
  move: BackgammonMove,
  position: BackgammonPosition,
): MoveTargets {
  const seat = position.turn ?? "white";
  if (move.steps.length === 0) return { path: [DICE_TARGET] };
  const path: TargetId[] = [];
  for (const { from, to } of move.steps) {
    for (const t of [targetOf(seat, from), targetOf(seat, to)]) {
      if (path.at(-1) !== t) path.push(t);
    }
  }
  return { path };
}

export const backgammonRenderer: BoardRenderer<
  BackgammonPosition,
  BackgammonMove
> = { scene, moveTargets, input, nextTargets };
