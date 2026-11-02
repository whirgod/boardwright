import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type { Analysis } from "@boardwright/core";
import type { ChessMove, ChessPosition } from "@boardwright/game-chess";
import { assertEngineContract, seededRandom } from "@boardwright/testing";
import { createMinimaxEngine } from "@boardwright/engine-minimax";
import {
  DELTA_MARGIN,
  engine,
  evaluate,
  gain,
  MATERIAL,
  moveKey,
  movePriority,
  quiescence as quiescenceOptions,
  rules,
  see,
  tactical,
} from "./mod.ts";

const decode = (fen: string) => rules.notation.decodePosition(fen);
const uci = rules.notation.encodeMove;

const FOOLS_MATE =
  "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";

async function searchPosition(
  position: ChessPosition,
  maxDepth: number,
): Promise<Analysis<ChessMove>> {
  let last: Analysis<ChessMove> | undefined;
  for await (const a of engine.analyze(position, { maxDepth })) last = a;
  return last!;
}

const search = (fen: string, maxDepth: number) =>
  searchPosition(decode(fen), maxDepth);

/** The same Position with colours swapped and the other Seat to move. */
function mirror(p: ChessPosition): ChessPosition {
  const swap = (c: string) =>
    c === "." ? c : c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase();
  const ranks: string[][] = [];
  for (let r = 0; r < 8; r++) {
    ranks.push(p.board.slice(r * 8, r * 8 + 8).map(swap));
  }
  return {
    ...p,
    board: ranks.reverse().flat() as ChessPosition["board"],
    turn: p.turn === "white" ? "black" : "white",
  };
}

Deno.test("belongs to chess", () => {
  assertEquals(engine.gameId, "chess");
  assertEquals(rules.id, "chess");
});

Deno.test("initial Position is level", () => {
  assertEquals(evaluate(rules.initialPosition()), 0);
});

Deno.test("evaluation is symmetric under Seat mirroring along a playout", () => {
  let p = rules.initialPosition();
  for (let ply = 0; ply < 60 && !rules.outcome(p); ply++) {
    assertEquals(evaluate(p), evaluate(mirror(p)));
    const moves = rules.legalMoves(p);
    p = rules.play(p, moves[(ply * 7) % moves.length]!);
  }
});

Deno.test("evaluation is from the Seat to move and counts material", () => {
  const white = decode("4k3/8/8/8/8/8/3Q4/4K3 w - - 0 1");
  const black = decode("4k3/8/8/8/8/8/3Q4/4K3 b - - 0 1");
  assert(evaluate(white) > MATERIAL.q! - 100);
  assertEquals(evaluate(black), -evaluate(white));
});

Deno.test("piece-square tables: centre knight beats rim knight", () => {
  const centre = decode("4k3/8/8/3N4/8/8/8/4K3 w - - 0 1");
  const rim = decode("4k3/8/8/8/8/8/8/N3K3 w - - 0 1");
  assert(evaluate(centre) > evaluate(rim));
});

Deno.test("piece-square tables: king hides in the middlegame, centralises in the endgame", () => {
  // Queens on: the castled king (g1) beats the king on e4.
  const castled = decode("r2qk3/8/8/8/8/8/PPP5/R2Q2K1 w - - 0 1");
  const exposed = decode("r2qk3/8/8/8/4K3/8/PPP5/R2Q4 w - - 0 1");
  assert(evaluate(castled) > evaluate(exposed));
  // Bare kings and a rook each: the centre is better than the corner.
  const centre = decode("4k3/8/8/8/4K3/8/8/R7 w - - 0 1");
  const corner = decode("4k3/8/8/8/8/8/8/R6K w - - 0 1");
  assert(evaluate(centre) > evaluate(corner));
});

Deno.test("finds mate in 1", async () => {
  const a = await search("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", 3);
  assertEquals(uci(a.lines[0]!.moves[0]!), "a1a8");
  assertEquals(a.lines[0]!.score, { kind: "win-in", plies: 1 });
});

