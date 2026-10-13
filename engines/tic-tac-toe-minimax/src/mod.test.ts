import { assertEquals } from "@std/assert";
import { engine, rules } from "./mod.ts";

async function bestMove(text: string): Promise<string | undefined> {
  const position = rules.notation.decodePosition(text);
  let last;
  for await (const analysis of engine.analyze(position, {})) last = analysis;
  const move = last?.lines[0]?.moves[0];
  return move === undefined ? undefined : rules.notation.encodeMove(move);
}

Deno.test("takes an immediate win", async () => {
  assertEquals(await bestMove("xx.oo....:x"), "c1");
});

Deno.test("blocks an immediate loss", async () => {
  assertEquals(await bestMove("xx.o.....:o"), "c1");
});

Deno.test("belongs to tic-tac-toe", () => {
  assertEquals(engine.gameId, "tic-tac-toe");
  assertEquals(rules.id, "tic-tac-toe");
});
