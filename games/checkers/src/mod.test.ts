import { assertEquals, assertThrows } from "@std/assert";
import { assertGameRulesContract } from "@boardwright/testing";
import { checkers as g, type CheckersPosition } from "./mod.ts";

const n = g.notation;
const pos = (fen: string): CheckersPosition => n.decodePosition(fen);
const moves = (p: CheckersPosition): string[] =>
  g.legalMoves(p).map((m) => n.encodeMove(m)).sort();
const play = (p: CheckersPosition, ...texts: string[]): CheckersPosition =>
  texts.reduce((q, t) => g.play(q, n.decodeMove(t, q)), p);

Deno.test("satisfies the GameRules contract", () => {
  assertGameRulesContract(g, {
    seed: 7,
    playouts: 15,
    garbage: ["B:W:B1:x", "11-", "11x", "0-4", "33-1", "1x2-3", "11-15-19"],
  });
});

Deno.test("initial position", () => {
  const p = g.initialPosition();
  assertEquals(g.seats, ["black", "white"]);
  assertEquals(g.toMove(p), "black");
  assertEquals(g.outcome(p), undefined);
  assertEquals(
    n.encodePosition(p),
    "B:W21,22,23,24,25,26,27,28,29,30,31,32:B1,2,3,4,5,6,7,8,9,10,11,12",
  );
  assertEquals(moves(p), [
    "10-14",
    "10-15",
    "11-15",
    "11-16",
    "12-16",
    "9-13",
    "9-14",
  ]);
});

Deno.test("position notation round-trips, including the issue example", () => {
  const fen = "B:W21,22,K30:B1,2,3";
  const p = pos(fen);
  assertEquals(n.encodePosition(p), fen);
  assertEquals(p.board[29], "W");
  assertEquals(p.board[20], "w");
  assertEquals(p.board[0], "b");
  assertEquals(p.clock, 0);
  assertEquals(n.encodePosition(pos("W:W:BK5")), "W:W:BK5");
  // Unsorted input is accepted and normalized.
  assertEquals(n.encodePosition(pos("B:W22,21:B3,K1")), "B:W21,22:BK1,3");
});

Deno.test("position notation with clock and history", () => {
  const p = play(pos("B:WK32:BK1"), "1-5", "32-28", "5-1");
  assertEquals(p.clock, 3);
  const text = n.encodePosition(p);
  assertEquals(text, "W:WK28:BK1:3:B/K32/K1|W/K32/K5|B/K28/K5");
  assertEquals(pos(text), p);
  assertEquals(n.encodePosition(pos("B:WK32:BK1:9")), "B:WK32:BK1:9");
});

Deno.test("invalid positions are rejected", () => {
  for (
    const bad of [
      "",
      "B",
      "X:W1:B2",
      "B:B1:W2",
      "B:W1:B1", // duplicate square
      "B:W0:B2",
      "B:W33:B2",
      "B:Wx:B2",
      "B:W1,,2:B3",
      "B:WK:B3",
      "B:W1:B29", // black man on its crown row
      "B:W1:B2:abc",
      "B:W1:B2:5:B/1/2|B/1/2|B/1/2|B/1/2|B/1/2|B/1/2", // history > clock
      "B:W1:B2:5:garbage",
      "B:W1:B2:5:B/99/2",
      "B:W1:B2:1:2:3",
      "B:W5,6,7,8,9,10,11,12,13,14,15,16,17:B20", // 13 pieces
      "B:W1:B2:0",
      "B:W1:B2:007",
      "B:WK32:BK1:1:", // trailing separator
      "B:WK32:BK1:1:B/K32/K1", // wrong turn order
      "B:WK32:BK1:2:W/K32/K1|W/K32/K1", // turn order
      "B:WK32,K28:BK1:1:W/K32,K28/K1", // unsorted key
      "B:WK32:BK1:0:W/K32/K1", // history with clock 0
      "B:W1:B2:",
    ]
  ) {
    assertThrows(() => pos(bad), Error, "Invalid checkers position", bad);
  }
});

