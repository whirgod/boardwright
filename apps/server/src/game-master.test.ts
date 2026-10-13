import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import type { GameRules, Outcome } from "@boardwright/core";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import {
  GameMaster,
  type ImposedChange,
  MatchError,
  type MatchErrorCode,
  type MatchEvent,
  type PlayerChange,
} from "./game-master.ts";
import { EngineRegistry } from "./engines.ts";
import { type AnyGameRules, GameRegistry } from "./games.ts";
import {
  InMemoryMatchStore,
  type MatchRecord,
  type MatchStore,
  type MoveListEntry,
} from "./match-store.ts";
import { hashToken } from "./tokens.ts";
import type { Player } from "./players.ts";

const GAME_MASTER = { gameMaster: true } as const;

/** The Move list in Notation, Chance events in brackets. */
const played = (match: { moves: readonly MoveListEntry[] }) =>
  match.moves.map((e) => e.kind === "move" ? e.move : `[${e.chance}]`);

/** A Move change, in Notation. */
const mv = (move: string): PlayerChange => ({ kind: "move", move });

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
  assertEquals(played(view), ["a1", "a2", "b1", "b2", "c1"]);
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
  assertEquals(played(view), ["b2"]);
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
  assertEquals(played(await master.getMatch(m.id)), ["a1", "b1"]);
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
  assertEquals(played(await master.getMatch(m.id)), ["a1"]);
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
    () => master.apply("nope", { engineSeat: "x" }, mv("a1")),
    "unknown-match",
  );
});

// A stored Match with two Engine Seats (stored directly, so the Engine need
// not be registered).
const ENGINE: Player = { kind: "engine", engineId: "e", limits: {} };

const FORFEITED: Outcome = {
  kind: "forfeit",
  winner: "x",
  seat: "o",
  reason: "timeout",
};

async function storeEngineMatch(
  store: MatchStore,
  overrides: Partial<MatchRecord> = {},
): Promise<string> {
  await store.create({
    id: "auto",
    gameId: "tic-tac-toe",
    seats: { x: { player: ENGINE }, o: { player: ENGINE } },
    moves: [],
    version: 1,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  });
  return "auto";
}

Deno.test("an Engine Seat moves, with the same referee checks", async () => {
  const { master, store } = setup();
  const id = await storeEngineMatch(store);
  await assertMatchError(
    () => master.apply(id, { engineSeat: "o" }, mv("a1")),
    "not-your-turn",
  );
  const view = await master.apply(id, { engineSeat: "x" }, {
    kind: "move",
    move: "a1",
  });
  assertEquals(played(view), ["a1"]);
  await assertMatchError(
    () => master.apply(id, { engineSeat: "o" }, mv("a1")),
    "illegal-move",
  );
  await assertMatchError(
    () => master.apply(id, { engineSeat: "o" }, mv("zz")),
    "invalid-move",
  );
});

Deno.test("acting as an Engine Seat refuses human and unknown Seats", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  await assertMatchError(
    () => master.apply(m.id, { engineSeat: "x" }, mv("a1")),
    "not-engine-seat",
  );
  await assertMatchError(
    () => master.apply(m.id, { engineSeat: "z" }, mv("a1")),
    "not-engine-seat",
  );
  await assertMatchError(
    () => master.apply(m.id, { engineSeat: "__proto__" }, mv("a1")),
    "not-engine-seat",
  );
  assertEquals(played(await master.getMatch(m.id)), []);
});

