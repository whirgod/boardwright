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
  // A given check suffix must be right.
  for (const bad of ["nf3", "Ng1f3", "e5", "O-O", "", "Nf3++", "Nf3+", "e4#"]) {
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

Deno.test("SAN: check suffixes on castling, en passant and promotion", () => {
  assertEquals(san(pos("5k2/8/8/8/8/8/8/4K2R w K - 0 1"), "e1g1"), "O-O+");
  assertEquals(
    san(pos("4k3/8/8/8/3pP3/8/5K2/8 b - e3 0 1"), "d4e3"),
    "dxe3+",
  );
  const mate = pos("k7/4P3/1K6/8/8/8/8/8 w - - 0 1");
  assertEquals(san(mate, "e7e8q"), "e8=Q#");
  assertEquals(san(mate, "e7e8r"), "e8=R#");
  assertEquals(san(mate, "e7e8b"), "e8=B");
  assertEquals(parseSan(mate, "e8=Q#"), { from: 52, to: 60, promotion: "q" });
  // The rook on e2 is pinned along the file: it may still move on the file
  // (so e5 needs disambiguation), but not to d2 (so d2 does not).
  const pinned = pos("4r1k1/8/8/3R4/8/8/4R3/4K3 w - - 0 1");
  assertEquals(san(pinned, "d5d2"), "Rd2");
  assertEquals(san(pinned, "e2e5"), "Ree5");
  assertEquals(san(pinned, "d5e5"), "Rde5");
});

const SAN_FENS = [
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
  "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
  "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
  "r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1",
  "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
  "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
  "4k3/8/8/8/8/Q7/8/Q1Q1K3 w - - 0 1",
];

Deno.test("SAN: format/parse round trip over the perft trees (depth 2)", () => {
  let checked = 0;
  const visit = (p: ChessPosition, depth: number) => {
    const legal = g.legalMoves(p);
    const texts = legal.map((m) => formatSan(p, m));
    assertEquals(new Set(texts).size, texts.length, n.encodePosition(p));
    legal.forEach((m, i) => {
      assertEquals(parseSan(p, texts[i]!), m, texts[i]);
      checked++;
      if (depth > 1) visit(g.play(p, m), depth - 1);
    });
  };
  for (const text of SAN_FENS) visit(pos(text), 2);
  assertEquals(checked > 6_000, true, `${checked}`);
});
