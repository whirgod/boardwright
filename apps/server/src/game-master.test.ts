import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import type { GameRules } from "@boardwright/core";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import {
  GameMaster,
  MatchError,
  type MatchErrorCode,
  type MatchView,
} from "./game-master.ts";
import { EngineRegistry } from "./engines.ts";
import { type AnyGameRules, GameRegistry } from "./games.ts";
import {
  InMemoryMatchStore,
  type MatchRecord,
  type MatchStore,
} from "./match-store.ts";
import { hashToken } from "./tokens.ts";
import type { PlayerSpec } from "./players.ts";

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

Deno.test("client text is quoted and capped in error messages", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  const long = "q".repeat(10_000);
  for (
    const fn of [
      () => master.playMove(m.id, long, m.x),
      () => master.getMatch(long),
      () => master.createMatch(long, HUMANS),
    ]
  ) {
    const error = await assertRejects(fn, MatchError);
    assert(error.message.length < 400, error.message);
  }
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

// No server-driven Player kind exists yet (Engines come in #7), so these tests
// store a record whose Seats are a stand-in kind that holds no token.
const SERVER_DRIVEN = { kind: "engine" } as unknown as PlayerSpec;

async function storeServerDrivenMatch(
  store: MatchStore,
  overrides: Partial<MatchRecord> = {},
): Promise<string> {
  await store.create({
    id: "auto",
    gameId: "tic-tac-toe",
    seats: { x: { player: SERVER_DRIVEN }, o: { player: SERVER_DRIVEN } },
    moves: [],
    version: 1,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  });
  return "auto";
}

Deno.test("playAs plays for a server-driven Seat, with the same referee checks", async () => {
  const { master, store } = setup();
  const id = await storeServerDrivenMatch(store);
  await assertMatchError(() => master.playAs(id, "o", "a1"), "not-your-turn");
  const view = await master.playAs(id, "x", "a1");
  assertEquals(view.moves, ["a1"]);
  await assertMatchError(() => master.playAs(id, "o", "a1"), "illegal-move");
  await assertMatchError(() => master.playAs(id, "o", "zz"), "invalid-move");
});

Deno.test("playAs refuses token-holding and unknown Seats", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  await assertMatchError(
    () => master.playAs(m.id, "x", "a1"),
    "not-server-driven",
  );
  await assertMatchError(
    () => master.playAs(m.id, "z", "a1"),
    "not-server-driven",
  );
  await assertMatchError(
    () => master.playAs(m.id, "__proto__", "a1"),
    "not-server-driven",
  );
  assertEquals((await master.getMatch(m.id)).moves, []);
});

Deno.test("a stored Outcome ends the Match even if the Position does not", async () => {
  const { master, store } = setup();
  const id = await storeServerDrivenMatch(store, {
    moves: ["a1"],
    outcome: { winner: "x", reason: "forfeit" },
  });
  const view = await master.getMatch(id);
  assertEquals(view.position, "x........:o");
  assertEquals(view.toMove, null);
  assertEquals(view.legalMoves, []);
  assertEquals(view.outcome, { winner: "x", reason: "forfeit" });
  await assertMatchError(() => master.playAs(id, "o", "b1"), "match-finished");
});

Deno.test("onMatchChanged fires after create and each accepted Move", async () => {
  const { master } = setup();
  const seen: string[] = [];
  const stop = master.onMatchChanged((m) => {
    seen.push(`${m.id}:${m.moves.join(",")}`);
  });
  master.onMatchChanged(() => {
    throw new Error("listener bug");
  });
  const originalError = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const m = await newMatch(master);
    await master.playMove(m.id, "a1", m.x);
    await assertMatchError(
      () => master.playMove(m.id, "a1", m.o),
      "illegal-move",
    );
    await master.playMove(m.id, "b1", m.o);
    stop();
    await master.playMove(m.id, "c1", m.x);
    assertEquals(seen, ["m1:", "m1:a1", "m1:a1,b1"]);
    assertEquals(logged.length, 4);
  } finally {
    console.error = originalError;
  }
});

Deno.test("async listener rejections are logged, not unhandled", async () => {
  const { master } = setup();
  let calls = 0;
  master.onMatchChanged(async () => {
    calls++;
    await Promise.resolve();
    throw new Error("async listener bug");
  });
  const originalError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const m = await newMatch(master);
    await master.playMove(m.id, "a1", m.x);
    // Let the rejected listener promises settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(calls, 2);
    assertEquals(logged.length, 2);
    assert(String(logged[0]![1]).includes("async listener bug"));
  } finally {
    console.error = originalError;
  }
});

