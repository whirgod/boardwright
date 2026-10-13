import { assert, assertEquals, assertThrows } from "@std/assert";
import { chancePending, hasChance, pickChance } from "@boardwright/core";
import {
  assertChanceGameRulesContract,
  seededRandom,
} from "@boardwright/testing";
import {
  backgammon as g,
  type BackgammonPosition,
  type BackgammonSeat,
  CHECKERS,
  parseMove,
  stepOrders,
} from "./mod.ts";

const n = g.notation;
const INITIAL =
  "b2,0,0,0,0,w5,0,w3,0,0,0,b5,w5,0,0,0,b3,0,b5,0,0,0,0,w2 0/0 - -";

type Layout = Readonly<Partial<Record<number | "bar", number>>>;

/**
 * A Position from each Seat's checkers in its own numbering (`bar` for the
 * bar); checkers not placed are off.
 */
function setup(
  o: {
    white?: Layout;
    black?: Layout;
    turn?: BackgammonSeat | null;
    dice?: readonly [number, number] | null;
  },
): BackgammonPosition {
  const points = new Array<number>(24).fill(0);
  const bar = { white: 0, black: 0 };
  const off = { white: CHECKERS, black: CHECKERS };
  for (const seat of ["white", "black"] as const) {
    for (const [key, count = 0] of Object.entries(o[seat] ?? {})) {
      off[seat] -= count;
      if (key === "bar") bar[seat] = count;
      else {
        const p = Number(key);
        const i = seat === "white" ? p - 1 : 24 - p;
        points[i]! += seat === "white" ? count : -count;
      }
    }
  }
  const position: BackgammonPosition = {
    points,
    bar,
    off,
    turn: o.turn === undefined ? "white" : o.turn,
    dice: o.dice === undefined ? null : o.dice,
  };
  // Validates through the Notation.
  return n.decodePosition(n.encodePosition(position));
}

const moves = (p: BackgammonPosition): string[] =>
  g.legalMoves(p).map((m) => n.encodeMove(m)).sort();
const play = (p: BackgammonPosition, text: string) =>
  g.play(p, n.decodeMove(text, p));
const roll = (p: BackgammonPosition, text: string) =>
  g.resolveChance(p, n.decodeChance(text, p));

Deno.test("satisfies the ChanceGameRules contract", () => {
  assertChanceGameRulesContract(g, {
    seed: 7,
    playouts: 60,
    garbage: ["pass ", "24/18 ", "25/20", "13/7(5)", "w5", "7-7", "26"],
  });
});

Deno.test("is a Game with chance that starts with the opening roll", () => {
  assert(hasChance(g));
  const start = g.initialPosition();
  assertEquals(n.encodePosition(start), INITIAL);
  assertEquals(g.toMove(start), undefined);
  assertEquals(g.outcome(start), undefined);
  assert(chancePending(g, start));
  const events = g.chanceEvents(start);
  assertEquals(events.length, 30);
  assert(events.every((e) => Math.abs(e.probability - 1 / 30) < 1e-12));
  assert(events.every((e) => e.chance.kind === "opening"));
});

Deno.test("opening roll: the higher die moves first and plays both dice", () => {
  const start = g.initialPosition();
  const black = roll(start, "3-6");
  assertEquals(g.toMove(black), "black");
  assertEquals(black.dice, [6, 3]);
  const white = roll(start, "6-3");
  assertEquals(g.toMove(white), "white");
  assertEquals(n.encodePosition(white).endsWith(" white 63"), true);
  assert(moves(white).includes("24/18 13/10"));
  assertThrows(() => roll(start, "63"), Error, "not pending");
  assertThrows(() => n.decodeChance("3-3", start), Error, "bad");
});

Deno.test("regular rolls: 21 results, doubles half as likely", () => {
  const p = play(roll(g.initialPosition(), "3-1"), "8/5 6/5");
  assertEquals(g.toMove(p), undefined);
  assertEquals(p.turn, "black");
  const events = g.chanceEvents(p);
  assertEquals(events.length, 21);
  const prob = (text: string) =>
    events.find((e) => n.encodeChance(e.chance) === text)?.probability;
  assertEquals(prob("66"), 1 / 36);
  assertEquals(prob("62"), 2 / 36);
  assertThrows(() => roll(p, "1-3"), Error, "not pending");
  assertThrows(() => n.decodeChance("26", p), Error, "bad");
  const rolled = roll(p, "62");
  assertEquals(g.toMove(rolled), "black");
  assertEquals(g.chanceEvents(rolled), []);
  assertThrows(() => roll(rolled, "62"), Error, "not pending");
});

