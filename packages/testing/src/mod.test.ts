import { assertEquals, assertThrows } from "@std/assert";
import type { GameRules } from "@boardwright/core";
import { assertGameRulesContract, seededRandom } from "./mod.ts";

// Toy Game: Nim with a pile of 5; take 1 or 2 stones; taking the last wins.
interface P {
  readonly n: number;
  readonly turn: "a" | "b";
}
type Rules = GameRules<P, string>;

const nim: Rules = {
  id: "nim",
  name: "Nim",
  seats: ["a", "b"],
  initialPosition: () => ({ n: 5, turn: "a" }),
  toMove: (p) => (p.n === 0 ? undefined : p.turn),
  legalMoves: (p) => ["t1", "t2"].filter((m) => Number(m[1]) <= p.n),
  play(p, m) {
    if (!nim.legalMoves(p).includes(m)) throw new Error(`illegal ${m}`);
    return { n: p.n - Number(m[1]), turn: p.turn === "a" ? "b" : "a" };
  },
  outcome: (p) =>
    p.n === 0
      ? { winner: p.turn === "a" ? "b" : "a", reason: "last-stone" }
      : undefined,
  notation: {
    encodePosition: (p) => `${p.n}:${p.turn}`,
    decodePosition(text) {
      const m = /^([0-5]):([ab])$/.exec(text);
      if (!m) throw new Error("bad position");
      return { n: Number(m[1]), turn: m[2] as "a" | "b" };
    },
    encodeMove: (m) => m,
    decodeMove(text) {
      if (!/^t[12]$/.test(text)) throw new Error("bad move");
      return text;
    },
  },
};

/** `play` that never rejects: clamps the pile at zero. */
const lenientPlay: Rules["play"] = (p, m) => ({
  n: Math.max(0, p.n - Number(m[1])),
  turn: p.turn === "a" ? "b" : "a",
});

/** Run the kit against a deliberately broken variant and expect `message`. */
function expectFailure(patch: Partial<Rules>, message: string, opts = {}) {
  const broken: Rules = { ...nim, ...patch };
  const err = assertThrows(() => assertGameRulesContract(broken, opts));
  const text = (err as Error).message;
  if (!text.includes(message) || !text.includes("seed=")) {
    throw new Error(`expected "${message}" (with seed) in: ${text}`);
  }
}

Deno.test("passes for a correct game", () => {
  assertGameRulesContract(nim);
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
  expectFailure({ toMove: () => "a" }, "iff outcome");
});

Deno.test("detects terminal positions with legal moves", () => {
  expectFailure(
    { legalMoves: (p) => (p.n === 0 ? ["t1"] : nim.legalMoves(p)) },
    "terminal position has legal moves",
    { checkIllegalMoves: false },
  );
});

Deno.test("detects non-terminal positions without legal moves", () => {
  expectFailure({ legalMoves: () => [] }, "no legal moves");
});

Deno.test("detects mutation in play", () => {
  expectFailure({
    play: (p, m) => {
      const next = nim.play(p, m);
      (p as { n: number }).n = 99;
      return next;
    },
  }, "mutated");
});

Deno.test("detects play that accepts illegal moves", () => {
  expectFailure({
    play: lenientPlay,
  }, "accepted illegal move");
  // Opting out skips the check.
  assertGameRulesContract({
    ...nim,
    play: lenientPlay,
  }, { checkIllegalMoves: false });
});

Deno.test("detects queries that are not stable across calls", () => {
  let c = 0;
  expectFailure({
    toMove: (p) => (p.n === 0 ? undefined : c++ % 2 ? "a" : "b"),
  }, "toMove is not stable");
  expectFailure({
    outcome: (p) =>
      p.n === 0 ? { winner: "a", reason: `r${c++ % 2}` } : undefined,
  }, "outcome is not stable");
  expectFailure({
    legalMoves: (p) => {
      const base = nim.legalMoves(p);
      return c++ % 2 ? base : [...base].reverse();
    },
  }, "legalMoves is not stable");
});