Deno.test("listeners get a frozen copy, not the returned Match", async () => {
  const { master } = setup();
  const received: MatchView[] = [];
  master.onMatchChanged((m) => {
    received.push(m);
  });
  const m = await newMatch(master);
  const view = await master.playMove(m.id, "a1", m.x);
  const copy = received[1]!;
  assertEquals(copy, view);
  assert(copy !== view && copy.moves !== view.moves);
  assert(Object.isFrozen(copy) && Object.isFrozen(copy.moves));
  assert(Object.isFrozen(copy.seats.x));
  // The returned Match and the stored one are unaffected by listeners.
  (view.moves as string[]).push("tampered");
  assertEquals(copy.moves, ["a1"]);
  assertEquals((await master.getMatch(m.id)).moves, ["a1"]);
});

Deno.test("games exposes the registry", () => {
  const { master } = setup();
  assertEquals(master.games.get("tic-tac-toe"), ticTacToe);
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
  // legalMoves lists +2 but play refuses it: a Game bug, not a client error.
  const bug = await assertRejects(() =>
    master.playMove(match.id, "+2", tokens.b!)
  );
  assert(!(bug instanceof MatchError));
  assertEquals((await master.getMatch(match.id)).moves, ["+1"]);
  await master.playMove(match.id, "+1", tokens.b!);
  await master.playMove(match.id, "+2", tokens.a!);
  const done = await master.getMatch(match.id);
  assertEquals(done.position, "4");
  assertEquals(done.outcome, { reason: "reached-four" });
});

const ENGINE_REGISTRY = new EngineRegistry([
  { id: "e", name: "E", gameId: "tic-tac-toe", module: "file:///unused.ts" },
]);
const engineSeat: PlayerSpec = { kind: "engine", engineId: "e", limits: {} };

function setupWithEngines() {
  return new GameMaster({
    games: new GameRegistry([ticTacToe as AnyGameRules]),
    store: new InMemoryMatchStore(),
    engines: ENGINE_REGISTRY,
  });
}

Deno.test("createMatch refuses an Engine the Game does not have", async () => {
  const error = await assertRejects(
    () =>
      setupWithEngines().createMatch("tic-tac-toe", {
        x: { kind: "human" },
        o: { kind: "engine", engineId: "nope", limits: {} },
      }),
    MatchError,
  );
  assertEquals(error.code, "invalid-seats");
  assertMatch(error.message, /no Engine "nope"/);
  // No Engines registered at all (the default).
  await assertRejects(
    () =>
      setup().master.createMatch("tic-tac-toe", { x: HUMANS.x, o: engineSeat }),
    MatchError,
  );
});

Deno.test("an Engine Seat gets no token and forfeit ends the Match", async () => {
  const master = setupWithEngines();
  const seen: MatchView[] = [];
  master.onMatchChanged((m) => void seen.push(m));
  const { match, tokens } = await master.createMatch("tic-tac-toe", {
    x: { kind: "human" },
    o: engineSeat,
  });
  assertEquals(Object.keys(tokens), ["x"]);
  assertEquals(match.seats.o, engineSeat);

  // Not o's turn yet: a stale forfeit is refused.
  const early = await assertRejects(
    () => master.forfeit(match.id, "o", "too early"),
    MatchError,
  );
  assertEquals(early.code, "not-your-turn");
  await master.playMove(match.id, "a1", tokens.x!);
  const forfeited = await master.forfeit(match.id, "o", "engine-failure: test");
  assertEquals(forfeited.outcome, {
    winner: "x",
    reason: "engine-failure: test",
  });
  assertEquals(forfeited.toMove, null);
  assertEquals(forfeited.legalMoves, []);
  assertEquals(seen.at(-1)?.outcome?.winner, "x");
  assertEquals((await master.getMatch(match.id)).outcome, forfeited.outcome);

  const again = await assertRejects(
    () => master.forfeit(match.id, "o", "twice"),
    MatchError,
  );
  assertEquals(again.code, "match-finished");
});

Deno.test("forfeit is only for server-driven Seats of existing Matches", async () => {
  const { master } = setup();
  const { match } = await master.createMatch("tic-tac-toe", HUMANS);
  const human = await assertRejects(
    () => master.forfeit(match.id, "x", "no"),
    MatchError,
  );
  assertEquals(human.code, "not-server-driven");
  const unknownSeat = await assertRejects(
    () => master.forfeit(match.id, "toString", "no"),
    MatchError,
  );
  assertEquals(unknownSeat.code, "not-server-driven");
  const unknown = await assertRejects(
    () => master.forfeit("nope", "x", "no"),
    MatchError,
  );
  assertEquals(unknown.code, "unknown-match");
});
