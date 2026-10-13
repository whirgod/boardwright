import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import type { GameRules, MatchOutcome } from "@boardwright/core";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import {
  GameMaster,
  type MatchChange,
  MatchError,
  type MatchErrorCode,
  type MatchEvent,
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

/** A Move change, in Notation. */
const mv = (move: string): MatchChange => ({ kind: "move", move });

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
    await master.apply(m.id, { token: i % 2 === 0 ? m.x : m.o }, {
      kind: "move",
      move: move,
    });
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
    version: 1,
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
  assertEquals(view.outcome, {
    kind: "rules",
    winner: "x",
    reason: "three-in-a-row",
  });
  assertEquals(view.toMove, null);
  assertEquals(view.legalMoves, []);
  assertEquals((await store.get(id))?.outcome, view.outcome);
});

Deno.test("o wins a full Match", async () => {
  const { master } = setup();
  const { view } = await playAll(master, "a1", "a2", "b1", "b2", "a3", "c2");
  assertEquals(view.outcome, {
    kind: "rules",
    winner: "o",
    reason: "three-in-a-row",
  });
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
  assertEquals(view.outcome, { kind: "rules", reason: "board-full" });
  assertEquals(view.toMove, null);
});

Deno.test("a Move returns the updated Match", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  const view = await master.apply(m.id, { token: m.x }, {
    kind: "move",
    move: "b2",
  });
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
    () => master.apply(m.id, { token: m.o }, mv("a1")),
    "not-your-turn",
  );
  await master.apply(m.id, { token: m.x }, mv("a1"));
  await assertMatchError(
    () => master.apply(m.id, { token: m.x }, mv("b1")),
    "not-your-turn",
  );
  await master.apply(m.id, { token: m.o }, mv("b1"));
  assertEquals((await master.getMatch(m.id)).moves, ["a1", "b1"]);
});

Deno.test("illegal and undecodable Moves are refused without changing the Match", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  await master.apply(m.id, { token: m.x }, mv("a1"));
  await assertMatchError(
    () => master.apply(m.id, { token: m.o }, mv("a1")),
    "illegal-move",
  );
  await assertMatchError(
    () => master.apply(m.id, { token: m.o }, mv("z9")),
    "invalid-move",
  );
  await assertMatchError(
    () => master.apply(m.id, { token: m.o }, mv("")),
    "invalid-move",
  );
  assertEquals((await master.getMatch(m.id)).moves, ["a1"]);
});

Deno.test("a wrong or empty seat token is refused", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  const other = await newMatch(master);
  await assertMatchError(
    () => master.apply(m.id, { token: "nope" }, mv("a1")),
    "invalid-token",
  );
  await assertMatchError(
    () => master.apply(m.id, { token: "" }, mv("a1")),
    "invalid-token",
  );
  await assertMatchError(
    () => master.apply(m.id, { token: other.x }, mv("a1")),
    "invalid-token",
  );
});

Deno.test("a finished Match accepts no more Moves", async () => {
  const { master } = setup();
  const { id, o } = await playAll(master, "a1", "a2", "b1", "b2", "c1");
  await assertMatchError(
    () => master.apply(id, { token: o }, mv("c3")),
    "match-finished",
  );
});

Deno.test("client text is quoted and capped in error messages", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  const long = "q".repeat(10_000);
  for (
    const fn of [
      () => master.apply(m.id, { token: m.x }, mv(long)),
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
    () => master.apply("nope", { token: "t" }, mv("a1")),
    "unknown-match",
  );
  await assertMatchError(
    () => master.apply("nope", { seat: "x" }, mv("a1")),
    "unknown-match",
  );
});

// No server-driven Player kind exists yet (Engines come in #7), so these tests
// store a record whose Seats are a stand-in kind that holds no token.
const SERVER_DRIVEN = { kind: "engine" } as unknown as PlayerSpec;

const FORFEITED: MatchOutcome = {
  kind: "forfeit",
  winner: "x",
  seat: "o",
  reason: "timeout",
};

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

Deno.test("a server-driven Seat moves, with the same referee checks", async () => {
  const { master, store } = setup();
  const id = await storeServerDrivenMatch(store);
  await assertMatchError(
    () => master.apply(id, { seat: "o" }, mv("a1")),
    "not-your-turn",
  );
  const view = await master.apply(id, { seat: "x" }, {
    kind: "move",
    move: "a1",
  });
  assertEquals(view.moves, ["a1"]);
  await assertMatchError(
    () => master.apply(id, { seat: "o" }, mv("a1")),
    "illegal-move",
  );
  await assertMatchError(
    () => master.apply(id, { seat: "o" }, mv("zz")),
    "invalid-move",
  );
});

Deno.test("acting as a Seat refuses token-holding and unknown Seats", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  await assertMatchError(
    () => master.apply(m.id, { seat: "x" }, mv("a1")),
    "not-server-driven",
  );
  await assertMatchError(
    () => master.apply(m.id, { seat: "z" }, mv("a1")),
    "not-server-driven",
  );
  await assertMatchError(
    () => master.apply(m.id, { seat: "__proto__" }, mv("a1")),
    "not-server-driven",
  );
  assertEquals((await master.getMatch(m.id)).moves, []);
});