Deno.test("detects non-deterministic replay", () => {
  let calls = 0;
  expectFailure({
    play: (p, m) => {
      const next = nim.play(p, m);
      return calls++ % 2 === 0 ? next : { ...next, turn: p.turn };
    },
  }, "");
});

Deno.test("detects broken position round trip", () => {
  expectFailure({
    notation: { ...nim.notation, decodePosition: () => nim.initialPosition() },
  }, "");
});

Deno.test("detects broken move round trip", () => {
  expectFailure({
    notation: { ...nim.notation, decodeMove: () => "t1" },
  }, "");
});

Deno.test("detects decoders that accept garbage", () => {
  expectFailure({
    notation: { ...nim.notation, decodeMove: (t) => t },
  }, "garbage");
  expectFailure({
    notation: { ...nim.notation, decodePosition: () => nim.initialPosition() },
  }, "garbage");
});

Deno.test("detects non-unique legal move encodings", () => {
  expectFailure({ legalMoves: () => ["t1", "t1"] }, "");
});

Deno.test("detects bad seats and outcomes", () => {
  expectFailure({ seats: [] }, "seats must not be empty");
  expectFailure({ seats: ["a", "a"] }, "unique");
  expectFailure({
    outcome: (p) => {
      const o = nim.outcome(p);
      return o && { ...o, reason: "" };
    },
  }, "reason");
  expectFailure({
    outcome: (p) => {
      const o = nim.outcome(p);
      return o && { winner: "z", reason: "r" };
    },
  }, "winner");
  expectFailure({ toMove: (p) => nim.toMove(p) && "z" }, "not a seat");
});

Deno.test("detects endless playouts", () => {
  expectFailure(
    { play: (p) => p, legalMoves: () => ["t1"] },
    "maxPlies",
    { maxPlies: 5, checkIllegalMoves: false },
  );
});

Deno.test("fails when no playout reaches a terminal position", () => {
  expectFailure({}, "no playout reached", { playouts: 0 });
});

Deno.test("custom garbage is checked", () => {
  expectFailure(
    {
      notation: {
        ...nim.notation,
        decodeMove: (t, p) =>
          t === "magic" ? "t1" : nim.notation.decodeMove(t, p),
      },
    },
    "magic",
    { garbage: ["magic"] },
  );
});

Deno.test("sampled probing still catches lenient play with a capped pool", () => {
  // Walk Game: counter 0..40; legal Moves are `m<k>` and `m<k+1>`. Many
  // distinct Moves overflow the pool, so only a sample is ever probed.
  const walk: GameRules<number, string> = {
    id: "walk",
    name: "Walk",
    seats: ["a"],
    initialPosition: () => 0,
    toMove: (k) => (k >= 40 ? undefined : "a"),
    legalMoves: (k) => (k >= 40 ? [] : [`m${k}`, `m${k + 1}`]),
    play(k, m) {
      if (!walk.legalMoves(k).includes(m)) throw new Error("illegal");
      return Number(m.slice(1)) + 1;
    },
    outcome: (k) => (k >= 40 ? { reason: "done" } : undefined),
    notation: {
      encodePosition: (k) => String(k),
      decodePosition(t) {
        if (!/^\d+$/.test(t)) throw new Error("bad");
        return Number(t);
      },
      encodeMove: (m) => m,
      decodeMove(t) {
        if (!/^m\d+$/.test(t)) throw new Error("bad");
        return t;
      },
    },
  };
  const opts = { illegalPoolSize: 8, illegalSamples: 4, playouts: 20 };
  assertGameRulesContract(walk, opts);
  const err = assertThrows(() =>
    assertGameRulesContract({
      ...walk,
      play: (_k, m) => Number(m.slice(1)) + 1,
    }, opts)
  );
  if (!(err as Error).message.includes("play accepted illegal move")) {
    throw err;
  }
});

Deno.test("isPass: total, boolean, and a pass is the only legal Move", () => {
  // `t1` marked as a pass although `t2` is legal too in most Positions.
  expectFailure({ isPass: (m) => m === "t1" }, "is not the only legal Move");
  expectFailure({
    isPass: () => {
      throw new Error("boom");
    },
  }, "isPass threw");
  expectFailure({ isPass: (() => undefined) as never }, "not total/boolean");
  // A declared pass that never occurs is fine.
  assertGameRulesContract({ ...nim, isPass: () => false });
});