Deno.test("white men may not stand on their crown row", () => {
  assertThrows(() => pos("B:W3:B20"), Error, "uncrowned man");
});

Deno.test("move notation", () => {
  assertEquals(n.decodeMove("11-15", g.initialPosition()), [11, 15]);
  assertEquals(n.decodeMove("22x15x8", g.initialPosition()), [22, 15, 8]);
  assertEquals(n.encodeMove([11, 15]), "11-15");
  assertEquals(n.encodeMove([22, 15, 8]), "22x15x8");
  assertEquals(n.encodeMove([22, 15]), "22x15");
  assertEquals(n.encodeMove([14, 9]), "14-9");
  for (
    const bad of [
      "11-",
      "x",
      "11x",
      "0-4",
      "33-1",
      "11-15-19",
      "1x2-3",
      "01-05", // leading zero
      "11x15", // step written as capture
      "22-15", // capture written as step
      "5x6", // same row: neither step nor jump
    ]
  ) {
    assertThrows(
      () => n.decodeMove(bad, g.initialPosition()),
      Error,
      "Invalid",
    );
  }
});

Deno.test("men step diagonally forward only", () => {
  // Black moves towards 32, white towards 1.
  assertEquals(moves(pos("B:W32:B14")), ["14-17", "14-18"]);
  assertEquals(moves(pos("W:W18:B1")), ["18-14", "18-15"]);
  // Edge pieces have a single step.
  assertEquals(moves(pos("B:W32:B13")), ["13-17"]);
  assertEquals(moves(pos("B:W32:B12")), ["12-16"]);
  // Blocked steps are not listed.
  assertEquals(moves(pos("B:W17,21,32:B14")), ["14-18"]);
});

Deno.test("captures are mandatory, and exclude plain steps", () => {
  assertEquals(moves(pos("B:W15:B11")), ["11x18"]);
  // Another piece with only steps may not move while a capture exists.
  assertEquals(moves(pos("B:W15:B1,11")), ["11x18"]);
  assertThrows(() => g.play(pos("B:W15:B1,11"), [1, 5]), Error, "Illegal");
  // Several captures: all are legal, the player chooses.
  assertEquals(moves(pos("B:W15,16:B11,12")), ["11x18", "11x20", "12x19"]);
  assertEquals(moves(pos("B:W14,15:B10")), ["10x17", "10x19"]);
});

Deno.test("men do not capture backward; blocked landing prevents a jump", () => {
  assertEquals(moves(pos("B:W10,32:B14")), ["14-17", "14-18"]);
  // Landing square occupied: no capture, just steps.
  assertEquals(moves(pos("B:W15,18:B11")), ["11-16"]);
  // Cannot jump a friendly piece.
  assertEquals(moves(pos("B:W32:B11,15")), ["11-16", "15-18", "15-19"]);
});

Deno.test("capture removes the piece and moves the jumper", () => {
  const p = play(pos("B:W15,32:B11"), "11x18");
  assertEquals(n.encodePosition(p), "W:W32:B18");
  assertEquals(p.turn, "white");
});

Deno.test("multi-jump with branching is one Move; any sequence may be chosen", () => {
  const p = pos("B:W14,15,22,24:B10");
  assertEquals(moves(p), ["10x17x26", "10x19x28"]);
  const q = play(p, "10x17x26");
  assertEquals(n.encodePosition(q), "W:W15,24:B26");
  // The shorter sequence is still allowed (no maximum-capture rule).
  assertEquals(moves(pos("B:W14,15,22:B10")), ["10x17x26", "10x19"]);
  // A partial jump is not a legal Move when it can continue.
  assertThrows(() => g.play(p, [10, 17]), Error, "Illegal");
});

Deno.test("a king may jump in a circuit and land on its own origin", () => {
  const p = pos("B:W10,11,18,19:BK14");
  assertEquals(moves(p), ["14x23x16x7x14", "14x7x16x23x14"]);
  const q = play(p, "14x7x16x23x14");
  assertEquals(n.encodePosition(q), "W:W:BK14");
  assertEquals(g.outcome(q), { winner: "black", reason: "no-legal-moves" });
});