Deno.test("a stored Outcome ends the Match even if the Position does not", async () => {
  const { master, store } = setup();
  const id = await storeServerDrivenMatch(store, {
    moves: ["a1"],
    outcome: FORFEITED,
  });
  const view = await master.getMatch(id);
  assertEquals(view.position, "x........:o");
  assertEquals(view.toMove, null);
  assertEquals(view.legalMoves, []);
  assertEquals(view.outcome, FORFEITED);
  await assertMatchError(
    () => master.apply(id, { seat: "o" }, mv("b1")),
    "match-finished",
  );
});

Deno.test("onMatchChanged fires once per committed change, never for refusals", async () => {
  const { master } = setup();
  const seen: string[] = [];
  const stop = master.onMatchChanged((e) => {
    seen.push(`${e.matchId}@${e.version}:${e.kind}`);
  });
  master.onMatchChanged(() => {
    throw new Error("listener bug");
  });
  const originalError = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const m = await newMatch(master);
    await master.apply(m.id, { token: m.x }, mv("a1"));
    await assertMatchError(
      () => master.apply(m.id, { token: m.o }, mv("a1")),
      "illegal-move",
    );
    await master.apply(m.id, { token: m.o }, mv("b1"));
    stop();
    await master.apply(m.id, { token: m.x }, mv("c1"));
    assertEquals(seen, ["m1@1:created", "m1@2:move", "m1@3:move"]);
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
    await master.apply(m.id, { token: m.x }, mv("a1"));
    // Let the rejected listener promises settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(calls, 2);
    assertEquals(logged.length, 2);
    assert(String(logged[0]![1]).includes("async listener bug"));
  } finally {
    console.error = originalError;
  }
});