Deno.test("isPass: a pass must hand the turn on", () => {
  // Pile of 1: take-1 is the only legal Move and is marked a pass, but
  // this variant's `play` leaves the Position unchanged for it.
  const stuck: Rules = {
    ...nim,
    initialPosition: () => ({ n: 1, turn: "a" }),
    isPass: (m) => m === "t1",
    play: (p, m) => (m === "t1" ? { ...p } : nim.play(p, m)),
  };
  const err = assertThrows(() => assertGameRulesContract(stuck));
  assertEquals((err as Error).message.includes("hand the turn on"), true);
});

Deno.test("rejects a lossy Notation that drops the Seat to move", () => {
  // Encodes only the pile: a decoded Position forgets whose turn it is.
  expectFailure({
    notation: {
      ...nim.notation,
      encodePosition: (p) => `${p.n}`,
      decodePosition(text) {
        if (!/^[0-5]$/.test(text)) throw new Error("bad position");
        return { n: Number(text), turn: "a" };
      },
    },
  }, "decoded position has a different");
});

Deno.test("rejects a Notation that reorders legal Moves after decoding", () => {
  // The decoded Position lists Moves in reverse order.
  type Q = P & { readonly rev?: boolean };
  const reversing: GameRules<Q, string> = {
    ...nim,
    legalMoves: (p) => {
      const l = nim.legalMoves(p);
      return p.rev ? [...l].reverse() : l;
    },
    notation: {
      ...nim.notation,
      decodePosition: (t) => ({ ...nim.notation.decodePosition(t), rev: true }),
    },
  };
  assertThrows(
    () => assertGameRulesContract(reversing),
    Error,
    "different legalMoves",
  );
});

Deno.test("rejects a Notation whose decoded Position has another Outcome", () => {
  // Decoded Positions forget that the game is over.
  type Q = P & { readonly dec?: boolean };
  const forgetful: GameRules<Q, string> = {
    ...nim,
    outcome: (p) => p.dec ? undefined : nim.outcome(p),
    notation: {
      ...nim.notation,
      decodePosition: (t) => ({ ...nim.notation.decodePosition(t), dec: true }),
    },
  };
  assertThrows(
    () => assertGameRulesContract(forgetful),
    Error,
    "different outcome",
  );
});

// --- Transposition key -------------------------------------------------------

/**
 * Nim with a pile of 6 and a move clock: `plies` counts the Moves played,
 * and the Match is drawn once it reaches 5 (unless the pile is empty). The
 * same pile and Seat to move is reached after different numbers of plies
 * (2+2 or 1+1+1+1 stones), so a key of pile and Seat leaves out history that
 * decides Outcomes, as the contract allows.
 */
interface C {
  readonly n: number;
  readonly turn: "a" | "b";
  readonly plies: number;
  /** Set by `decodePosition` only, to break the key's round trip on purpose. */
  readonly decoded?: boolean;
}
type ClockRules = GameRules<C, string>;

const DRAW_PLIES = 5;
const clockNim: ClockRules = {
  id: "clock-nim",
  name: "Nim with a move clock",
  seats: ["a", "b"],
  initialPosition: () => ({ n: 6, turn: "a", plies: 0 }),
  toMove: (p) => (clockNim.outcome(p) ? undefined : p.turn),
  legalMoves: (p) =>
    clockNim.outcome(p) ? [] : ["t1", "t2"].filter((m) => Number(m[1]) <= p.n),
  play(p, m) {
    if (!clockNim.legalMoves(p).includes(m)) throw new Error(`illegal ${m}`);
    return {
      n: p.n - Number(m[1]),
      turn: p.turn === "a" ? "b" : "a",
      plies: p.plies + 1,
    };
  },
  outcome: (p) =>
    p.n === 0
      ? { winner: p.turn === "a" ? "b" : "a", reason: "last-stone" }
      : p.plies >= DRAW_PLIES
      ? { reason: "move-clock" }
      : undefined,
  notation: {
    encodePosition: (p) => `${p.n}:${p.turn}:${p.plies}`,
    decodePosition(text) {
      const m = /^([0-6]):([ab]):([0-6])$/.exec(text);
      if (!m) throw new Error("bad position");
      return { n: Number(m[1]), turn: m[2] as "a" | "b", plies: Number(m[3]) };
    },
    encodeMove: (m) => m,
    decodeMove(text) {
      if (!/^t[12]$/.test(text)) throw new Error("bad move");
      return text;
    },
  },
  transpositionKey: (p) => `${p.n}${p.turn}`,
};