Deno.test("finds mate in 2: every reply is mated next", async () => {
  const start = decode("7k/8/8/8/8/8/R7/1R4K1 w - - 0 1");
  const a = await searchPosition(start, 3);
  assertEquals(a.lines[0]!.score, { kind: "win-in", plies: 3 });
  const after = rules.play(start, a.lines[0]!.moves[0]!);
  const replies = rules.legalMoves(after);
  assert(replies.length > 0);
  for (const reply of replies) {
    const next = await searchPosition(rules.play(after, reply), 2);
    assertEquals(next.lines[0]!.score, { kind: "win-in", plies: 1 });
  }
});

Deno.test("sees that it is being mated", async () => {
  // Black cannot stop the back-rank mate (Ra8#/Rb8#).
  const a = await search("7k/R7/8/8/8/8/8/1R4K1 b - - 0 1", 2);
  assertEquals(a.lines[0]!.score.kind, "loss-in");
});

Deno.test("wins the queen when it hangs", async () => {
  const fen = "4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1";
  assert(rules.legalMoves(decode(fen)).length > 5);
  const a = await search(fen, 2);
  assertEquals(uci(a.lines[0]!.moves[0]!), "d1d5");
});

Deno.test("forks king and rook with the knight", async () => {
  // Nc7+ wins the rook; many other Moves exist.
  const fen = "r3k3/7p/8/3N4/8/8/8/4K3 w - - 0 1";
  assert(rules.legalMoves(decode(fen)).length > 5);
  const a = await search(fen, 3);
  assertEquals(uci(a.lines[0]!.moves[0]!), "d5c7");
  const { score } = a.lines[0]!;
  assert(score.kind === "value" && score.value > 100);
});

Deno.test("does not hang its queen to a pawn", async () => {
  // d4 and d5? Qd4 loses the queen to ...exd4; other Moves are safe.
  const a = await search("4k3/8/8/4p3/8/8/8/3QK3 w - - 0 1", 2);
  assert(uci(a.lines[0]!.moves[0]!) !== "d1d4");
  const { score } = a.lines[0]!;
  assert(score.kind === "value" && score.value > 700);
});

Deno.test("search honours limits and yields legal Lines", async () => {
  const p = rules.initialPosition();
  const all: Analysis<ChessMove>[] = [];
  for await (const a of engine.analyze(p, { maxDepth: 3, lines: 3 })) {
    all.push(a);
  }
  assertEquals(all.map((a) => a.depth), [1, 2, 3]);
  const legal = rules.legalMoves(p).map(uci);
  const last = all.at(-1)!;
  assertEquals(last.lines.length, 3);
  for (const line of last.lines) assert(legal.includes(uci(line.moves[0]!)));
});

Deno.test("time limit stops an unbounded search", async () => {
  let last: Analysis<ChessMove> | undefined;
  for await (
    const a of engine.analyze(rules.initialPosition(), { maxTimeMs: 200 })
  ) last = a;
  assert(last!.depth >= 1);
});

Deno.test("terminal Position yields no Lines", async () => {
  const a = await search(FOOLS_MATE, 2);
  assertEquals(a.depth, 0);
  assertEquals(a.lines, []);
});

const MATCHES = 4;
const MAX_PLIES = 60;

/** Material (kings excluded) from `seat`'s view. */
function lead(p: ChessPosition, seat: "white" | "black"): number {
  let sum = 0;
  for (const c of p.board) {
    if (c === ".") continue;
    sum += (c < "a") === (seat === "white")
      ? MATERIAL[c.toLowerCase()]!
      : -MATERIAL[c.toLowerCase()]!;
  }
  return sum;
}

