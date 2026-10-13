// Perft (leaf node counts of the legal Move tree) against reference values.
//
// Source: Chess Programming Wiki, "Perft Results"
// https://www.chessprogramming.org/Perft_Results (positions "Initial
// Position" and "Position 2" (Kiwipete) to "Position 6"). The page omits the
// clocks of Kiwipete; they are added here as "0 1".
//
// The default run keeps the suite fast; deeper counts run with
// `deno task --cwd games/chess perft:deep` (sets CHESS_PERFT_DEEP=1).
import { assertEquals, assertThrows } from "@std/assert";
import { chess, type ChessPosition, perft } from "./mod.ts";

interface Case {
  readonly name: string;
  readonly fen: string;
  /** Node counts for depth 1, 2, ... */
  readonly nodes: readonly number[];
  /** Depths up to this one run by default; the rest only when deep. */
  readonly fastDepth: number;
}

const CASES: readonly Case[] = [
  {
    name: "initial position",
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    nodes: [20, 400, 8_902, 197_281, 4_865_609, 119_060_324],
    fastDepth: 4,
  },
  {
    name: "position 2 (Kiwipete)",
    fen: "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    nodes: [48, 2_039, 97_862, 4_085_603, 193_690_690],
    fastDepth: 3,
  },
  {
    name: "position 3",
    fen: "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
    nodes: [14, 191, 2_812, 43_238, 674_624, 11_030_083],
    fastDepth: 5,
  },
  {
    name: "position 4",
    fen: "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
    nodes: [6, 264, 9_467, 422_333, 15_833_292],
    fastDepth: 4,
  },
  {
    name: "position 4 (mirrored)",
    fen: "r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1",
    nodes: [6, 264, 9_467, 422_333, 15_833_292],
    fastDepth: 4,
  },
  {
    name: "position 5",
    fen: "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
    nodes: [44, 1_486, 62_379, 2_103_487, 89_941_194],
    fastDepth: 3,
  },
  {
    name: "position 6",
    fen:
      "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
    nodes: [46, 2_079, 89_890, 3_894_594, 164_075_551],
    fastDepth: 3,
  },
];

const deep = Deno.permissions.querySync({
      name: "env",
      variable: "CHESS_PERFT_DEEP",
    }).state === "granted" && Deno.env.get("CHESS_PERFT_DEEP") === "1";

for (const c of CASES) {
  const position = chess.notation.decodePosition(c.fen);
  c.nodes.forEach((expected, i) => {
    const depth = i + 1;
    Deno.test({
      name: `perft ${c.name} depth ${depth}`,
      ignore: depth > c.fastDepth && !deep,
      fn: () => assertEquals(perft(position, depth), expected),
    });
  });
}

/** Perft through the public, immutable `GameRules` API. */
function publicPerft(p: ChessPosition, depth: number): number {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of chess.legalMoves(p)) {
    n += publicPerft(chess.play(p, m), depth - 1);
  }
  return n;
}

Deno.test("perft through legalMoves/play agrees with the reference", () => {
  for (const c of CASES) {
    const depth = c.nodes[2]! < 20_000 ? 3 : 2;
    assertEquals(
      publicPerft(chess.notation.decodePosition(c.fen), depth),
      c.nodes[depth - 1],
      c.name,
    );
  }
});

Deno.test("perft depth 0 is 1 and invalid depths throw", () => {
  const p = chess.initialPosition();
  assertEquals(perft(p, 0), 1);
  assertThrows(() => perft(p, -1), RangeError);
  assertThrows(() => perft(p, 1.5), RangeError);
});
