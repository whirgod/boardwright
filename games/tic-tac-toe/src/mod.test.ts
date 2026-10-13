import { assertEquals, assertThrows } from "@std/assert";
import { assertGameRulesContract } from "@boardwright/testing";
import { ticTacToe as g, type TicTacToePosition } from "./mod.ts";

const n = g.notation;

/** Play a list of cells from the initial Position. */
function playAll(...moves: string[]): TicTacToePosition {
  return moves.reduce((p, m) => g.play(p, m), g.initialPosition());
}

Deno.test("satisfies the GameRules contract", () => {
  assertGameRulesContract(g, { seed: 42, playouts: 500 });
});

Deno.test("initial position", () => {
  const p = g.initialPosition();
  assertEquals(n.encodePosition(p), ".........:x");
  assertEquals(g.toMove(p), "x");
  assertEquals(g.legalMoves(p).length, 9);
  assertEquals(g.outcome(p), undefined);
  assertEquals(g.seats, ["x", "o"]);
});

Deno.test("notation example", () => {
  const p = n.decodePosition("x.o......:x");
  assertEquals(p.cells[0], "x");
  assertEquals(p.cells[2], "o");
  assertEquals(n.encodePosition(p), "x.o......:x");
});

Deno.test("move maps file a-c and rank 1-3 row-major", () => {
  assertEquals(n.encodePosition(playAll("c1")), "..x......:o");
  assertEquals(n.encodePosition(playAll("a2")), "...x.....:o");
  assertEquals(n.encodePosition(playAll("c3")), "........x:o");
});

Deno.test("wins on every row, column and diagonal", () => {
  // x plays the line, o plays elsewhere without winning.
  const lines: [string[], string[]][] = [
    [["a1", "b1", "c1"], ["a2", "b2"]],
    [["a2", "b2", "c2"], ["a1", "b1"]],
    [["a3", "b3", "c3"], ["a1", "b1"]],
    [["a1", "a2", "a3"], ["b1", "b2"]],
    [["b1", "b2", "b3"], ["a1", "a2"]],
    [["c1", "c2", "c3"], ["a1", "a2"]],
    [["a1", "b2", "c3"], ["b1", "c1"]],
    [["c1", "b2", "a3"], ["a1", "b1"]],
  ];
  for (const [xs, os] of lines) {
    const p = playAll(xs[0]!, os[0]!, xs[1]!, os[1]!, xs[2]!);
    assertEquals(
      g.outcome(p),
      { winner: "x", reason: "three-in-a-row" },
      xs.join(),
    );
    assertEquals(g.toMove(p), undefined);
    assertEquals(g.legalMoves(p), []);
  }
});

Deno.test("o can win", () => {
  const p = playAll("a1", "a2", "b1", "b2", "c3", "c2");
  assertEquals(g.outcome(p), { winner: "o", reason: "three-in-a-row" });
  assertEquals(g.toMove(p), undefined);
});

Deno.test("draw by full board", () => {
  // x o x / x o o / o x x
  const p = playAll("a1", "b1", "c1", "b2", "a2", "c2", "b3", "a3", "c3");
  assertEquals(n.encodePosition(p), "xoxxoooxx:o");
  assertEquals(g.outcome(p), { reason: "board-full" });
  assertEquals(g.toMove(p), undefined);
  assertEquals(g.legalMoves(p), []);
});

Deno.test("win on the last move beats board-full", () => {
  const p = n.decodePosition("xoxoxoox.:x");
  assertEquals(g.outcome(g.play(p, "c3")), {
    winner: "x",
    reason: "three-in-a-row",
  });
});

Deno.test("illegal moves throw and leave the position untouched", () => {
  const p = playAll("a1");
  const before = n.encodePosition(p);
  assertThrows(() => g.play(p, "a1"), Error, "Illegal move");
  assertThrows(() => g.play(p, "d4"), Error, "Illegal move");
  assertEquals(n.encodePosition(p), before);
  const won = playAll("a1", "a2", "b1", "b2", "c1");
  assertThrows(() => g.play(won, "c3"), Error, "Illegal move");
});

Deno.test("decodePosition rejects invalid positions", () => {
  for (
    const bad of [
      "",
      ".........",
      ".........:z",
      "........:x",
      "..........:x",
      "X........:o",
      "xx.......:o", // piece counts
      "x........:x", // wrong side to move
      ".........:o", // wrong side to move
      "xxxooo...:x", // both Seats have a line
      "xxx.oo.o.:x", // winner x did not move last
      "oooxxxx..:o", // o line but x moved last
    ]
  ) {
    assertThrows(() => n.decodePosition(bad), Error, "Invalid", bad);
  }
});

Deno.test("decodeMove rejects invalid moves", () => {
  const p = g.initialPosition();
  for (const bad of ["", "a", "a0", "a4", "d1", "A1", "a11", " a1"]) {
    assertThrows(() => n.decodeMove(bad, p), Error, "Invalid", bad);
  }
  assertEquals(n.decodeMove("b2", p), "b2");
});