/** Runs the kit against a variant of `clockNim` and expects `message`. */
function expectKeyFailure(
  patch: Partial<ClockRules>,
  message: string,
  opts = {},
) {
  const err = assertThrows(() =>
    assertGameRulesContract({ ...clockNim, ...patch }, opts)
  );
  const text = (err as Error).message;
  if (!text.includes(message) || !text.includes("seed=")) {
    throw new Error(`expected "${message}" (with seed) in: ${text}`);
  }
}

Deno.test("transpositionKey: a key that leaves out the move clock passes", () => {
  // The key merges Positions with different Outcomes (a draw by the clock
  // and a Position still in play): allowed.
  const playing = { n: 1, turn: "b" as const, plies: 3 };
  const drawn = { n: 1, turn: "b" as const, plies: 5 };
  assertEquals(
    clockNim.transpositionKey!(playing),
    clockNim.transpositionKey!(drawn),
  );
  assertEquals(clockNim.outcome(playing), undefined);
  assertEquals(clockNim.outcome(drawn), { reason: "move-clock" });
  assertGameRulesContract(clockNim);
});

Deno.test("transpositionKey: detects a key that merges Seats to move", () => {
  expectKeyFailure(
    { transpositionKey: (p) => `${p.n}` },
    "which have a different Seat to move",
  );
});

Deno.test("transpositionKey: detects a key that merges different legal Moves", () => {
  // Late in the Match only one stone may be taken: the key must tell.
  // (`play` still takes two: not checked here.)
  expectKeyFailure(
    {
      legalMoves: (p) =>
        clockNim.legalMoves(p).filter((m) => p.plies < 3 || m === "t1"),
    },
    "which have a different legalMoves (set or order)",
    { checkIllegalMoves: false },
  );
});

Deno.test("transpositionKey: detects a key that merges different Move orders", () => {
  // Late in the Match the Game lists its Moves the other way round.
  expectKeyFailure(
    {
      legalMoves: (p) => {
        const moves = clockNim.legalMoves(p);
        return p.plies < 3 ? moves : [...moves].reverse();
      },
    },
    "which have a different legalMoves (set or order)",
  );
});

Deno.test("transpositionKey: detects a key whose Moves lead to different keys", () => {
  // The key merges piles 3 and 4 (and Seat), which list the same Moves but
  // lead to different piles, so it leaves out more than history.
  const merged = (p: C) => `${p.n === 4 ? 3 : p.n}${p.turn}`;
  expectKeyFailure(
    { transpositionKey: merged },
    "leads to different keys",
  );
});

Deno.test("transpositionKey: must be kept by decoding", () => {
  expectKeyFailure(
    {
      notation: {
        ...clockNim.notation,
        decodePosition: (t) => ({
          ...clockNim.notation.decodePosition(t),
          decoded: true,
        }),
      },
      transpositionKey: (p) => `${p.n}${p.turn}${p.decoded ? "*" : ""}`,
    },
    "decoded position has a different transpositionKey",
  );
});

Deno.test("transpositionKey: total, a string, stable", () => {
  expectKeyFailure({
    transpositionKey: () => {
      throw new Error("boom");
    },
  }, "transpositionKey threw");
  expectKeyFailure(
    { transpositionKey: (() => 7) as never },
    "did not return a string",
  );
  let calls = 0;
  expectKeyFailure(
    { transpositionKey: (p) => `${p.n}${p.turn}${calls++ % 2}` },
    "transpositionKey is not stable",
  );
});