Deno.test("beats a seeded random mover", async () => {
  const rand = seededRandom(5);
  for (let i = 0; i < MATCHES; i++) {
    const seat = i % 2 === 0 ? "white" : "black";
    let p = rules.initialPosition();
    for (let ply = 0; ply < MAX_PLIES && !rules.outcome(p); ply++) {
      if (p.turn === seat) {
        const a = await searchPosition(p, 2);
        p = rules.play(p, a.lines[0]!.moves[0]!);
      } else {
        const moves = rules.legalMoves(p);
        p = rules.play(p, moves[Math.floor(rand() * moves.length)]!);
      }
    }
    const winner = rules.outcome(p)?.winner;
    assert(winner === undefined || winner === seat, `match ${i}: lost`);
    // Either mated the random mover or is clearly ahead in material.
    assert(winner === seat || lead(p, seat) >= 500, `match ${i}`);
  }
});

/** Priority of the Move `text` (UCI) in `fen`. */
function priority(fen: string, text: string): number {
  const p = decode(fen);
  const move = rules.legalMoves(p).find((m) => uci(m) === text);
  assert(move, `${text} is not legal in ${fen}`);
  return movePriority(p, move);
}

Deno.test("movePriority: quiet Moves 0, most valuable victim then least valuable attacker", () => {
  const fen = "4k3/8/8/3q3r/4P3/8/8/3QK3 w - - 0 1";
  assertEquals(priority(fen, "e1e2"), 0);
  assertEquals(priority(fen, "e4e5"), 0);
  const pxq = priority(fen, "e4d5");
  const qxq = priority(fen, "d1d5");
  const qxr = priority(fen, "d1h5");
  assert(pxq > qxq, "pawn takes queen beats queen takes queen");
  assert(qxq > qxr, "queen takes queen beats queen takes rook");
  assert(qxr > 0);
});

Deno.test("movePriority: a capture-promotion scores both, castling is quiet", () => {
  const fen = "1n2k3/P7/8/8/8/8/8/R3K2R w KQ - 0 1";
  const capture = priority(fen, "a7b8q");
  assert(capture > priority(fen, "a7a8q"), "capture + promotion wins");
  assert(priority(fen, "a7b8n") > 1, "an under-promotion counts the capture");
  assertEquals(priority(fen, "e1g1"), 0);
  assertEquals(priority(fen, "e1c1"), 0);
});

Deno.test("movePriority: a queen promotion beats any capture", () => {
  const fen = "4k3/P7/8/3q4/4P3/8/8/4K3 w - - 0 1";
  assert(priority(fen, "a7a8q") > priority(fen, "e4d5"));
  assert(priority(fen, "a7a8n") > 0);
  assert(priority(fen, "a7a8q") > priority(fen, "a7a8n"));
});

Deno.test("movePriority: en passant is a capture of a pawn", () => {
  const fen = "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1";
  assert(priority(fen, "e5d6") > 0);
  assertEquals(priority(fen, "e5e6"), 0);
});

Deno.test("the Move priority saves nodes and keeps the Score", async () => {
  // A Notation that never names a Move twice defeats killer Moves, so the
  // plain search has neither hook nor killers.
  let unique = 0;
  const plain = (counted: { n: number }) =>
    createMinimaxEngine({
      rules: {
        ...rules,
        play: (p, m) => (counted.n++, rules.play(p, m)),
        notation: { ...rules.notation, encodeMove: () => String(unique++) },
      },
      evaluate,
      name: "plain",
      tableBytes: 0,
    });
  const ordered = (counted: { n: number }) =>
    createMinimaxEngine({
      rules: {
        ...rules,
        play: (p, m) => (counted.n++, rules.play(p, m)),
      },
      evaluate,
      movePriority,
      name: "ordered",
      tableBytes: 0,
    });
  const fen =
    "r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 7";
  const a = { n: 0 };
  const b = { n: 0 };
  let x: Analysis<ChessMove> | undefined;
  let y: Analysis<ChessMove> | undefined;
  for await (const r of plain(a).analyze(decode(fen), { maxDepth: 3 })) x = r;
  for await (const r of ordered(b).analyze(decode(fen), { maxDepth: 3 })) y = r;
  assertEquals(y!.lines[0]!.score, x!.lines[0]!.score);
  assert(b.n < a.n, `${b.n} vs ${a.n}`);
});