Deno.test("Steps are in the mover's numbering and a single checker is hit", () => {
  const p = setup({
    white: { 13: 1, 1: 14 },
    black: { 17: 1, 1: 14 }, // black's 17-point is white's 8-point
    dice: [5, 1],
  });
  const next = play(p, "13/8* 8/7");
  assertEquals(next.bar.black, 1);
  assertEquals(next.points[7], 0);
  assertEquals(next.points[6], 1);
  assertEquals(next.turn, "black");
  assertEquals(next.dice, null);
  // A point with two Opponent checkers is blocked.
  const blocked = setup({
    white: { 13: 1, 1: 14 },
    black: { 17: 2, 1: 13 },
    dice: [5, 1],
  });
  assertThrows(() => play(blocked, "13/8 8/7"), Error, "illegal");
});

Deno.test("both dice must be used when possible", () => {
  // From 13, a 6 then 5 (or 5 then 6) reaches 2; the rest cannot move.
  const p = setup({ white: { 13: 1, 1: 14 }, black: { 1: 15 }, dice: [6, 5] });
  assertEquals(moves(p), ["13/7 7/2"]);
  assertThrows(() => play(p, "13/7"), Error, "illegal");
  // Any order of the same play decodes to the canonical Move.
  assertEquals(n.encodeMove(n.decodeMove("13/8 8/2", p)), "13/7 7/2");
  assertEquals(n.encodeMove(n.decodeMove("13/8/2", p)), "13/7 7/2");
});

Deno.test("if only one die can be used, the larger one must be", () => {
  // White's 2-point is blocked, so 13/7 and 13/8 cannot continue.
  const either = setup({
    white: { 13: 1, 1: 14 },
    black: { 23: 2, 1: 13 },
    dice: [6, 5],
  });
  assertEquals(moves(either), ["13/7"]);
  assertThrows(() => play(either, "13/8"), Error, "illegal");
  // If only the smaller die can be played, it must be.
  const smaller = setup({
    white: { 13: 1, 1: 14 },
    black: { 23: 2, 18: 2, 1: 11 }, // white's 2- and 7-points
    dice: [6, 5],
  });
  assertEquals(moves(smaller), ["13/8"]);
});

Deno.test("both dice must be used even if only the lower die first allows it", () => {
  // White's 4-point is blocked: 10/4 is impossible, 10/9 9/3 is not.
  const p = setup({
    white: { 10: 1, 1: 14 },
    black: { 21: 2, 1: 13 }, // black's 21-point is white's 4-point
    dice: [6, 1],
  });
  assertEquals(moves(p), ["10/9 9/3"]);
  assertThrows(() => play(p, "10/4"), Error, "illegal");
  assertThrows(() => play(p, "10/9"), Error, "illegal");
});

Deno.test("each die usable by a different checker only: both must be played", () => {
  // The 6 only moves 14/8 (8/3 and 11/5 blocked), the 5 only 11/6 (14/9 blocked).
  // Own checkers never block each other, so the two plays combine.
  const p = setup({
    white: { 14: 1, 11: 1, 1: 13 },
    black: { 16: 2, 20: 2, 22: 2, 1: 9 }, // white's 9-, 5- and 3-points
    dice: [6, 5],
  });
  assertEquals(moves(p), ["14/8 11/6"]);
  assertEquals(n.encodeMove(n.decodeMove("11/6 14/8", p)), "14/8 11/6");
  assertThrows(() => play(p, "14/8"), Error, "illegal");
  assertThrows(() => play(p, "11/6"), Error, "illegal");
});

Deno.test("canonical Moves list higher points first", () => {
  const p = setup({
    white: { 24: 1, 13: 1, 1: 13 },
    black: { 3: 15 },
    dice: [6, 1],
  });
  assert(moves(p).includes("24/23 13/7"));
  assert(!moves(p).includes("13/7 24/23"));
  // One Step may stand for a chain that ends in the same Position.
  const off = setup({ white: { 6: 1, 1: 1 }, black: { 1: 15 }, dice: [6, 5] });
  assertEquals(n.encodeMove(n.decodeMove("6/off", off)), "6/1 1/off");
});

