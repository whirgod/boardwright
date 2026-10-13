import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import { assertGameRulesContract } from "@boardwright/testing";
import {
  chess as g,
  type ChessPosition,
  INITIAL_FEN,
  isInsufficientMaterial,
  parseSquare,
  squareName,
} from "./mod.ts";

const n = g.notation;
const pos = (fen: string): ChessPosition => n.decodePosition(fen);
const fen = (p: ChessPosition): string => n.encodePosition(p);
const moves = (p: ChessPosition): string[] =>
  g.legalMoves(p).map((m) => n.encodeMove(m)).sort();
const play = (p: ChessPosition, ...uci: string[]): ChessPosition =>
  uci.reduce((q, t) => g.play(q, n.decodeMove(t, q)), p);

Deno.test("satisfies the GameRules contract", () => {
  assertGameRulesContract(g, {
    seed: 14,
    playouts: 40,
    garbage: [
      "e2e2",
      "e2e4x",
      "E2E4",
      "e7e8k",
      "e2-e4",
      "i1a1",
      "e9e8",
      INITIAL_FEN + " ",
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
    ],
  });
});

Deno.test("initial position", () => {
  const p = g.initialPosition();
  assertEquals(g.seats, ["white", "black"]);
  assertEquals(g.toMove(p), "white");
  assertEquals(g.outcome(p), undefined);
  assertEquals(fen(p), INITIAL_FEN);
  assertEquals(moves(p).length, 20);
  assertEquals(p.board[parseSquare("e1")], "K");
  assertEquals(p.board[parseSquare("d8")], "q");
});

Deno.test("squares", () => {
  assertEquals(squareName(0), "a1");
  assertEquals(squareName(63), "h8");
  assertEquals(parseSquare("e4"), 28);
  assertThrows(() => parseSquare("e9"));
  assertThrows(() => parseSquare("E4"));
});

Deno.test("FEN round trip and move counters", () => {
  const p = play(g.initialPosition(), "e2e4", "c7c5", "g1f3");
  assertEquals(
    fen(p).split(" ").slice(0, 6).join(" "),
    "rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
  );
  assertEquals(
    fen(play(g.initialPosition(), "e2e4")),
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
  );
  for (
    const text of [
      "4k3/8/8/8/8/8/8/4K3 b - - 37 120",
      "r3k2r/8/8/8/8/8/8/R3K2R w Kq - 0 1",
    ]
  ) assertEquals(fen(pos(text)), text);
});

Deno.test("invalid positions are rejected", () => {
  for (
    const bad of [
      "",
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0", // 5 fields
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1", // 7 ranks
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN w KQkq - 0 1", // short
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNRR w KQkq - 0 1", // long
      "rnbqkbnr/pppppppp/44/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", // digits
      "rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      "rnbqkbnr/pppppppp/7x/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      "rnbqkbnr/pppppppp//8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1", // turn
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w QK - 0 1", // order
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w  - 0 1",
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 01 1",
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 0",
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - -1 1",
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e3 0 1", // ep
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e4 0 1",
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e3 0 1",
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 1 1",
      "rnbqkbnr/pppppppp/8/8/4P3/4N3/PPPP1PPP/RNBQKB1R b KQkq e3 0 1",
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQ1BNR w KQkq - 0 1", // no K
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBKKBNR w kq - 0 1", // two K
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNP w kq - 0 1", // P rank 1
      "rnbqkbnp/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w Qq - 0 1", // p rank 8
      "rnbqkbnr/pppppppp/8/8/8/P7/PPPPPPPP/RNBQKBNR w KQkq - 0 1", // 9 P
      "rnbqkbnr/pppppppp/8/8/8/N7/PPPPPPPP/RNBQKBNR w KQkq - 0 1", // 17
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN1 w KQkq - 0 1", // no Rh1
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQ1BNR w Qkq - 0 1",
      "4k3/8/8/8/8/8/8/4K2r b - - 0 1", // side not to move in check
      "4k2R/8/8/8/8/8/8/4K3 w - - 0 1",
    ]
  ) {
    assertThrows(() => pos(bad), Error, undefined, bad);
  }
});

Deno.test("move notation is strict UCI", () => {
  const p = g.initialPosition();
  assertEquals(n.decodeMove("e2e4", p), { from: 12, to: 28 });
  assertEquals(n.decodeMove("a7a8q", p), {
    from: 48,
    to: 56,
    promotion: "q",
  });
  assertEquals(n.encodeMove({ from: 52, to: 60, promotion: "n" }), "e7e8n");
  for (const bad of ["e2e2", "e2e4 ", "e2e4Q", "e7e8k", "0-0", "Nf3"]) {
    assertThrows(() => n.decodeMove(bad, p), Error, undefined, bad);
  }
});

