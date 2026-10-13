import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import type { GameRules } from "@boardwright/core";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import { GameMaster, MatchError, type MatchErrorCode } from "./game-master.ts";
import { type AnyGameRules, GameRegistry } from "./games.ts";
import {
  InMemoryMatchStore,
  type MatchRecord,
  type MatchStore,
} from "./match-store.ts";
import { hashToken } from "./tokens.ts";

const HUMANS = { x: { kind: "human" }, o: { kind: "human" } } as const;

function setup(
  options: { store?: MatchStore; games?: AnyGameRules[] } = {},
) {
  const store = options.store ?? new InMemoryMatchStore();
  let tick = 0;
  let ids = 0;
  const master = new GameMaster({
    games: new GameRegistry(options.games ?? [ticTacToe as AnyGameRules]),
    store,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    newMatchId: () => `m${++ids}`,
  });
  return { master, store };
}

async function newMatch(master: GameMaster) {
  const { match, tokens } = await master.createMatch("tic-tac-toe", HUMANS);
  return { id: match.id, x: tokens.x!, o: tokens.o! };
}

/** Plays alternating Moves, x first, with the right tokens. */
async function playAll(master: GameMaster, ...moves: string[]) {
  const m = await newMatch(master);
  for (const [i, move] of moves.entries()) {
    await master.playMove(m.id, move, i % 2 === 0 ? m.x : m.o);
  }
  return { ...m, view: await master.getMatch(m.id) };
}

async function assertMatchError(
  fn: () => Promise<unknown>,
  code: MatchErrorCode,
): Promise<void> {
  const error = await assertRejects(fn, MatchError);
  assertEquals(error.code, code, error.message);
}

Deno.test("createMatch returns the initial Match and one token per Seat", async () => {
  const { master } = setup();
  const { match, tokens } = await master.createMatch("tic-tac-toe", HUMANS);
  assertEquals(match, {
    id: "m1",
    gameId: "tic-tac-toe",
    seats: { x: { kind: "human" }, o: { kind: "human" } },
    moves: [],
    position: ".........:x",
    toMove: "x",
    legalMoves: ["a1", "b1", "c1", "a2", "b2", "c2", "a3", "b3", "c3"],
    outcome: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(Object.keys(tokens), ["x", "o"]);
  assertMatch(tokens.x!, /^[0-9a-f]{64}$/);
  assertMatch(tokens.o!, /^[0-9a-f]{64}$/);
  assertNotEquals(tokens.x, tokens.o);
});

Deno.test("createMatch stores only token hashes", async () => {
  const { master, store } = setup();
  const { match, tokens } = await master.createMatch("tic-tac-toe", HUMANS);
  const record = await store.get(match.id);
  assertEquals(record?.seats.x, {
    player: { kind: "human" },
    tokenHash: await hashToken(tokens.x!),
  });
  assert(!JSON.stringify(record).includes(tokens.x!));
});

Deno.test("createMatch rejects an unknown Game", async () => {
  const { master } = setup();
  await assertMatchError(
    () => master.createMatch("chess", HUMANS),
    "unknown-game",
  );
});

Deno.test("createMatch requires exactly the Game's Seats", async () => {
  const { master } = setup();
  await assertMatchError(
    () => master.createMatch("tic-tac-toe", { x: { kind: "human" } }),
    "invalid-seats",
  );
  await assertMatchError(
    () =>
      master.createMatch("tic-tac-toe", { ...HUMANS, z: { kind: "human" } }),
    "invalid-seats",
  );
  const error = await assertRejects(
    () =>
      master.createMatch("tic-tac-toe", {
        x: { kind: "human" },
        white: { kind: "human" },
      }),
    MatchError,
  );
  assertEquals(
    error.message,
    "missing Seat(s): o; unknown Seat(s): white (tic-tac-toe has Seats x, o)",
  );
});

Deno.test("x wins a full Match by three in a row", async () => {
  const { master, store } = setup();
  const { id, view } = await playAll(master, "a1", "a2", "b1", "b2", "c1");
  assertEquals(view.moves, ["a1", "a2", "b1", "b2", "c1"]);
  assertEquals(view.position, "xxxoo....:o");
  assertEquals(view.outcome, { winner: "x", reason: "three-in-a-row" });
  assertEquals(view.toMove, null);
  assertEquals(view.legalMoves, []);
  assertEquals((await store.get(id))?.outcome, view.outcome);
});

Deno.test("o wins a full Match", async () => {
  const { master } = setup();
  const { view } = await playAll(master, "a1", "a2", "b1", "b2", "a3", "c2");
  assertEquals(view.outcome, { winner: "o", reason: "three-in-a-row" });
});

Deno.test("a full board without a line is a draw", async () => {
  const { master } = setup();
  const { view } = await playAll(
    master,
    "a1",
    "b1",
    "c1",
    "b2",
    "a2",
    "c2",
    "b3",
    "a3",
    "c3",
  );
  assertEquals(view.outcome, { reason: "board-full" });
  assertEquals(view.toMove, null);
});

Deno.test("playMove returns the updated Match", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  const view = await master.playMove(m.id, "b2", m.x);
  assertEquals(view.moves, ["b2"]);
  assertEquals(view.position, "....x....:o");
  assertEquals(view.toMove, "o");
  assertEquals(view.legalMoves.length, 8);
  assertEquals(view.updatedAt, "2026-01-01T00:00:01.000Z");
  assertEquals(await master.getMatch(m.id), view);
});

Deno.test("turn order: only the Seat to move may play", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  await assertMatchError(
    () => master.playMove(m.id, "a1", m.o),
    "not-your-turn",
  );
  await master.playMove(m.id, "a1", m.x);
  await assertMatchError(
    () => master.playMove(m.id, "b1", m.x),
    "not-your-turn",
  );
  await master.playMove(m.id, "b1", m.o);
  assertEquals((await master.getMatch(m.id)).moves, ["a1", "b1"]);
});