Deno.test("a piece cannot be jumped twice", () => {
  // Black king on 14 jumps 18 to 23; from 23 the only other piece is 18 again.
  assertEquals(moves(pos("B:W18,32:BK14")), ["14x23"]);
});

Deno.test("crowning ends the Move", () => {
  const p = pos("B:W26,27:B22");
  // As a king 31 could continue over 27, but a man ends its turn on crowning.
  assertEquals(moves(p), ["22x31"]);
  const q = play(p, "22x31");
  assertEquals(q.board[30], "B");
  assertEquals(n.encodePosition(q), "W:W27:BK31");
  // Steps crown too, for both Seats.
  assertEquals(play(pos("B:WK1:B26"), "26-30").board[29], "B");
  assertEquals(play(pos("W:W6:BK32"), "6-1").board[0], "W");
  assertEquals(play(pos("W:W6:BK32"), "6-2").board[1], "W");
});

Deno.test("kings move and capture in all four directions", () => {
  assertEquals(moves(pos("B:W32:BK14")), ["14-10", "14-17", "14-18", "14-9"]);
  assertEquals(moves(pos("W:WK18:B1")), ["18-14", "18-15", "18-22", "18-23"]);
  // Backward and then forward within one Move.
  assertEquals(moves(pos("B:W10,11:BK14")), ["14x7x16"]);
  // Backward capture by a king (a man could not).
  assertEquals(moves(pos("B:W10,32:BK14")), ["14x7"]);
  // A king capturing keeps its rank.
  assertEquals(play(pos("B:W10,32:BK14"), "14x7").board[6], "B");
});

Deno.test("a Seat with no pieces or no legal Move loses", () => {
  const none = pos("B:W21:B");
  assertEquals(g.outcome(none), { winner: "white", reason: "no-legal-moves" });
  assertEquals(g.toMove(none), undefined);
  assertEquals(g.legalMoves(none), []);
  // Blocked: black man on 28 faces a white king on 32; no jump possible.
  const blocked = pos("B:WK32:B28");
  assertEquals(g.outcome(blocked), {
    winner: "white",
    reason: "no-legal-moves",
  });
  // The final capture ends the Match.
  const last = play(pos("B:W15:B11"), "11x18");
  assertEquals(g.outcome(last), {
    winner: "black",
    reason: "no-legal-moves",
  });
});

Deno.test("draw after 40 moves by each side without capture or man move", () => {
  const almost = pos("B:WK32:BK1:79");
  assertEquals(g.outcome(almost), undefined);
  const drawn = play(almost, "1-5");
  assertEquals(drawn.clock, 80);
  assertEquals(g.outcome(drawn), { reason: "forty-move-rule" });
  assertEquals(g.toMove(drawn), undefined);
  assertEquals(g.legalMoves(drawn), []);
  assertThrows(() => g.play(drawn, [32, 28]), Error, "Illegal");
});

Deno.test("clock counts king moves and resets on a man move or capture", () => {
  const p = pos("B:WK32,17:BK1,9:50");
  const king = play(p, "1-5");
  assertEquals(king.clock, 51);
  assertEquals(king.history.length, 1);
  const man = play(p, "9-13");
  assertEquals(man.clock, 0);
  assertEquals(man.history, []);
  const cap = play(pos("B:W15:BK1,11:50"), "11x18");
  assertEquals(cap.clock, 0);
  // A king capture also resets.
  assertEquals(play(pos("B:W10,32:BK14:50"), "14x7").clock, 0);
});