Deno.test("checkers on the bar enter first, onto open points only", () => {
  // Entry points for 6 and 5 are white's 19 and 20; 19 is blocked.
  const p = setup({
    white: { bar: 2, 13: 13 },
    black: { 6: 2, 1: 13 }, // black's 6-point is white's 19-point
    dice: [6, 5],
  });
  // The second checker cannot enter with the 6, so nothing else moves.
  assertEquals(moves(p), ["bar/20"]);
  assertThrows(() => play(p, "bar/20 13/7"), Error, "illegal");
  const one = setup({
    white: { bar: 1, 13: 14 },
    black: { 6: 2, 1: 13 },
    dice: [6, 5],
  });
  assertEquals(moves(one).includes("bar/20 13/7"), true);
  assertEquals(moves(one).some((m) => !m.startsWith("bar/20")), false);
});

Deno.test("no legal play: the only Move is pass and the turn passes", () => {
  const closed: Layout = { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 3 };
  const p = setup({
    white: { bar: 1, 13: 14 },
    black: closed,
    dice: [4, 2],
  });
  assertEquals(moves(p), ["pass"]);
  const next = play(p, "pass");
  assertEquals(next.turn, "black");
  assertEquals(next.dice, null);
  assertEquals(next.points, p.points);
  assertEquals(g.chanceEvents(next).length, 21);
  // pass is illegal when something can move.
  const open = roll(g.initialPosition(), "3-1");
  assertThrows(() => play(open, "pass"), Error, "illegal");
});

Deno.test("bearing off: exact, higher die from the highest point only", () => {
  const p = setup({ white: { 5: 1, 3: 1 }, black: { 24: 15 }, dice: [6, 1] });
  assertEquals(moves(p), ["5/4 4/off", "5/off 3/2"]);
  // The 6 may not bear off the 3 while the 5 is occupied.
  assertThrows(() => play(p, "3/off 5/4"), Error, "illegal");
});

Deno.test("bearing off needs every checker in the home board", () => {
  const p = setup({ white: { 7: 1, 3: 1 }, black: { 24: 15 }, dice: [4, 3] });
  assertEquals(moves(p), ["7/3 3/off"]);
  assertEquals(n.encodeMove(n.decodeMove("7/4 4/off", p)), "7/3 3/off");
  assertThrows(() => play(p, "3/off 7/4"), Error, "illegal");
});

Deno.test("doubles: four Steps, or as many as can be played", () => {
  const p = setup({ white: { 13: 2, 1: 13 }, black: { 1: 15 }, dice: [3, 3] });
  const all = moves(p);
  assert(all.includes("13/10 13/10 10/7 10/7"));
  assert(all.every((m) => m.split(" ").length === 4));
  // Notation shorthands decode to the canonical Move.
  assertEquals(
    n.encodeMove(n.decodeMove("13/10(2) 10/7(2)", p)),
    "13/10 13/10 10/7 10/7",
  );
  assertEquals(
    n.encodeMove(n.decodeMove("13/10/7(2)", p)),
    "13/10 13/10 10/7 10/7",
  );
  // Only two of four 6s can be played: 24/18/12 with 6 blocked further on.
  const partial = setup({
    white: { 24: 1, 1: 14 },
    black: { 19: 2, 2: 13 }, // black's 19-point is white's 6-point
    dice: [6, 6],
  });
  assertEquals(moves(partial), ["24/18 18/12"]);
  assertThrows(() => play(partial, "24/18"), Error, "illegal");
});

Deno.test("outcome: single game, gammon and backgammon", () => {
  const last = (black: Layout) =>
    play(setup({ white: { 1: 1 }, black, dice: [2, 1] }), "1/off");
  const single = last({ 1: 14 });
  assertEquals(g.outcome(single), { winner: "white", reason: "single" });
  assertEquals(g.toMove(single), undefined);
  assertEquals(g.legalMoves(single), []);
  assertEquals(g.chanceEvents(single), []);
  assertThrows(() => roll(single, "21"), Error, "not pending");
  assertEquals(g.outcome(last({ 1: 15 })), {
    winner: "white",
    reason: "gammon",
  });
  // A checker in the winner's home board (black's 19-24) or on the bar.
  assertEquals(g.outcome(last({ 1: 14, 20: 1 })), {
    winner: "white",
    reason: "backgammon",
  });
  assertEquals(g.outcome(last({ 1: 14, bar: 1 })), {
    winner: "white",
    reason: "backgammon",
  });
  const blackWins = play(
    setup({ white: { 1: 15 }, black: { 2: 1 }, turn: "black", dice: [2, 1] }),
    "2/off",
  );
  assertEquals(g.outcome(blackWins), { winner: "black", reason: "gammon" });
});