Deno.test("illegal and undecodable Moves are refused without changing the Match", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  await master.playMove(m.id, "a1", m.x);
  await assertMatchError(
    () => master.playMove(m.id, "a1", m.o),
    "illegal-move",
  );
  await assertMatchError(
    () => master.playMove(m.id, "z9", m.o),
    "invalid-move",
  );
  await assertMatchError(() => master.playMove(m.id, "", m.o), "invalid-move");
  assertEquals((await master.getMatch(m.id)).moves, ["a1"]);
});

Deno.test("a wrong or empty seat token is refused", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  const other = await newMatch(master);
  await assertMatchError(
    () => master.playMove(m.id, "a1", "nope"),
    "invalid-token",
  );
  await assertMatchError(
    () => master.playMove(m.id, "a1", ""),
    "invalid-token",
  );
  await assertMatchError(
    () => master.playMove(m.id, "a1", other.x),
    "invalid-token",
  );
});

Deno.test("a finished Match accepts no more Moves", async () => {
  const { master } = setup();
  const { id, o } = await playAll(master, "a1", "a2", "b1", "b2", "c1");
  await assertMatchError(() => master.playMove(id, "c3", o), "match-finished");
});

Deno.test("unknown Match ids are reported", async () => {
  const { master } = setup();
  await assertMatchError(() => master.getMatch("nope"), "unknown-match");
  await assertMatchError(
    () => master.playMove("nope", "a1", "t"),
    "unknown-match",
  );
  await assertMatchError(
    () => master.playAs("nope", "x", "a1"),
    "unknown-match",
  );
});

Deno.test("playAs plays for a Seat without a token, with the same referee checks", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  await assertMatchError(() => master.playAs(m.id, "o", "a1"), "not-your-turn");
  const view = await master.playAs(m.id, "x", "a1");
  assertEquals(view.moves, ["a1"]);
  await assertMatchError(() => master.playAs(m.id, "o", "a1"), "illegal-move");
});

Deno.test("concurrent Moves for the same turn: exactly one wins", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  const results = await Promise.allSettled([
    master.playMove(m.id, "a1", m.x),
    master.playMove(m.id, "b1", m.x),
  ]);
  assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert(rejected?.reason instanceof MatchError);
  assert(["conflict", "not-your-turn"].includes(rejected.reason.code));
  assertEquals((await master.getMatch(m.id)).moves.length, 1);
});

Deno.test("a lost store update is reported as a conflict", async () => {
  const inner = new InMemoryMatchStore();
  const store: MatchStore = {
    create: (r) => inner.create(r),
    get: (id) => inner.get(id),
    update: () => Promise.resolve(false),
  };
  const { master } = setup({ store });
  const m = await newMatch(master);
  await assertMatchError(() => master.playMove(m.id, "a1", m.x), "conflict");
});

Deno.test("a stored Match of an unregistered Game is an internal error", async () => {
  const { master, store } = setup();
  const record: MatchRecord = {
    id: "orphan",
    gameId: "gone",
    seats: {},
    moves: [],
    version: 1,
    createdAt: "",
    updatedAt: "",
  };
  await store.create(record);
  const error = await assertRejects(() => master.getMatch("orphan"));
  assert(!(error instanceof MatchError));
});

// A Game whose Moves are objects, to check the referee compares Moves in
// Notation rather than by identity. Counting: add 1 or 2 until 4; always a draw.
type CountMove = { readonly add: number };
const counting: GameRules<number, CountMove> = {
  id: "counting",
  name: "Counting",
  seats: ["a", "b"],
  initialPosition: () => 0,
  toMove: (p) => (p >= 4 ? undefined : p % 2 === 0 ? "a" : "b"),
  legalMoves: (p) => (p >= 4 ? [] : [{ add: 1 }, { add: 2 }]),
  play(p, m) {
    // Deliberately inconsistent with legalMoves to exercise the referee's guard.
    if (p === 1 && m.add === 2) throw new Error("no jumping from 1");
    return p + m.add;
  },
  outcome: (p) => (p >= 4 ? { reason: "reached-four" } : undefined),
  notation: {
    encodePosition: String,
    decodePosition: Number,
    encodeMove: (m) => `+${m.add}`,
    decodeMove(text) {
      const m = /^\+?([1-9])$/.exec(text);
      if (!m) throw new Error("bad move");
      return { add: Number(m[1]) };
    },
  },
};

Deno.test("Moves are compared and stored in canonical Notation", async () => {
  const { master } = setup({ games: [counting as AnyGameRules] });
  const { match, tokens } = await master.createMatch("counting", {
    a: { kind: "human" },
    b: { kind: "human" },
  });
  await assertMatchError(
    () => master.playMove(match.id, "3", tokens.a!),
    "illegal-move",
  );
  const view = await master.playMove(match.id, "1", tokens.a!);
  assertEquals(view.moves, ["+1"]);
  assertEquals(view.legalMoves, ["+1", "+2"]);
  await assertMatchError(
    () => master.playMove(match.id, "+2", tokens.b!),
    "illegal-move",
  );
  await master.playMove(match.id, "+1", tokens.b!);
  await master.playMove(match.id, "+2", tokens.a!);
  const done = await master.getMatch(match.id);
  assertEquals(done.position, "4");
  assertEquals(done.outcome, { reason: "reached-four" });
});