Deno.test("draw by threefold repetition", () => {
  const start = pos("B:WK32:BK1");
  const cycle = ["1-5", "32-28", "5-1", "28-32"];
  let p = start;
  for (const m of cycle) p = play(p, m);
  assertEquals(n.encodePosition(p).startsWith("B:WK32:BK1:4:"), true);
  assertEquals(g.outcome(p), undefined); // second occurrence
  for (const m of cycle.slice(0, 3)) p = play(p, m);
  assertEquals(g.outcome(p), undefined);
  p = play(p, cycle[3]!); // third occurrence
  assertEquals(g.outcome(p), { reason: "threefold-repetition" });
  assertEquals(g.toMove(p), undefined);
  assertEquals(g.legalMoves(p), []);
  // Survives a notation round trip.
  assertEquals(g.outcome(pos(n.encodePosition(p))), {
    reason: "threefold-repetition",
  });
});

Deno.test("repetition requires the same Seat to move", () => {
  // Same pieces, other side to move: not a repetition of the first Position.
  const a = pos("B:WK32:BK1");
  const b = play(a, "1-5", "32-28");
  assertEquals(b.history.length, 2);
  assertEquals(g.outcome(b), undefined);
});

Deno.test("play rejects illegal moves without mutating the Position", () => {
  const p = g.initialPosition();
  const before = n.encodePosition(p);
  assertThrows(() => g.play(p, [9, 18]), Error, "Illegal move");
  assertThrows(() => g.play(p, [21, 17]), Error, "Illegal move");
  assertEquals(n.encodePosition(p), before);
});

Deno.test("a short opening plays through", () => {
  let p = g.initialPosition();
  p = play(p, "11-15", "22-18", "15x22", "25x18", "8-11", "29-25");
  assertEquals(g.outcome(p), undefined);
  assertEquals(p.turn, "black");
});

Deno.test("a 12-piece side is accepted", () => {
  const p = pos("B:W5,6,7,8,9,10,11,12,13,14,15,16:B20");
  assertEquals(p.board.filter((c) => c === "w").length, 12);
});

// Standard numbering: neighbours of every square (all four diagonals).
const STEPS: Record<number, number[]> = {
  1: [5, 6],
  2: [6, 7],
  3: [7, 8],
  4: [8],
  5: [1, 9],
  6: [1, 2, 9, 10],
  7: [2, 3, 10, 11],
  8: [3, 4, 11, 12],
  9: [5, 6, 13, 14],
  10: [6, 7, 14, 15],
  11: [7, 8, 15, 16],
  12: [8, 16],
  13: [9, 17],
  14: [9, 10, 17, 18],
  15: [10, 11, 18, 19],
  16: [11, 12, 19, 20],
  17: [13, 14, 21, 22],
  18: [14, 15, 22, 23],
  19: [15, 16, 23, 24],
  20: [16, 24],
  21: [17, 25],
  22: [17, 18, 25, 26],
  23: [18, 19, 26, 27],
  24: [19, 20, 27, 28],
  25: [21, 22, 29, 30],
  26: [22, 23, 30, 31],
  27: [23, 24, 31, 32],
  28: [24, 32],
  29: [25],
  30: [25, 26],
  31: [26, 27],
  32: [27, 28],
};

// Jumps from each square as "over>landing".
const JUMPS: Record<number, string[]> = {
  1: ["6>10"],
  2: ["6>9", "7>11"],
  3: ["7>10", "8>12"],
  4: ["8>11"],
  5: ["9>14"],
  6: ["9>13", "10>15"],
  7: ["10>14", "11>16"],
  8: ["11>15"],
  9: ["14>18", "6>2"],
  10: ["14>17", "15>19", "6>1", "7>3"],
  11: ["15>18", "16>20", "7>2", "8>4"],
  12: ["16>19", "8>3"],
  13: ["17>22", "9>6"],
  14: ["17>21", "18>23", "9>5", "10>7"],
  15: ["18>22", "19>24", "10>6", "11>8"],
  16: ["19>23", "11>7"],
  17: ["22>26", "14>10"],
  18: ["22>25", "23>27", "14>9", "15>11"],
  19: ["23>26", "24>28", "15>10", "16>12"],
  20: ["24>27", "16>11"],
  21: ["25>30", "17>14"],
  22: ["25>29", "26>31", "17>13", "18>15"],
  23: ["26>30", "27>32", "18>14", "19>16"],
  24: ["27>31", "19>15"],
  25: ["22>18"],
  26: ["22>17", "23>19"],
  27: ["23>18", "24>20"],
  28: ["24>19"],
  29: ["25>22"],
  30: ["25>21", "26>23"],
  31: ["26>22", "27>24"],
  32: ["27>23"],
};