Deno.test("a stored Outcome ends the Match even if the Position does not", async () => {
  const { master, store } = setup();
  const id = await storeEngineMatch(store, {
    moves: [{ kind: "move", move: "a1" }],
    outcome: FORFEITED,
  });
  const view = await master.getMatch(id);
  assertEquals(view.position, "x........:o");
  assertEquals(view.toMove, null);
  assertEquals(view.legalMoves, []);
  assertEquals(view.outcome, FORFEITED);
  await assertMatchError(
    () => master.apply(id, { engineSeat: "o" }, mv("b1")),
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
  (view.moves as MoveListEntry[]).push({ kind: "move", move: "tampered" });
  assertEquals(played(await master.getMatch(m.id)), ["a1"]);
});

Deno.test("games exposes the registry", () => {
  const { master } = setup();
  assertEquals(master.games.get("tic-tac-toe"), ticTacToe);
});

Deno.test("concurrent Moves for the same turn: exactly one wins, one event", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  const events = recordEvents(master);
  const results = await Promise.allSettled([
    master.apply(m.id, { token: m.x }, mv("a1")),
    master.apply(m.id, { token: m.x }, mv("b1")),
  ]);
  assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert(rejected?.reason instanceof MatchError);
  // Changes to one Match are applied one at a time: the loser sees the new turn.
  assertEquals(rejected.reason.code, "not-your-turn");
  assertEquals((await master.getMatch(m.id)).moves.length, 1);
  assertEquals(events.map((e) => [e.kind, e.version]), [["move", 2]]);
});

Deno.test("expectedVersion: a stale change is a conflict and emits nothing", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  const events = recordEvents(master);
  const expect = { expectedVersion: 1 };
  const results = await Promise.allSettled([
    master.apply(m.id, { token: m.x }, mv("a1"), expect),
    master.apply(m.id, { token: m.x }, { kind: "resignation" }, expect),
  ]);
  assertEquals(results[0].status, "fulfilled");
  assert(results[1].status === "rejected");
  assert(results[1].reason instanceof MatchError);
  assertEquals(results[1].reason.code, "conflict");
  assertEquals(events.map((e) => [e.kind, e.version]), [["move", 2]]);
  const view = await master.apply(m.id, { token: m.o }, mv("b1"), {
    expectedVersion: 2,
  });
  assertEquals(view.version, 3);
});

Deno.test("a lost store update is reported as a conflict and emits nothing", async () => {
  const inner = new InMemoryMatchStore();
  const store: MatchStore = {
    create: (r) => inner.create(r),
    get: (id) => inner.get(id),
    update: () => Promise.resolve(false),
  };
  const { master } = setup({ store });
  const m = await newMatch(master);
  const events = recordEvents(master);
  await assertMatchError(
    () => master.apply(m.id, { token: m.x }, mv("a1")),
    "conflict",
  );
  assertEquals(events, []);
});

/** Records every event the master emits. */
function recordEvents(master: GameMaster): MatchEvent[] {
  const events: MatchEvent[] = [];
  master.onMatchChanged((e) => void events.push(e));
  return events;
}

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
  assertEquals(played(view), ["+1"]);
  assertEquals(view.legalMoves, ["+1", "+2"]);
  // legalMoves lists +2 but play refuses it: a Game bug, not a client error.
  const bug = await assertRejects(() =>
    master.apply(match.id, { token: tokens.b! }, mv("+2"))
  );
  assert(!(bug instanceof MatchError));
  assertEquals(played(await master.getMatch(match.id)), ["+1"]);
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
const engineSeat: Player = { kind: "engine", engineId: "e", limits: {} };

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