Deno.test("Position Notation", () => {
  const p = setup({
    white: { bar: 1, 6: 4 },
    black: { 1: 2 },
    turn: "black",
    dice: [6, 6],
  });
  const text = n.encodePosition(p);
  assertEquals(
    text,
    "0,0,0,0,0,w4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,b2 1/0 black 66",
  );
  assertEquals(n.decodePosition(text), p);
  assertEquals(p.off, { white: 10, black: 13 });
  const bad = [
    INITIAL.replace("w5", "w15"), // too many white checkers
    INITIAL.replace(" - -", " - 62"), // dice without a Seat
    INITIAL.replace(" - -", " white 26"), // smaller die first
    INITIAL.replace("b2,", "b0,"),
    INITIAL.replace("b2,", "w05,"),
    INITIAL.replace("0/0", "16/0"),
    INITIAL.replace(" - -", " red -"),
    INITIAL.replace("b2,", ""), // 23 points
    "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0 0/0 white -", // all off
  ];
  for (const text of bad) {
    assertThrows(() => n.decodePosition(text), Error, "bad", text);
  }
  // A Seat to roll next without dice.
  const pending = n.decodePosition(INITIAL.replace(" - -", " black -"));
  assertEquals(g.chanceEvents(pending).length, 21);
});

Deno.test("Move Notation: syntax", () => {
  assertEquals(parseMove("pass"), { steps: [] });
  assertEquals(parseMove("bar/22* 6/off"), {
    steps: [{ from: 25, to: 22 }, { from: 6, to: 0 }],
  });
  assertEquals(parseMove("24/18*/13").steps.length, 2);
  for (
    const text of [
      "25/20",
      "0/1",
      "3/5",
      "7/7",
      "off/3",
      "6/off/2",
      "13/bar",
      "24/bar/20",
      "13/7(5)",
      "13/10(3) 6/3(2)",
      "13 / 7",
      "13/7  6/3",
      "pass 13/7",
    ]
  ) {
    assertThrows(() => parseMove(text), Error, "bad", text);
  }
  // Valid syntax that no die allows decodes as written; play rejects it.
  const p = roll(g.initialPosition(), "3-1");
  const odd = n.decodeMove("24/13", p);
  assertEquals(n.encodeMove(odd), "24/13");
  assertThrows(() => g.play(p, odd), Error, "illegal");
  // No Seat to move: decoded as written.
  assertEquals(
    n.encodeMove(n.decodeMove("8/5 6/5", g.initialPosition())),
    "8/5 6/5",
  );
  assertThrows(() => g.play(g.initialPosition(), odd), Error, "illegal");
});

/**
 * Brute-force reference for the legal plays: every order of the dice and
 * every checker, no pruning; returns the Positions after each legal play.
 */
function referencePlays(p: BackgammonPosition): Set<string> {
  const seat = p.turn!;
  const other = seat === "white" ? "black" : "white";
  const sign = seat === "white" ? 1 : -1;
  const at = (q: number) => (seat === "white" ? q - 1 : 24 - q);
  interface State {
    points: number[];
    bar: Record<BackgammonSeat, number>;
    off: Record<BackgammonSeat, number>;
  }
  const own = (s: State, q: number) => Math.max(0, sign * s.points[at(q)]!);
  const theirs = (s: State, q: number) => Math.max(0, -sign * s.points[at(q)]!);
  const [a, b] = p.dice!;
  const found: { state: State; used: number[] }[] = [];
  const visit = (s: State, left: number[], used: number[]) => {
    found.push({ state: s, used });
    for (const [i, die] of left.entries()) {
      for (let from = 1; from <= 25; from++) {
        if (from === 25 ? s.bar[seat] === 0 : own(s, from) === 0) continue;
        if (s.bar[seat] > 0 && from !== 25) continue;
        const to = from - die;
        const next: State = {
          points: [...s.points],
          bar: { ...s.bar },
          off: { ...s.off },
        };
        if (from === 25) next.bar[seat]--;
        else next.points[at(from)]! -= sign;
        if (to >= 1) {
          if (theirs(s, to) >= 2) continue;
          if (theirs(s, to) === 1) {
            next.points[at(to)] = 0;
            next.bar[other]++;
          }
          next.points[at(to)]! += sign;
        } else {
          let home = s.bar[seat] === 0;
          for (let q = 7; q <= 24; q++) if (own(s, q) > 0) home = false;
          for (let q = from + 1; to < 0 && q <= 6; q++) {
            if (own(s, q) > 0) home = false;
          }
          if (!home) continue;
          next.off[seat]++;
        }
        visit(next, left.filter((_, j) => j !== i), [...used, die]);
      }
    }
  };
  visit(
    { points: [...p.points], bar: { ...p.bar }, off: { ...p.off } },
    a === b ? [a, a, a, a] : [a, b],
    [],
  );
  const most = found.reduce((m, f) => Math.max(m, f.used.length), 0);
  let best = found.filter((f) => f.used.length === most);
  if (most === 1 && a !== b && best.some((f) => f.used[0] === a)) {
    best = best.filter((f) => f.used[0] === a);
  }
  return new Set(
    best.map(({ state }) =>
      n.encodePosition({ ...state, turn: other, dice: null })
    ),
  );
}