// --- Quiescence search -------------------------------------------------------

/** The Engine without quiescence, and one that may always stand pat. */
const plain = createMinimaxEngine({
  rules,
  evaluate,
  movePriority,
  name: "plain",
});
const standPatInCheck = createMinimaxEngine({
  rules,
  evaluate,
  movePriority,
  quiescence: { standPat: () => true },
  name: "stand pat in check",
});

/** The best Move (UCI) of `e` in `fen` at `maxDepth`, and its Score. */
async function best(
  e: typeof engine,
  fen: string,
  maxDepth: number,
): Promise<[string, Analysis<ChessMove>["lines"][number]]> {
  let last: Analysis<ChessMove> | undefined;
  for await (const a of e.analyze(decode(fen), { maxDepth })) last = a;
  assertEquals(last!.depth, maxDepth);
  return [uci(last!.lines[0]!.moves[0]!), last!.lines[0]!];
}

Deno.test("quiescence: no queen for a defended pawn at the horizon", async () => {
  // Qxd5 wins a pawn at depth 1, but exd5 wins the queen.
  const fen = "4k3/8/4p3/3p4/8/8/8/3QK3 w - - 0 1";
  assertEquals((await best(plain, fen, 1))[0], "d1d5");
  const [move, line] = await best(engine, fen, 1);
  assert(move !== "d1d5", move);
  assert(line.score.kind === "value" && line.score.value > 600);
});

Deno.test("quiescence: sees the recapture of a recapture", async () => {
  // Bxd5 Nxd5 Rxd5 wins a pawn and trades bishop for knight; at depth 2,
  // without quiescence, it ends after Nxd5 and looks like a lost bishop.
  const fen = "6k1/8/5n2/3p4/8/1B6/8/3R2K1 w - - 0 1";
  assert((await best(plain, fen, 2))[0] !== "b3d5");
  const [move, line] = await best(engine, fen, 2);
  assertEquals(move, "b3d5");
  // The Line goes on past the nominal depth with the quiescence Moves.
  assertEquals(line.moves.map(uci), ["b3d5", "f6d5", "d1d5"]);
});

Deno.test("quiescence: no promotion on a guarded square", async () => {
  // b8=Q is taken by the rook at once; the pawn is worth more on b7.
  const fen = "7r/1P6/8/8/8/8/k7/4K3 w - - 0 1";
  assertEquals((await best(plain, fen, 1))[0], "b7b8q");
  const [move] = await best(engine, fen, 1);
  assert(!move.startsWith("b7b8"), move);
});

Deno.test("quiescence: a Seat in check may not stand pat", async () => {
  // Nxc7+ forks king and rook: the king must step aside, then Nxa8. Taking
  // the knight on h5 is worth less. Standing pat in check misses the fork.
  const fen = "r3k3/2p5/1P6/3N3n/8/8/8/6KR w - - 0 1";
  const [move, line] = await best(engine, fen, 1);
  assertEquals(move, "d5c7");
  assertEquals(uci(line.moves[2]!), "c7a8");
  assertEquals((await best(standPatInCheck, fen, 1))[0], "h1h5");
  assertEquals((await best(plain, fen, 1))[0], "h1h5");
});

Deno.test("honours the Engine contract", async () => {
  await assertEngineContract(engine, rules, {
    positions: 3,
    maxDepth: 2,
    terminalPositions: [decode(FOOLS_MATE)],
  });
});

