import { assert, assertEquals } from "@std/assert";
import type { Analysis } from "@boardwright/core";
import type {
  Cell,
  CheckersMove,
  CheckersPosition,
} from "@boardwright/game-checkers";
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

Deno.test("finds a winning capture", async () => {
  const a = await search("B:W18:B14", { maxDepth: 2 });
  assertEquals(a.lines[0]!.score, { kind: "win-in", plies: 1 });
  assertEquals(rules.notation.encodeMove(a.lines[0]!.moves[0]!), "14x23");
});

Deno.test("takes the double jump", async () => {
  const a = await search("B:W6,15:B1", { maxDepth: 3 });
  assertEquals(rules.notation.encodeMove(a.lines[0]!.moves[0]!), "1x10x19");
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