Deno.test("legal plays match a brute-force reference in random Matches", () => {
  const rand = seededRandom(11);
  let checked = 0;
  const kinds = { pass: 0, singleDie: 0, partialDouble: 0 };
  for (let match = 0; match < 10; match++) {
    let p = g.initialPosition();
    while (g.outcome(p) === undefined) {
      const events = g.chanceEvents(p);
      if (events.length > 0) {
        p = g.resolveChance(p, pickChance(events, rand()));
        continue;
      }
      const legal = g.legalMoves(p);
      const after = legal.map((m) => n.encodePosition(g.play(p, m)));
      assertEquals(new Set(after).size, after.length, n.encodePosition(p));
      assertEquals(new Set(after), referencePlays(p), n.encodePosition(p));
      checked++;
      const steps = legal[0]!.steps.length;
      const double = p.dice![0] === p.dice![1];
      if (steps === 0) kinds.pass++;
      else if (steps === 1 && !double) kinds.singleDie++;
      else if (steps < 4 && double) kinds.partialDouble++;
      p = g.play(p, legal[Math.floor(rand() * legal.length)]!);
    }
  }
  assert(checked > 300);
  // The rare cases are actually exercised.
  assert(kinds.pass >= 5 && kinds.singleDie >= 5 && kinds.partialDouble >= 2);
});

Deno.test("stepOrders: every order of single-die Steps that plays a legal Move", () => {
  const p = roll(g.initialPosition(), "3-1");
  const orders = stepOrders(p);
  const of = (steps: string) =>
    orders.find((o) => n.encodeMove({ steps: o.steps }) === steps);
  assertEquals(n.encodeMove(of("8/5 6/5")!.move), "8/5 6/5");
  assertEquals(n.encodeMove(of("6/5 8/5")!.move), "8/5 6/5");
  // One checker moved by both dice, either die first.
  assertEquals(n.encodeMove(of("24/23 23/20")!.move), "24/21 21/20");
  assertEquals(n.encodeMove(of("24/21 21/20")!.move), "24/21 21/20");
  // Steps one die each: no 24/20 in one Step.
  assertEquals(of("24/20"), undefined);
  // Every legal Move is covered, and nothing else.
  const legal = moves(p);
  assertEquals(
    [...new Set(orders.map((o) => n.encodeMove(o.move)))].sort(),
    legal,
  );
  // No order twice.
  const texts = orders.map((o) => n.encodeMove({ steps: o.steps }));
  assertEquals(new Set(texts).size, texts.length);
  // Nothing to order before the roll; pass is played by no Steps.
  assertEquals(stepOrders(g.initialPosition()), []);
  const closed: Layout = { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 3 };
  const stuck = setup({
    white: { bar: 1, 13: 14 },
    black: closed,
    dice: [4, 2],
  });
  assertEquals(stepOrders(stuck).map((o) => [n.encodeMove(o.move), o.steps]), [
    ["pass", []],
  ]);
});

Deno.test("stepOrders: every order plays its Move in random Matches", () => {
  const rand = seededRandom(5);
  for (let match = 0; match < 3; match++) {
    let p = g.initialPosition();
    while (g.outcome(p) === undefined) {
      const events = g.chanceEvents(p);
      if (events.length > 0) {
        p = g.resolveChance(p, pickChance(events, rand()));
        continue;
      }
      for (const { move, steps } of stepOrders(p)) {
        const text = n.encodeMove({ steps });
        assertEquals(
          n.encodeMove(n.decodeMove(text, p)),
          n.encodeMove(move),
          `${text} in ${n.encodePosition(p)}`,
        );
      }
      const legal = g.legalMoves(p);
      p = g.play(p, legal[Math.floor(rand() * legal.length)]!);
    }
  }
});