Deno.test("moveKey: distinct for distinct quiet Moves; promotions share one but are tactical", () => {
  const fens = [
    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", // castling both ways
    "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3", // en passant
    "7k/P6P/8/8/8/8/8/K7 w - - 0 1", // promotions
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  ];
  let castled = 0;
  let enPassant = 0;
  let promoted = 0;
  for (const fen of fens) {
    const position = decode(fen);
    const legal = rules.legalMoves(position);
    const quiet = legal.filter((m) => movePriority(position, m) <= 0);
    assertEquals(new Set(quiet.map(moveKey)).size, quiet.length, fen);
    for (const m of legal) {
      if (uci(m) === "e1g1" || uci(m) === "e1c1") castled++;
      if (uci(m) === "e5f6") enPassant++;
      if (m.promotion) {
        promoted++;
        assert(movePriority(position, m) > 0, uci(m));
        // Moves that differ only by the promotion piece share a key.
        const same = legal.filter((o) => o.from === m.from && o.to === m.to);
        assert(same.every((o) => moveKey(o) === moveKey(m)));
      }
    }
  }
  assertEquals(castled, 2);
  assertEquals(enPassant, 1); // tactical: not in `quiet`, never history-sorted
  assert(promoted >= 4);
});

Deno.test("check extension finds a mate by checks just past the nominal depth", async () => {
  // Rd2+ Ke1 Qf2#: three plies, found at depth 2 because the check is extended.
  const fen = "8/7K/8/3R4/5Q2/8/4k3/8 w - - 0 1";
  const plainEngine = createMinimaxEngine({
    rules,
    evaluate,
    movePriority,
    name: "no extension",
  });
  let plain: Analysis<ChessMove> | undefined;
  for await (const a of plainEngine.analyze(decode(fen), { maxDepth: 2 })) {
    plain = a;
  }
  assertEquals(plain!.lines[0]!.score.kind, "value");
  assertNotEquals(plain!.lines[0]!.moves.map(uci)[0], "d5d2");
  const a = await search(fen, 2);
  assertEquals(a.lines[0]!.score, { kind: "win-in", plies: 3 });
  assertEquals(a.lines[0]!.moves.map(uci), ["d5d2", "e2e1", "f4f2"]);
});

// --- Quiescence pruning (#95) ---------------------------------------------

const moveIn = (fen: string, move: string) => {
  const position = decode(fen);
  const m = rules.legalMoves(position).find((x) => uci(x) === move);
  assert(m, `${move} is not legal in ${fen}`);
  return { position, move: m };
};

Deno.test("see: hand-picked exchanges", () => {
  const cases: [string, string, number][] = [
    // A free pawn.
    ["4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1", "e4d5", 100],
    // Pawn takes a pawn that a pawn defends: an even trade.
    ["4k3/8/2p5/3p4/4P3/8/8/4K3 w - - 0 1", "e4d5", 0],
    // Knight takes a pawn that a pawn defends: 100 - 320.
    ["4k3/8/2p5/3p4/8/2N5/8/4K3 w - - 0 1", "c3d5", -220],
    // Queen takes a defended pawn.
    ["4k3/8/2p5/3p4/8/8/8/3QK3 w - - 0 1", "d1d5", -800],
    // Rook takes a knight that a pawn defends: 320 - 500.
    ["4k3/8/2p5/3n4/8/8/8/3RK3 w - - 0 1", "d1d5", -180],
    // A doubled rook (x-ray) wins the pawn a rook defends; the single rook
    // would lose 400.
    ["3r3k/8/8/3p4/8/8/3R4/3RK3 w - - 0 1", "d2d5", 100],
    ["3r3k/8/8/3p4/8/8/8/3RK3 w - - 0 1", "d1d5", 100 - 500],
    // Black to move: a free pawn, and a pawn defended by a pawn.
    ["4k3/8/8/3p4/4P3/8/8/4K3 b - - 0 1", "d5e4", 100],
    ["4k3/8/8/3p4/4P3/3P4/8/4K3 b - - 0 1", "d5e4", 0],
    // The king may not be the last attacker into a defended square: the
    // black king cannot take back on e4 (the pawn d3 defends it).
    ["8/8/8/3k4/4p3/3P4/8/4R1K1 w - - 0 1", "e1e4", 100],
    // A diagonal x-ray: the queen behind the bishop joins; without it the
    // capture loses 230.
    ["4k3/8/8/5n2/3p4/2B5/1Q6/4K3 w - - 0 1", "c3d4", 90],
    ["4k3/8/8/5n2/3p4/2B5/8/4K3 w - - 0 1", "c3d4", -230],
    // A promoting recapture (bxa1=Q) is valued as a pawn's capture: SEE is 0
    // here although the recapture also promotes. Known limitation.
    ["7k/8/8/8/8/8/1p6/r2R2K1 w - - 0 1", "d1a1", 0],
    // En passant: the captured pawn is not on the target square.
    ["4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", "e5d6", 100],
  ];
  for (const [fen, move, expected] of cases) {
    const { position, move: m } = moveIn(fen, move);
    assertEquals(see(position, m), expected, `${fen} ${move}`);
  }
  // A quiet Move captures nothing.
  const { position, move } = moveIn("4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", "e2e4");
  assertEquals(see(position, move), 0);
});