Deno.test("listeners get frozen events, separate from the returned Match", async () => {
  const { master } = setup();
  const received: MatchEvent[] = [];
  master.onMatchChanged((e) => {
    received.push(e);
  });
  const m = await newMatch(master);
  const view = await master.apply(m.id, { token: m.x }, mv("a1"));
  const [created, moved] = received;
  assert(created?.kind === "created" && moved?.kind === "move");
  assert(Object.isFrozen(created) && Object.isFrozen(moved));
  assert(Object.isFrozen(created.seats) && Object.isFrozen(created.seats.x));
  assertEquals(moved.version, view.version);
  assertEquals(moved.position, view.position);
  // The returned Match and the stored one are unaffected by listeners.
  (view.moves as string[]).push("tampered");
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
    master.apply(m.id, { token: m.x }, mv("a1")),
    master.apply(m.id, { token: m.x }, mv("b1")),
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
  await assertMatchError(
    () => master.apply(m.id, { token: m.x }, mv("a1")),
    "conflict",
  );
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
    () => master.apply(match.id, { token: tokens.a! }, mv("3")),
    "illegal-move",
  );
  const view = await master.apply(match.id, { token: tokens.a! }, {
    kind: "move",
    move: "1",
  });
  assertEquals(view.moves, ["+1"]);
  assertEquals(view.legalMoves, ["+1", "+2"]);
  // legalMoves lists +2 but play refuses it: a Game bug, not a client error.
  const bug = await assertRejects(() =>
    master.apply(match.id, { token: tokens.b! }, mv("+2"))
  );
  assert(!(bug instanceof MatchError));
  assertEquals((await master.getMatch(match.id)).moves, ["+1"]);
  await master.apply(match.id, { token: tokens.b! }, {
    kind: "move",
    move: "+1",
  });
  await master.apply(match.id, { token: tokens.a! }, {
    kind: "move",
    move: "+2",
  });
  const done = await master.getMatch(match.id);
  assertEquals(done.position, "4");
  assertEquals(done.outcome, { kind: "rules", reason: "reached-four" });
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

/** Records every event the master emits. */
function recordEvents(master: GameMaster): MatchEvent[] {
  const events: MatchEvent[] = [];
  master.onMatchChanged((e) => void events.push(e));
  return events;
}

Deno.test("events state each change kind, with consecutive versions", async () => {
  const master = setupWithEngines();
  const events = recordEvents(master);
  const { match, tokens } = await master.createMatch("tic-tac-toe", {
    x: { kind: "human" },
    o: engineSeat,
  });
  const moved = await master.apply(match.id, { token: tokens.x! }, mv("a1"));
  const ended = await master.apply(match.id, { seat: "o" }, {
    kind: "forfeit",
    reason: "timeout",
  });
  assertEquals(events, [
    {
      matchId: match.id,
      version: 1,
      at: match.createdAt,
      kind: "created",
      gameId: "tic-tac-toe",
      seats: { x: { kind: "human" }, o: engineSeat },
      position: ".........:x",
      toMove: "x",
      outcome: null,
    },
    {
      matchId: match.id,
      version: 2,
      at: moved.updatedAt,
      kind: "move",
      seat: "x",
      move: "a1",
      position: "x........:o",
      toMove: "o",
      outcome: null,
    },
    {
      matchId: match.id,
      version: 3,
      at: ended.updatedAt,
      kind: "forfeit",
      seat: "o",
      position: "x........:o",
      toMove: null,
      outcome: { kind: "forfeit", winner: "x", seat: "o", reason: "timeout" },
    },
  ]);
  assertEquals([match.version, moved.version, ended.version], [1, 2, 3]);
  assertEquals((await master.getMatch(match.id)).version, 3);
});

Deno.test("a Move that ends the Match is one move event with a rules Outcome", async () => {
  const { master } = setup();
  const events = recordEvents(master);
  const { id } = await playAll(master, "a1", "a2", "b1", "b2", "c1");
  const last = events.at(-1)!;
  assertEquals(events.length, 6);
  assertEquals(last.kind, "move");
  assertEquals(last.version, 6);
  assertEquals(last.toMove, null);
  assertEquals(last.outcome, {
    kind: "rules",
    winner: "x",
    reason: "three-in-a-row",
  });
  assertEquals((await master.getMatch(id)).outcome, last.outcome);
});

Deno.test("a Player may resign at any time; the Opponent wins", async () => {
  const { master } = setup();
  const events = recordEvents(master);
  const m = await newMatch(master);
  await master.apply(m.id, { token: m.x }, mv("b2"));
  // o is to move, but x may resign anyway.
  const view = await master.apply(m.id, { token: m.x }, {
    kind: "resignation",
  });
  const outcome = { kind: "resignation", winner: "o", seat: "x" } as const;
  assertEquals(view.outcome, outcome);
  assertEquals(view.moves, ["b2"]);
  assertEquals(view.position, "....x....:o");
  assertEquals(view.toMove, null);
  assertEquals(view.legalMoves, []);
  assertEquals(view.version, 3);
  assertEquals((await master.getMatch(m.id)).outcome, outcome);
  const last = events.at(-1)!;
  assert(last.kind === "resignation" && last.seat === "x");
  assertEquals(last.version, 3);
  assertEquals(last.outcome, outcome);
  await assertMatchError(
    () => master.apply(m.id, { token: m.o }, { kind: "resignation" }),
    "match-finished",
  );
  await assertMatchError(
    () => master.apply(m.id, { token: "nope" }, { kind: "resignation" }),
    "invalid-token",
  );
  assertEquals(events.length, 3);
});

Deno.test("a server-driven Seat may resign", async () => {
  const master = setupWithEngines();
  const { match } = await master.createMatch("tic-tac-toe", {
    x: { kind: "human" },
    o: engineSeat,
  });
  const view = await master.apply(match.id, { seat: "o" }, {
    kind: "resignation",
  });
  assertEquals(view.outcome, { kind: "resignation", winner: "x", seat: "o" });
});

Deno.test("an Engine Seat gets no token and forfeit ends the Match", async () => {
  const master = setupWithEngines();
  const seen = recordEvents(master);
  const { match, tokens } = await master.createMatch("tic-tac-toe", {
    x: { kind: "human" },
    o: engineSeat,
  });
  assertEquals(Object.keys(tokens), ["x"]);
  assertEquals(match.seats.o, engineSeat);

  const forfeit: MatchChange = { kind: "forfeit", reason: "illegal-move" };
  // Not o's turn yet: a stale forfeit is refused.
  await assertMatchError(
    () => master.apply(match.id, { seat: "o" }, forfeit),
    "not-your-turn",
  );
  await master.apply(match.id, { token: tokens.x! }, mv("a1"));
  const forfeited = await master.apply(match.id, { seat: "o" }, forfeit);
  assertEquals(forfeited.outcome, {
    kind: "forfeit",
    winner: "x",
    seat: "o",
    reason: "illegal-move",
  });
  assertEquals(forfeited.toMove, null);
  assertEquals(forfeited.legalMoves, []);
  assertEquals(seen.at(-1)?.outcome, forfeited.outcome);
  assertEquals((await master.getMatch(match.id)).outcome, forfeited.outcome);

  await assertMatchError(
    () => master.apply(match.id, { seat: "o" }, forfeit),
    "match-finished",
  );
});

Deno.test("forfeit is only for server-driven Seats of existing Matches", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  const forfeit: MatchChange = { kind: "forfeit", reason: "timeout" };
  await assertMatchError(
    () => master.apply(m.id, { seat: "x" }, forfeit),
    "not-server-driven",
  );
  await assertMatchError(
    () => master.apply(m.id, { seat: "toString" }, forfeit),
    "not-server-driven",
  );
  // A Player cannot forfeit itself; it resigns instead.
  await assertMatchError(
    () => master.apply(m.id, { token: m.x }, forfeit),
    "not-server-driven",
  );
  await assertMatchError(
    () => master.apply("nope", { seat: "x" }, forfeit),
    "unknown-match",
  );
  assertEquals((await master.getMatch(m.id)).outcome, null);
});
