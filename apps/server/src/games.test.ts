import { assertEquals, assertThrows } from "@std/assert";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import { GameRegistry } from "./games.ts";

Deno.test("GameRegistry looks Games up by id", () => {
  const registry = new GameRegistry([ticTacToe]);
  assertEquals(registry.get("tic-tac-toe"), ticTacToe);
  assertEquals(registry.get("chess"), undefined);
  assertEquals(registry.list(), [ticTacToe]);
});

Deno.test("GameRegistry rejects duplicate Game ids", () => {
  assertThrows(
    () => new GameRegistry([ticTacToe, ticTacToe]),
    Error,
    "Duplicate Game id",
  );
});