Deno.test("tactical: losing captures and underpromotions are dropped", () => {
  const picked = (fen: string) => {
    const position = decode(fen);
    return rules.legalMoves(position).filter((m) => tactical(position, m))
      .map(uci).sort();
  };
  // Even trade kept; the knight taking a defended pawn and quiet Moves not.
  assertEquals(picked("4k3/8/2p5/3p4/4P3/2N5/8/4K3 w - - 0 1"), ["e4d5"]);
  // Queen promotion only: no rook, bishop or knight promotion.
  assertEquals(picked("8/P6k/8/8/8/8/8/K7 w - - 0 1"), ["a7a8q"]);
  // A cheaper piece takes a more valuable one: kept even if defended.
  assertEquals(picked("4k3/8/2p5/3q4/4P3/8/8/4K3 w - - 0 1"), ["e4d5"]);
  // En passant is a capture.
  assertEquals(picked("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1"), ["e5d6"]);
});

Deno.test("gain bounds what the Move wins", () => {
  const g = (fen: string, move: string) => {
    const { position, move: m } = moveIn(fen, move);
    return gain(position, m);
  };
  const m = DELTA_MARGIN;
  assertEquals(g("4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1", "e4d5"), 100 + m);
  assertEquals(g("4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1", "e4d5"), 900 + m);
  assertEquals(g("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", "e5d6"), 100 + m);
  assertEquals(g("8/P6k/8/8/8/8/8/K7 w - - 0 1", "a7a8q"), 800 + m);
});

Deno.test("a Seat in check does not stand pat (so every Move is searched), a quiet one does", () => {
  const position = decode("4k3/8/5N2/8/8/8/8/4K3 b - - 0 1");
  assert(!quiescenceOptions.standPat(position));
  assert(quiescenceOptions.standPat(decode("4k3/8/8/8/8/8/8/4K3 b - - 0 1")));
});

Deno.test("the quiescence prunings cost fewer nodes and keep the best Move in a tactical Position", async () => {
  const fen =
    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";
  const nodes = async (quiescence: typeof quiescenceOptions) => {
    let n = 0;
    const e = createMinimaxEngine({
      rules: { ...rules, play: (p, m) => (n++, rules.play(p, m)) },
      evaluate,
      movePriority,
      quiescence,
      name: "q",
    });
    let last: Analysis<ChessMove> | undefined;
    for await (const a of e.analyze(decode(fen), { maxDepth: 3 })) last = a;
    return { n, best: last!.lines[0]!.moves.map(uci)[0] };
  };
  const full = await nodes({ standPat: quiescenceOptions.standPat });
  const pruned = await nodes(quiescenceOptions);
  assert(pruned.n < full.n, `${pruned.n} >= ${full.n}`);
  assertEquals(pruned.best, full.best);
});