Deno.test("illegal moves throw, also in terminal positions", () => {
  const p = g.initialPosition();
  assertThrows(() => play(p, "e2e5"), Error, "Illegal move e2e5");
  assertThrows(() => play(p, "e7e5"));
  const mated = play(p, "f2f3", "e7e5", "g2g4", "d8h4");
  assertThrows(() => play(mated, "e1f2"));
});

Deno.test("castling: both sides, rook moves and rights update", () => {
  const p = pos("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  assert(moves(p).includes("e1g1"));
  assert(moves(p).includes("e1c1"));
  const short = play(p, "e1g1");
  assertEquals(fen(short), "r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1");
  const long = play(short, "e8c8");
  assertEquals(fen(long), "2kr3r/8/8/8/8/8/8/R4RK1 w - - 2 2");
  // Moving a rook or the king, or losing a rook, removes rights.
  assertEquals(play(p, "h1h2").castling, "Qkq");
  assertEquals(play(p, "e1e2").castling, "kq");
  assertEquals(play(p, "a1a8").castling, "Kk");
  assertEquals(play(p, "h1h8").castling, "Qq");
});

Deno.test("castling: not out of, through or into check, not when blocked", () => {
  const castles = (text: string) =>
    moves(pos(text)).filter((m) => m === "e1g1" || m === "e1c1");
  assertEquals(castles("4k3/8/8/8/4r3/8/8/R3K2R w KQ - 0 1"), []); // check
  assertEquals(castles("4kr2/8/8/8/8/8/8/R3K2R w KQ - 0 1"), ["e1c1"]); // f1
  assertEquals(castles("4k1r1/8/8/8/8/8/8/R3K2R w KQ - 0 1"), ["e1c1"]); // g1
  assertEquals(castles("3rk3/8/8/8/8/8/8/R3K2R w KQ - 0 1"), ["e1g1"]); // d1
  assertEquals(castles("2r1k3/8/8/8/8/8/8/R3K2R w KQ - 0 1"), ["e1g1"]); // c1
  // b1 may be attacked; only the king's path matters.
  assertEquals(castles("1r2k3/8/8/8/8/8/8/R3K2R w KQ - 0 1"), [
    "e1c1",
    "e1g1",
  ]);
  assertEquals(castles("4k3/8/8/8/8/8/8/RN2K1NR w KQ - 0 1"), []); // blocked
  assertEquals(castles("4k3/8/8/8/8/8/8/R3K2R w - - 0 1"), []); // no rights
});

Deno.test("en passant: capture, expiry and pins", () => {
  const p = play(pos("4k3/8/8/8/3p4/8/4P3/4K3 w - - 0 1"), "e2e4");
  assertEquals(p.enPassant, parseSquare("e3"));
  assert(moves(p).includes("d4e3"));
  assertEquals(fen(play(p, "d4e3")), "4k3/8/8/8/8/4p3/8/4K3 w - - 0 2");
  // Only immediately.
  assertFalse(moves(play(p, "e8e7", "e1d1")).includes("d4e3"));
  // Capturing would expose the king along the rank.
  const pinned = pos("8/8/8/8/k2pP2R/8/8/4K3 b - e3 0 1");
  assertFalse(moves(pinned).includes("d4e3"));
  assert(moves(pinned).includes("d4d3"));
});

Deno.test("promotion to every piece, with and without capture", () => {
  const p = pos("r3k3/1P6/8/8/8/8/8/4K3 w - - 0 1");
  assertEquals(moves(p).filter((m) => m.startsWith("b7")), [
    "b7a8b",
    "b7a8n",
    "b7a8q",
    "b7a8r",
    "b7b8b",
    "b7b8n",
    "b7b8q",
    "b7b8r",
  ]);
  assertThrows(() => play(p, "b7b8"));
  assertEquals(play(p, "b7b8n").board[parseSquare("b8")], "N");
  assertEquals(play(p, "b7a8r").board[parseSquare("a8")], "R");
  assertEquals(play(p, "b7b8q").halfmoveClock, 0);
  assertThrows(() => play(g.initialPosition(), "e2e3q"));
});

Deno.test("checkmate and stalemate", () => {
  const mated = play(g.initialPosition(), "f2f3", "e7e5", "g2g4", "d8h4");
  assertEquals(g.outcome(mated), { winner: "black", reason: "checkmate" });
  assertEquals(g.toMove(mated), undefined);
  assertEquals(g.legalMoves(mated), []);
  const stalemate = pos("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
  assertEquals(g.outcome(stalemate), { reason: "stalemate" });
  // Check is not mate while a move exists.
  const check = play(g.initialPosition(), "e2e4", "f7f6", "d1h5");
  assertEquals(g.outcome(check), undefined);
  assertEquals(moves(check), ["g7g6"]);
});

Deno.test("threefold repetition", () => {
  const cycle = ["g1f3", "g8f6", "f3g1", "f6g8"];
  const twice = play(g.initialPosition(), ...cycle);
  assertEquals(g.outcome(twice), undefined);
  const thrice = play(twice, ...cycle);
  assertEquals(g.outcome(thrice), { reason: "threefold-repetition" });
  assertEquals(g.legalMoves(thrice), []);
  // History survives a FEN round trip.
  const mid = play(twice, "g1f3");
  assertEquals(pos(fen(mid)), mid);
  assertEquals(g.outcome(play(pos(fen(mid)), "g8f6", "f3g1", "f6g8")), {
    reason: "threefold-repetition",
  });
});

Deno.test("repetition ignores an en passant square nobody can use", () => {
  const cycle = ["g8f6", "g1f3", "f6g8", "f3g1"];
  // After 1. e4 the FEN has e3, but no black pawn can capture.
  const p = play(g.initialPosition(), "e2e4", ...cycle, ...cycle);
  assertEquals(g.outcome(p), { reason: "threefold-repetition" });
  // A usable en passant square makes the Position different.
  const q = play(pos("4k3/8/8/8/3p4/8/4P3/4K3 w - - 0 1"), "e2e4", "e8d8");
  assertEquals(q.history, ["4k3/8/8/8/3pP3/8/8/4K3:b:-:e3"]);
});

Deno.test("history resets on pawn moves, captures and castling-right loss", () => {
  const p = pos("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  assertEquals(play(p, "a1b1").history, []);
  assertEquals(play(p, "a1b1").halfmoveClock, 1);
  const q = play(p, "a1b1", "e8f8");
  assertEquals(q.history, []);
  assertEquals(play(q, "b1c1").history.length, 1);
  assertEquals(play(g.initialPosition(), "g1f3", "e7e5").history, []);
});

Deno.test("history notation is validated", () => {
  const ok = fen(play(g.initialPosition(), "g1f3", "g8f6"));
  const [base, history] = [ok.slice(0, ok.lastIndexOf(" ")), ok.split(" ")[6]];
  assertEquals(
    history,
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR:w:KQkq:-|" +
      "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R:b:KQkq:-",
  );
  const [entry0, entry1] = history!.split("|") as [string, string];
  for (
    const bad of [
      `${base} ${entry0}`, // wrong turn order for its age
      `${base.replace(" 2 2", " 1 2")} ${history}`, // longer than clock
      `${base} ${entry1}|${entry0}`,
      `${base} garbage|${entry1}`,
      `${base} ${entry0.replace("8/8/8/8", "44/8/8/8")}|${entry1}`,
      `${base} ${entry0.replace("KQkq", "Kkq")}|${entry1}`,
      `${base} ${entry0.replace(":-", ":e3")}|${entry1}`,
    ]
  ) {
    assertThrows(() => pos(bad), Error, undefined, bad);
  }
});

Deno.test("fifty-move rule, checkmate takes precedence", () => {
  const p = pos("4k3/8/8/8/8/8/R7/K7 w - - 99 80");
  assertEquals(g.outcome(p), undefined);
  assertEquals(g.outcome(play(p, "a2b2")), { reason: "fifty-move-rule" });
  // A pawn move resets the clock.
  const q = pos("4k3/8/8/8/8/8/P7/K7 w - - 99 80");
  assertEquals(play(q, "a2a3").halfmoveClock, 0);
  const mate = pos("k7/8/1K6/8/8/8/8/7R w - - 99 80");
  assertEquals(g.outcome(play(mate, "h1h8")), {
    winner: "white",
    reason: "checkmate",
  });
});

Deno.test("insufficient material", () => {
  const dead = [
    "4k3/8/8/8/8/8/8/4K3 w - - 0 1", // K v K
    "4k3/8/8/8/8/8/8/3NK3 w - - 0 1", // KN v K
    "4k3/8/8/8/8/8/8/2B1K3 w - - 0 1", // KB v K
    "5b2/8/8/4k3/8/8/8/2B1K3 w - - 0 1", // KB v KB, same colour
    "4k3/8/8/8/8/8/1B6/2B1K3 w - - 0 1", // bishops on one colour only
  ];
  for (const text of dead) {
    assertEquals(g.outcome(pos(text)), { reason: "insufficient-material" });
  }
  const alive = [
    "2b1k3/8/8/8/8/8/8/2B1K3 w - - 0 1", // opposite-coloured bishops
    "4k3/8/8/8/8/8/8/2NNK3 w - - 0 1", // two knights
    "3nk3/8/8/8/8/8/8/3NK3 w - - 0 1", // KN v KN
    "3nk3/8/8/8/8/8/8/2B1K3 w - - 0 1", // KB v KN
    "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1",
    "4k3/8/8/8/8/8/8/R3K3 w - - 0 1",
    "4k3/8/8/8/8/8/8/3QK3 w - - 0 1",
  ];
  for (const text of alive) {
    assertFalse(isInsufficientMaterial(pos(text).board));
  }
  // A capture that leaves bare kings ends the Match.
  const p = play(pos("8/8/8/4k3/8/8/4q3/4K3 w - - 0 1"), "e1e2");
  assertEquals(g.outcome(p), { reason: "insufficient-material" });
});