const byNumber = (a: number, b: number) => a - b;

Deno.test("step adjacency of every square matches standard numbering", () => {
  for (let s = 1; s <= 32; s++) {
    const all = STEPS[s]!;
    const dests = (m: string[]) =>
      m.map((t) => Number(t.split("-")[1])).sort(byNumber);
    // Lone king (either Seat): all neighbours.
    assertEquals(dests(moves(pos(`B:W:BK${s}`))), all, `black king ${s}`);
    assertEquals(dests(moves(pos(`W:WK${s}:B`))), all, `white king ${s}`);
    // Black men move towards 32, white men towards 1 (crown row is invalid).
    if (s <= 28) {
      assertEquals(
        dests(moves(pos(`B:W:B${s}`))),
        all.filter((d) => d > s),
        `black man ${s}`,
      );
    }
    if (s >= 5) {
      assertEquals(
        dests(moves(pos(`W:W${s}:B`))),
        all.filter((d) => d < s),
        `white man ${s}`,
      );
    }
  }
});

Deno.test("jump geometry of every square matches standard numbering", () => {
  for (let s = 1; s <= 32; s++) {
    const jumps = JUMPS[s]!;
    // Consistency of the two tables: a jump spans neighbour then neighbour.
    for (const j of jumps) {
      assertEquals(STEPS[s]!.includes(Number(j.split(">")[0])), true);
    }
    for (const over of STEPS[s]!) {
      // King with one enemy king on a single neighbour and nothing else.
      const landing = jumps.find((j) => j.startsWith(`${over}>`))?.split(
        ">",
      )[1];
      const got = moves(pos(`B:WK${over}:BK${s}`));
      if (landing) {
        assertEquals(got, [`${s}x${landing}`], `${s} over ${over}`);
      } else {
        assertEquals(
          got,
          STEPS[s]!.filter((d) => d !== over).map((d) => `${s}-${d}`).sort(),
          `${s} cannot jump ${over}`,
        );
      }
    }
    // Landing square occupied: the jump is not available.
    for (const j of jumps) {
      const [over, land] = j.split(">").map(Number);
      const got = moves(pos(`B:WK${over},K${land}:BK${s}`));
      assertEquals(
        got.some((m) => m.includes("x")),
        false,
        `${s} blocked landing ${land}`,
      );
    }
  }
});

Deno.test("three-jump man sequence", () => {
  // From 5: over 9 to 14, over 18 to 23, over 27 to 32.
  const p = pos("B:W9,18,27:B5");
  assertEquals(moves(p), ["5x14x23x32"]);
  // Reaching 32 crowns, ending the Move.
  const q = play(p, "5x14x23x32");
  assertEquals(n.encodePosition(q), "W:W:BK32");
});

Deno.test("a king's jump sequence can branch", () => {
  // King on 14: over 10 to 7, or over 18 to 23; each continues differently.
  const p = pos("B:W10,18,15,11:BK14");
  const got = moves(p);
  // From 7: over 11 to 16 (then over 19? absent); from 23: nothing.
  assertEquals(got, ["14x23", "14x7x16"]);
});

Deno.test("a circuit never jumps a captured piece again", () => {
  // After the full circuit the king is back on 14 next to captured 18; it
  // could jump 18 again (23 is empty) but captured pieces stay and are not
  // jumpable twice, so both Moves end after four jumps.
  const p = pos("B:W10,11,18,19:BK14");
  for (const m of moves(p)) assertEquals(m.split("x").length, 5);
});

Deno.test("loss takes precedence over the draw rules", () => {
  const blocked = pos("B:WK32:B28:80");
  assertEquals(g.outcome(blocked), {
    winner: "white",
    reason: "no-legal-moves",
  });
});
