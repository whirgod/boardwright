import { assertEquals, assertThrows } from "@std/assert";
import { chess as g, type ChessPosition, formatSan, parseSan } from "./mod.ts";

const n = g.notation;
const pos = (fen: string): ChessPosition => n.decodePosition(fen);
const san = (p: ChessPosition, uci: string): string =>
  formatSan(p, n.decodeMove(uci, p));

Deno.test("SAN: pawn and piece moves, captures, castling", () => {
  const p = g.initialPosition();
  assertEquals(san(p, "e2e4"), "e4");
  assertEquals(san(p, "g1f3"), "Nf3");
  const q = pos("r3k2r/8/8/3p4/4P3/8/8/R3K2R w KQkq - 0 1");
  assertEquals(san(q, "e4d5"), "exd5");
  assertEquals(san(q, "e1g1"), "O-O");
  assertEquals(san(q, "e1c1"), "O-O-O");
  assertEquals(san(q, "a1a8"), "Rxa8+");
  const ep = pos("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
  assertEquals(san(ep, "e5d6"), "exd6");
});

Deno.test("SAN: promotion and check/mate suffixes", () => {
  const p = pos("r3k3/1P6/8/8/8/8/8/4K3 w - - 0 1");
  assertEquals(san(p, "b7b8q"), "b8=Q+");
  assertEquals(san(p, "b7b8n"), "b8=N");
  assertEquals(san(p, "b7a8q"), "bxa8=Q+");
  const fool = [["f2f3", "f3"], ["e7e5", "e5"], ["g2g4", "g4"], [
    "d8h4",
    "Qh4#",
  ]];
  let q = g.initialPosition();
  for (const [uci, expected] of fool) {
    assertEquals(san(q, uci!), expected);
    q = g.play(q, n.decodeMove(uci!, q));
  }
});

Deno.test("SAN: disambiguation by file, rank, both, and only among legal moves", () => {
  const files = pos("4k3/8/8/8/8/8/K7/R6R w - - 0 1");
  assertEquals(san(files, "a1d1"), "Rad1");
  assertEquals(san(files, "h1d1"), "Rhd1");
  const ranks = pos("4k3/8/8/R7/8/8/8/R3K3 w - - 0 1");
  assertEquals(san(ranks, "a1a3"), "R1a3");
  assertEquals(san(ranks, "a5a3"), "R5a3");
  const both = pos("4k3/8/8/8/8/Q7/8/Q1Q1K3 w - - 0 1");
  assertEquals(san(both, "a1b2"), "Qa1b2");
  assertEquals(san(both, "c1b2"), "Qcb2");
  assertEquals(san(both, "a3b2"), "Q3b2");
  // The knight on e2 is pinned, so Nb5-d4 needs no disambiguation.
  const pinned = pos("4k3/4r3/8/1N6/8/8/4N3/4K3 w - - 0 1");
  assertEquals(san(pinned, "b5d4"), "Nd4");
});

Deno.test("SAN: parsing", () => {
  const p = g.initialPosition();
  assertEquals(parseSan(p, "Nf3"), { from: 6, to: 21 });
  assertEquals(parseSan(p, "e4!?"), { from: 12, to: 28 });
  const promo = pos("r3k3/1P6/8/8/8/8/8/4K3 w - - 0 1");
  assertEquals(parseSan(promo, "bxa8=N"), { from: 49, to: 56, promotion: "n" });
  assertEquals(parseSan(promo, "b8=Q+").promotion, "q");
  assertEquals(parseSan(promo, "b8=Q").promotion, "q");
  for (const bad of ["nf3", "Ng1f3", "e5", "O-O", "", "Nf3++"]) {
    assertThrows(() => parseSan(p, bad), Error, undefined, bad);
  }
  const mated = pos(
    "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3",
  );
  assertThrows(() => parseSan(mated, "Ke2"));
});

Deno.test("SAN: illegal moves throw", () => {
  const p = g.initialPosition();
  assertThrows(() => san(p, "e2e5"), Error, "Illegal move");
  const mated = pos(
    "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3",
  );
  assertThrows(() => san(mated, "e1f2"));
});
