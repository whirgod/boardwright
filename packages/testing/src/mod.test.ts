import { assertEquals, assertThrows } from "@std/assert";
import type { GameRules } from "@boardwright/core";
import { ticTacToe } from "../../../games/tic-tac-toe/src/mod.ts";
import { assertGameRulesContract, seededRandom } from "./mod.ts";

type P = Parameters<typeof ticTacToe.toMove>[0];
type M = string;
type Rules = GameRules<P, M>;

/** Run the kit against a deliberately broken variant and expect `message`. */
function expectFailure(patch: Partial<Rules>, message: string, opts = {}) {
  const broken: Rules = { ...ticTacToe, ...patch };
  const err = assertThrows(() => assertGameRulesContract(broken, opts));
  const text = (err as Error).message;
  if (!text.includes(message) || !text.includes("seed=")) {
    throw new Error(`expected "${message}" (with seed) in: ${text}`);
  }
}

Deno.test("passes for a correct game", () => {
  assertGameRulesContract(ticTacToe);
});

Deno.test("seededRandom is deterministic and in [0, 1)", () => {
  const a = seededRandom(7);
  const b = seededRandom(7);
  const xs = Array.from({ length: 50 }, a);
  assertEquals(xs, Array.from({ length: 50 }, b));
  for (const x of xs) if (x < 0 || x >= 1) throw new Error("out of range");
  assertEquals(seededRandom(8)() === xs[0], false);
});

Deno.test("detects toMove/outcome inconsistency", () => {
  expectFailure({ toMove: () => "x" }, "iff outcome");
});

Deno.test("detects terminal positions with legal moves", () => {
  expectFailure(
    {
      legalMoves: (p) =>
        ticTacToe.outcome(p) ? ["a1"] : ticTacToe.legalMoves(p),
    },
    "terminal position has legal moves",
  );
});

Deno.test("detects non-terminal positions without legal moves", () => {
  expectFailure({ legalMoves: () => [] }, "no legal moves");
});

Deno.test("detects mutation in play", () => {
  expectFailure({
    play: (p, m) => {
      const next = ticTacToe.play(p, m);
      (p.cells as string[])[0] = "o";
      return next;
    },
  }, "mutated");
});

Deno.test("detects non-deterministic play", () => {
  let calls = 0;
  expectFailure({
    play: (p, m) => {
      const next = ticTacToe.play(p, m);
      return calls++ % 2 === 0 ? next : { ...next, turn: p.turn };
    },
  }, "");
});

Deno.test("detects broken position round trip", () => {
  expectFailure({
    notation: {
      ...ticTacToe.notation,
      encodePosition: (p) => ticTacToe.notation.encodePosition(p),
      decodePosition: () => ticTacToe.initialPosition(),
    },
  }, "");
});

Deno.test("detects broken move round trip", () => {
  expectFailure({
    notation: {
      ...ticTacToe.notation,
      decodeMove: () => "a1",
    },
  }, "");
});

Deno.test("detects decoders that accept garbage", () => {
  expectFailure({
    notation: { ...ticTacToe.notation, decodeMove: (t) => t },
  }, "garbage");
  expectFailure({
    notation: {
      ...ticTacToe.notation,
      decodePosition: () => ticTacToe.initialPosition(),
    },
  }, "garbage");
});

Deno.test("detects non-unique legal move encodings", () => {
  expectFailure({ legalMoves: () => ["a1", "a1"] }, "");
});

Deno.test("detects bad seats and outcomes", () => {
  expectFailure({ seats: [] }, "seats must not be empty");
  expectFailure({ seats: ["x", "x"] }, "unique");
  expectFailure({
    outcome: (p) => {
      const o = ticTacToe.outcome(p);
      return o && { ...o, reason: "" };
    },
  }, "reason");
  expectFailure({
    outcome: (p) => {
      const o = ticTacToe.outcome(p);
      return o && { winner: "z", reason: "r" };
    },
  }, "winner");
  expectFailure({ toMove: (p) => ticTacToe.toMove(p) && "z" }, "not a seat");
});

Deno.test("detects endless playouts", () => {
  expectFailure(
    { outcome: () => undefined, toMove: () => "x" },
    "maxPlies",
    { maxPlies: 5 },
  );
});

Deno.test("detects playouts that never terminate normally", () => {
  expectFailure(
    {
      legalMoves: () => ["a1"],
      play: (p) => p,
      outcome: () => undefined,
      toMove: () => "x",
    },
    "maxPlies",
    { playouts: 1 },
  );
  expectFailure({}, "no playout reached", { playouts: 0 });
});

Deno.test("custom garbage is checked", () => {
  expectFailure(
    {
      notation: {
        ...ticTacToe.notation,
        decodeMove: (t, p) =>
          t === "magic" ? "a1" : ticTacToe.notation.decodeMove(t, p),
      },
    },
    "magic",
    { garbage: ["magic"] },
  );
});