Deno.test("events state each change kind, with consecutive versions", async () => {
  const master = setupWithEngines();
  const events = recordEvents(master);
  const { match, tokens } = await master.createMatch("tic-tac-toe", {
    x: { kind: "human" },
    o: engineSeat,
  });
  const moved = await master.apply(match.id, { token: tokens.x! }, mv("a1"));
  const ended = await master.apply(match.id, GAME_MASTER, {
    kind: "forfeit",
    seat: "o",
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
  assertEquals(played(view), ["b2"]);
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

Deno.test("an Engine Seat may resign", async () => {
  const master = setupWithEngines();
  const { match } = await master.createMatch("tic-tac-toe", {
    x: { kind: "human" },
    o: engineSeat,
  });
  const view = await master.apply(match.id, { engineSeat: "o" }, {
    kind: "resignation",
  });
  assertEquals(view.outcome, { kind: "resignation", winner: "x", seat: "o" });
});

Deno.test("an Engine Seat gets no token and the Game master forfeits it", async () => {
  const master = setupWithEngines();
  const seen = recordEvents(master);
  const { match, tokens } = await master.createMatch("tic-tac-toe", {
    x: { kind: "human" },
    o: engineSeat,
  });
  assertEquals(Object.keys(tokens), ["x"]);
  assertEquals(match.seats.o, engineSeat);

  const forfeit: ImposedChange = {
    kind: "forfeit",
    seat: "o",
    reason: "illegal-move",
  };
  // Not o's turn yet: a stale forfeit is refused.
  await assertMatchError(
    () => master.apply(match.id, GAME_MASTER, forfeit),
    "not-your-turn",
  );
  await master.apply(match.id, { token: tokens.x! }, mv("a1"));
  const forfeited = await master.apply(match.id, GAME_MASTER, forfeit);
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
    () => master.apply(match.id, GAME_MASTER, forfeit),
    "match-finished",
  );
});

Deno.test("the Game master may forfeit a human Seat that is to move", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  const view = await master.apply(m.id, GAME_MASTER, {
    kind: "forfeit",
    seat: "x",
    reason: "timeout",
  });
  assertEquals(view.outcome?.winner, "o");
  await assertMatchError(
    () =>
      master.apply("nope", GAME_MASTER, {
        kind: "forfeit",
        seat: "x",
        reason: "timeout",
      }),
    "unknown-match",
  );
});

Deno.test("only the Game master imposes changes, and it makes no Player's", async () => {
  const { master } = setup();
  const m = await newMatch(master);
  const forfeit = { kind: "forfeit", seat: "x", reason: "timeout" } as const;
  // The overloads rule these out at compile time; at run time they are bugs.
  const anyApply = master.apply.bind(master) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  await assertRejects(() => anyApply(m.id, { token: m.x }, forfeit), TypeError);
  await assertRejects(() => anyApply(m.id, GAME_MASTER, mv("a1")), TypeError);
  assertEquals((await master.getMatch(m.id)).version, 1);
});

/** A store whose calls hang (never settle) while `hang.get` / `hang.update` is set. */
function hangingStore() {
  const inner = new InMemoryMatchStore();
  const hang = { get: false, update: false };
  const never = <T>() => new Promise<T>(() => {});
  const store: MatchStore = {
    create: (r) => inner.create(r),
    get: (id) => hang.get ? never() : inner.get(id),
    update: (r) => hang.update ? never() : inner.update(r),
  };
  return { store, hang };
}

Deno.test("a hung store call fails after storeTimeoutMs and does not block later changes", async () => {
  const { store, hang } = hangingStore();
  const master = new GameMaster({
    games: new GameRegistry([ticTacToe]),
    store,
    storeTimeoutMs: 20,
  });
  const { match, tokens } = await master.createMatch("tic-tac-toe", HUMANS);
  const x = { token: tokens.x! };
  hang.get = true;
  const stuck = assertRejects(
    () => master.apply(match.id, x, mv("a1")),
    Error,
    "did not settle in 20 ms",
  );
  // Queued behind the hung change, it fails the same way instead of waiting forever.
  const queued = assertRejects(() => master.getMatch(match.id), Error);
  await stuck;
  await queued;
  hang.get = false;
  hang.update = true;
  await assertRejects(
    () => master.apply(match.id, x, mv("a1")),
    Error,
    "MatchStore.update did not settle",
  );
  hang.update = false;
  const view = await master.apply(match.id, x, mv("a1"));
  assertEquals(played(view), ["a1"]);
});

Deno.test("a store call that waits for a change to its own Match is cut off, not a deadlock", async () => {
  const inner = new InMemoryMatchStore();
  const ref: { master?: GameMaster; reenter: boolean } = { reenter: false };
  const store: MatchStore = {
    create: (r) => inner.create(r),
    get: async (id) => {
      if (ref.reenter) {
        // Waits for a change queued behind the one that is calling this.
        await ref.master!.apply(id, GAME_MASTER, {
          kind: "forfeit",
          seat: "x",
          reason: "timeout",
        });
      }
      return inner.get(id);
    },
    update: (r) => inner.update(r),
  };
  const master = new GameMaster({
    games: new GameRegistry([ticTacToe]),
    store,
    storeTimeoutMs: 20,
  });
  ref.master = master;
  const { match, tokens } = await master.createMatch("tic-tac-toe", HUMANS);
  ref.reenter = true;
  await assertRejects(
    () => master.apply(match.id, { token: tokens.x! }, mv("a1")),
    Error,
    "did not settle",
  );
});
