import { assert, assertEquals } from "@std/assert";
import type { Analysis } from "@boardwright/core";
import type { ChessMove, ChessPosition } from "@boardwright/game-chess";
import { assertEngineContract, seededRandom } from "@boardwright/testing";
import { engine, evaluate, MATERIAL, rules } from "./mod.ts";

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

Deno.test("honours the Engine contract", async () => {
  await assertEngineContract(engine, rules, {
    positions: 3,
    maxDepth: 2,
    terminalPositions: [decode(FOOLS_MATE)],
  });
});
