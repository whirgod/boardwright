import { assert, assertEquals } from "@std/assert";
import type { Analysis } from "@boardwright/core";
import type {
  Cell,
  CheckersMove,
  CheckersPosition,
} from "@boardwright/game-checkers";
import { seededRandom } from "@boardwright/testing";
import { engine, evaluate, rules } from "./mod.ts";

const decode = (t: string) => rules.notation.decodePosition(t);

async function search(
  position: string,
  limits: { maxDepth?: number; maxTimeMs?: number; lines?: number },
): Promise<Analysis<CheckersMove>> {
  let last: Analysis<CheckersMove> | undefined;
  for await (const a of engine.analyze(decode(position), limits)) last = a;
  return last!;
}

/** 180-degree rotation with colours swapped and the other Seat to move. */
function mirror(p: CheckersPosition): CheckersPosition {
  const swap: Record<Cell, Cell> = { ".": ".", b: "w", B: "W", w: "b", W: "B" };
  return {
    board: p.board.map((_, i) => swap[p.board[31 - i]!]),
    turn: p.turn === "black" ? "white" : "black",
    clock: 0,
    history: [],
  };
}

Deno.test("belongs to checkers", () => {
  assertEquals(engine.gameId, "checkers");
  assertEquals(rules.id, "checkers");
});

Deno.test("initial Position is level", () => {
  assertEquals(evaluate(rules.initialPosition()), 0);
});

Deno.test("evaluation is symmetric under Seat mirroring along a playout", () => {
  let p = rules.initialPosition();
  for (let ply = 0; ply < 40 && !rules.outcome(p); ply++) {
    assertEquals(evaluate(p), evaluate(mirror(p)));
    const moves = rules.legalMoves(p);
    p = rules.play(p, moves[(ply * 7) % moves.length]!);
  }
});

Deno.test("kings outvalue men; evaluation is from the Seat to move", () => {
  const man = decode("B:W20:B5");
  const king = decode("B:W20:BK5");
  assert(evaluate(king) > evaluate(man));
  // The same Position with white to move is the exact negation.
  assertEquals(evaluate(decode("W:W20:BK5")), -evaluate(king));
});

Deno.test("advanced men are worth more", () => {
  assert(evaluate(decode("B:W29:B21")) > evaluate(decode("B:W29:B5")));
});

const encode = rules.notation.encodeMove;

Deno.test("chooses the double jump over a single jump", async () => {
  // Captures are mandatory, but black picks between 4x11 and 1x10x17.
  const position = decode("B:W6,8,14:B1,4");
  assertEquals(
    rules.legalMoves(position).map(encode).sort(),
    ["1x10x17", "4x11"],
  );
  const a = await search("B:W6,8,14:B1,4", { maxDepth: 1 });
  assertEquals(encode(a.lines[0]!.moves[0]!), "1x10x17");
});

Deno.test("avoids a step that hangs a man", async () => {
  const text = "B:W18:B9,10";
  const p = decode(text);
  const moves = rules.legalMoves(p);
  // A Move is unsafe when the reply can capture.
  const unsafe = moves.filter((m) => {
    const next = rules.play(p, m);
    return rules.legalMoves(next).some((r) => Math.abs(r[0]! - r[1]!) > 5);
  });
  assert(unsafe.length > 0 && unsafe.length < moves.length, "no real choice");
  const a = await search(text, { maxDepth: 2 });
  const picked = encode(a.lines[0]!.moves[0]!);
  assert(!unsafe.map(encode).includes(picked), picked);
});

Deno.test("crowns a man when it can", async () => {
  const a = await search("B:WK1:B26,10", { maxDepth: 1 });
  const move = rules.notation.encodeMove(a.lines[0]!.moves[0]!);
  assert(move === "26-30" || move === "26-31", move);
});

Deno.test("search honours limits and yields legal Lines", async () => {
  const p = rules.initialPosition();
  const all: Analysis<CheckersMove>[] = [];
  for await (const a of engine.analyze(p, { maxDepth: 4, lines: 3 })) {
    all.push(a);
  }
  assertEquals(all.map((a) => a.depth), [1, 2, 3, 4]);
  const legal = rules.legalMoves(p).map(rules.notation.encodeMove);
  const last = all.at(-1)!;
  assertEquals(last.lines.length, 3);
  for (const line of last.lines) {
    assert(legal.includes(rules.notation.encodeMove(line.moves[0]!)));
  }
});

Deno.test("time limit stops an unbounded search", async () => {
  const a = await search("B:W21,22,23,24:B9,10,11,12", { maxTimeMs: 200 });
  assert(a.depth >= 1);
});

Deno.test("terminal Position yields no Lines", async () => {
  const a = await search("W:W:B14", { maxDepth: 2 });
  assertEquals(a.depth, 0);
  assertEquals(a.lines, []);
});

const MATCHES = 6;
const MAX_PLIES = 120;

Deno.test("beats a seeded random mover", async () => {
  const rand = seededRandom(11);
  let wins = 0;
  let losses = 0;
  for (let i = 0; i < MATCHES; i++) {
    const seat = i % 2 === 0 ? "black" : "white";
    let p = rules.initialPosition();
    for (let ply = 0; ply < MAX_PLIES && !rules.outcome(p); ply++) {
      if (p.turn === seat) {
        let last: Analysis<CheckersMove> | undefined;
        for await (const a of engine.analyze(p, { maxDepth: 3 })) last = a;
        p = rules.play(p, last!.lines[0]!.moves[0]!);
      } else {
        const moves = rules.legalMoves(p);
        p = rules.play(p, moves[Math.floor(rand() * moves.length)]!);
      }
    }
    const winner = rules.outcome(p)?.winner;
    if (winner === seat) wins++;
    else if (winner !== undefined) losses++;
  }
  assert(wins >= MATCHES - 1 && losses === 0, `wins ${wins} losses ${losses}`);
});
