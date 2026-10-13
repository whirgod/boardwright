import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { pickChance } from "@boardwright/core";
import { diceRace } from "@boardwright/testing";
import { drawChance, newChanceSeed } from "./chance.ts";
import {
  GameMaster,
  MatchError,
  type MatchErrorCode,
  type MatchEvent,
  type MatchView,
} from "./game-master.ts";
import { type AnyGameRules, GameRegistry } from "./games.ts";
import {
  InMemoryMatchStore,
  type MatchRecord,
  type MatchStore,
} from "./match-store.ts";

const SEED = "fixed-test-seed";
const HUMANS = { a: { kind: "human" }, b: { kind: "human" } } as const;
const GAME_MASTER = { gameMaster: true } as const;

/** The roll the Game master must draw as the Match's n-th Chance event. */
async function expectedRoll(seed: string, n: number, position: string) {
  const p = diceRace.notation.decodePosition(position);
  const roll = pickChance(diceRace.chanceEvents(p), await drawChance(seed, n));
  return diceRace.notation.encodeChance(roll);
}

function setup(
  options: {
    store?: MatchStore;
    seed?: string;
    now?: () => Date;
    rollCooldownMs?: number;
  } = {},
) {
  const store = options.store ?? new InMemoryMatchStore();
  let ids = 0;
  const master = new GameMaster({
    games: new GameRegistry([diceRace as AnyGameRules]),
    store,
    newMatchId: () => `m${++ids}`,
    newSeed: () => options.seed ?? SEED,
    rollRetryDelaysMs: [1, 1],
    rollCooldownMs: options.rollCooldownMs ?? 0,
    ...options.now && { now: options.now },
  });
  const events: MatchEvent[] = [];
  master.onMatchChanged((e) => {
    events.push(e);
  });
  return { master, store, events };
}

async function assertMatchError(
  fn: () => Promise<unknown>,
  code: MatchErrorCode,
): Promise<MatchError> {
  const error = await assertRejects(fn, MatchError);
  assertEquals(error.code, code, error.message);
  return error;
}

/** Plays `f` for whichever Seat is to move until the Match ends. */
async function playOut(
  master: GameMaster,
  id: string,
  tokens: Readonly<Record<string, string>>,
): Promise<MatchView> {
  let view = await master.getMatch(id);
  while (view.outcome === null) {
    view = await master.apply(id, { token: tokens[view.toMove!]! }, {
      kind: "move",
      move: "f",
    });
  }
  return view;
}

Deno.test("drawChance: deterministic per (seed, n), in [0, 1)", async () => {
  const a = await drawChance("s", 0);
  assertEquals(await drawChance("s", 0), a);
  assertNotEquals(await drawChance("s", 1), a);
  assertNotEquals(await drawChance("t", 0), a);
  for (let n = 0; n < 50; n++) {
    const u = await drawChance("s", n);
    assert(u >= 0 && u < 1, `${u}`);
  }
  assertEquals(newChanceSeed().length, 64);
  assertNotEquals(newChanceSeed(), newChanceSeed());
});

Deno.test("pickChance: by cumulative probability, in the Game's order", () => {
  const results = [
    { chance: "x", probability: 0.5 },
    { chance: "y", probability: 0.25 },
    { chance: "z", probability: 0.25 },
  ];
  assertEquals(pickChance(results, 0), "x");
  assertEquals(pickChance(results, 0.4999), "x");
  assertEquals(pickChance(results, 0.5), "y");
  assertEquals(pickChance(results, 0.75), "z");
  assertEquals(pickChance(results, 0.999999), "z");
  // Rounding that leaves u beyond the sum still picks the last result.
  const short = [{ chance: "x", probability: 0.3 }, {
    chance: "y",
    probability: 0.3,
  }];
  assertEquals(pickChance(short, 0.9), "y");
  assertThrows(() => pickChance([], 0.5), RangeError);
});

// Known answers, computed independently of this code, e.g.
// `printf 's:6' | sha256sum` -> ba7075967b55..., first 12 hex digits / 2^48.
// They pin the published algorithm: changing it would break the
// verification of every finished Match's rolls.
Deno.test("drawChance + pickChance: known answers", async () => {
  const known: [string, number, number, number][] = [
    // seed, n, first 48 bits of SHA-256("<seed>:<n>"), dice-race roll
    ["s", 0, 0x21d0725006cf, 1],
    ["s", 3, 0xd12d3bcf5e7a, 3],
    ["s", 6, 0xba7075967b55, 2],
    ["fixed-test-seed", 0, 0x372641f2d3f3, 1],
  ];
  const rolls = diceRace.chanceEvents(diceRace.initialPosition());
  for (const [seed, n, bits, roll] of known) {
    const u = await drawChance(seed, n);
    assertEquals(u, bits / 2 ** 48, `${seed}:${n}`);
    assertEquals(pickChance(rolls, u), roll, `${seed}:${n}`);
  }
});

Deno.test("createMatch resolves the opening Chance event right away", async () => {
  const { master, events } = setup();
  const { match } = await master.createMatch("dice-race", HUMANS);
  const roll = await expectedRoll(SEED, 0, "0:0:a:-");
  assertEquals(match.moves, [{ kind: "chance", chance: roll }]);
  assertEquals(match.version, 2);
  assertEquals(match.toMove, "a");
  assertEquals(match.position, `0:0:a:${roll}`);
  assertEquals(match.legalMoves, ["f", "1"]);
  assertEquals(match.seed, undefined);
  assertEquals(events.map((e) => [e.kind, e.version, e.toMove]), [
    ["created", 1, null],
    ["chance", 2, "a"],
  ]);
  assertEquals(events[1], {
    matchId: "m1",
    version: 2,
    at: match.updatedAt,
    position: match.position,
    toMove: "a",
    outcome: null,
    kind: "chance",
    chance: roll,
  });
  assertEquals(await master.getMatch(match.id), match);
});

Deno.test("a Move that leaves a Chance event pending is followed by its roll", async () => {
  const { master, events } = setup();
  const { match, tokens } = await master.createMatch("dice-race", HUMANS);
  events.length = 0;
  const view = await master.apply(match.id, { token: tokens.a! }, {
    kind: "move",
    move: "1",
  });
  const roll = await expectedRoll(SEED, 1, "1:0:b:-");
  assertEquals(view.moves.slice(1), [
    { kind: "move", move: "1" },
    { kind: "chance", chance: roll },
  ]);
  assertEquals(view.toMove, "b");
  assertEquals(view.version, 4);
  assertEquals(
    events.map((e) => [e.kind, e.version, e.position, e.toMove]),
    [
      ["move", 3, "1:0:b:-", null],
      ["chance", 4, `1:0:b:${roll}`, "b"],
    ],
  );
});

Deno.test("rolls are deterministic for a seed; the Move list replays", async () => {
  const one = setup();
  const two = setup();
  const m1 = await one.master.createMatch("dice-race", HUMANS);
  const m2 = await two.master.createMatch("dice-race", HUMANS);
  const end1 = await playOut(one.master, m1.match.id, m1.tokens);
  const end2 = await playOut(two.master, m2.match.id, m2.tokens);
  assertEquals(end1.moves, end2.moves);
  assertEquals(end1.position, end2.position);
  // A fresh Game master on the same store rebuilds the same Match.
  const again = new GameMaster({
    games: new GameRegistry([diceRace as AnyGameRules]),
    store: one.store,
  });
  assertEquals(await again.getMatch(m1.match.id), end1);
});

Deno.test("the seed stays secret until the Outcome, then verifies every roll", async () => {
  const { master, store, events } = setup({ seed: "another-seed" });
  const { match, tokens } = await master.createMatch("dice-race", HUMANS);
  let view = match;
  while (view.outcome === null) {
    assertEquals("seed" in view, false);
    assertEquals((await master.getMatch(match.id)).seed, undefined);
    view = await master.apply(match.id, { token: tokens[view.toMove!]! }, {
      kind: "move",
      move: "f",
    });
  }
  assertEquals(view.outcome?.kind, "rules");
  assertEquals(view.seed, "another-seed");
  assertEquals((await master.getMatch(match.id)).seed, "another-seed");
  assert(events.every((e) => !JSON.stringify(e).includes("another-seed")));
  assertEquals((await store.get(match.id))?.seed, "another-seed");

  // Anyone can now check each roll from the seed.
  let position = diceRace.initialPosition();
  let n = 0;
  for (const entry of view.moves) {
    if (entry.kind === "chance") {
      assertEquals(
        entry.chance,
        await expectedRoll(
          view.seed!,
          n++,
          diceRace.notation.encodePosition(position),
        ),
      );
      position = diceRace.resolveChance(
        position,
        diceRace.notation.decodeChance(entry.chance, position),
      );
    } else {
      position = diceRace.play(
        position,
        diceRace.notation.decodeMove(entry.move, position),
      );
    }
  }
  assertEquals(diceRace.notation.encodePosition(position), view.position);
});

Deno.test("a Resignation reveals the seed too", async () => {
  const { master } = setup();
  const { match, tokens } = await master.createMatch("dice-race", HUMANS);
  const view = await master.apply(match.id, { token: tokens.b! }, {
    kind: "resignation",
  });
  assertEquals(view.outcome, { kind: "resignation", winner: "a", seat: "b" });
  assertEquals(view.seed, SEED);
});

Deno.test("refused changes roll nothing", async () => {
  const { master, events } = setup();
  const { match, tokens } = await master.createMatch("dice-race", HUMANS);
  events.length = 0;
  await assertMatchError(
    () =>
      master.apply(match.id, { token: tokens.b! }, { kind: "move", move: "f" }),
    "not-your-turn",
  );
  await assertMatchError(
    () =>
      master.apply(match.id, { token: tokens.a! }, { kind: "move", move: "x" }),
    "invalid-move",
  );
  await assertMatchError(
    () =>
      master.apply(
        match.id,
        { token: tokens.a! },
        { kind: "move", move: "f" },
        {
          expectedVersion: 1,
        },
      ),
    "conflict",
  );
  // No Chance event is pending: the Game master has nothing to roll.
  const refused = await assertMatchError(
    () => master.apply(match.id, GAME_MASTER, { kind: "chance" }),
    "conflict",
  );
  assertEquals(refused.message, "No Chance event is pending");
  assertEquals(events, []);
  assertEquals(await master.getMatch(match.id), match);
});

Deno.test("Games without chance cannot be rolled for and get no seed", async () => {
  const { ticTacToe } = await import("@boardwright/game-tic-tac-toe");
  const store = new InMemoryMatchStore();
  const master = new GameMaster({
    games: new GameRegistry([ticTacToe as AnyGameRules]),
    store,
  });
  const { match } = await master.createMatch("tic-tac-toe", {
    x: { kind: "human" },
    o: { kind: "human" },
  });
  assertEquals((await store.get(match.id))?.seed, undefined);
  await assertMatchError(
    () => master.apply(match.id, GAME_MASTER, { kind: "chance" }),
    "conflict",
  );
});

/** A stored dice-race Match waiting for its opening roll (as if the roll had failed). */
async function storePending(store: MatchStore): Promise<MatchRecord> {
  const record: MatchRecord = {
    id: "pending",
    gameId: "dice-race",
    seats: {
      a: { player: { kind: "engine", engineId: "e", limits: {} } },
      b: { player: { kind: "engine", engineId: "e", limits: {} } },
    },
    moves: [],
    seed: SEED,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await store.create(record);
  return record;
}

/** A store whose roll writes fail `state.failures` times (Infinity: always). */
function flakyStore() {
  const inner = new InMemoryMatchStore();
  const state = { failures: 0 };
  const store: MatchStore = {
    create: (r) => inner.create(r),
    get: (id) => inner.get(id),
    update: (r) =>
      r.moves.at(-1)?.kind === "chance" && state.failures-- > 0
        ? Promise.reject(new Error("store down"))
        : inner.update(r),
  };
  return { store, state };
}

/** Runs `fn` with console.error captured; returns its result and the logged calls. */
async function quietly<T>(fn: () => Promise<T>) {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    return { result: await fn(), errors };
  } finally {
    console.error = original;
  }
}

Deno.test("a failed roll is retried automatically with backoff", async () => {
  const { store, state } = flakyStore();
  state.failures = 2; // the two retries of rollRetryDelaysMs: [1, 1]
  const { master, events } = setup({ store });
  const { result, errors } = await quietly(() =>
    master.createMatch("dice-race", HUMANS)
  );
  assertEquals(errors.length, 2);
  assertEquals(result.match.version, 2);
  assertEquals(result.match.toMove, "a");
  assertEquals(events.map((e) => e.kind), ["created", "chance"]);
});

Deno.test("a roll that keeps failing: the change stays committed; a refused Move retries it", async () => {
  const { store, state } = flakyStore();
  state.failures = Infinity;
  const { master, events } = setup({ store });
  const { result, errors } = await quietly(() =>
    master.createMatch("dice-race", HUMANS)
  );
  assertEquals(errors.length, 3); // first try + 2 retries, then gives up
  const { match, tokens } = result;
  assertEquals([match.version, match.toMove, match.outcome], [1, null, null]);
  assertEquals(match.legalMoves, []);

  // While it is pending, Moves and Forfeits are refused with chance-pending.
  const refused = await quietly(() =>
    assertMatchError(
      () =>
        master.apply(match.id, { token: tokens.a! }, {
          kind: "move",
          move: "f",
        }),
      "chance-pending",
    )
  );
  assertEquals(
    refused.result.message,
    "A Chance event is pending; the Game master is to act",
  );
  await quietly(() =>
    assertMatchError(
      () =>
        master.apply(match.id, GAME_MASTER, {
          kind: "forfeit",
          seat: "a",
          reason: "timeout",
        }),
      "chance-pending",
    )
  );
  assertEquals(events.map((e) => e.kind), ["created"]);

  // Once the store works again, the next refused Move triggers the roll.
  state.failures = 0;
  await assertMatchError(
    () =>
      master.apply(match.id, { token: tokens.a! }, { kind: "move", move: "f" }),
    "chance-pending",
  );
  assertEquals(events.map((e) => e.kind), ["created", "chance"]);
  const rolled = (await store.get(match.id))!;
  assertEquals(rolled.moves, [{
    kind: "chance",
    chance: await expectedRoll(SEED, 0, "0:0:a:-"),
  }]);
  const moved = await master.apply(match.id, { token: tokens.a! }, {
    kind: "move",
    move: "f",
  });
  assertEquals(moved.toMove, "b");
});

Deno.test("reading a Match that waits for a roll queues the roll", async () => {
  const { store, state } = flakyStore();
  state.failures = Infinity;
  const { master, events } = setup({ store });
  const { result } = await quietly(() =>
    master.createMatch("dice-race", HUMANS)
  );
  state.failures = 0;
  const seen = await master.getMatch(result.match.id);
  assertEquals(seen.toMove, null); // the read itself does not wait
  // An explicit roll queued behind the recovery finds nothing left to do.
  await assertMatchError(
    () => master.apply(result.match.id, GAME_MASTER, { kind: "chance" }),
    "conflict",
  );
  assertEquals(events.map((e) => e.kind), ["created", "chance"]);
  assertEquals((await master.getMatch(result.match.id)).toMove, "a");
});

Deno.test("the Game master can roll a pending Chance event explicitly", async () => {
  const { master, store, events } = setup();
  await storePending(store);
  const rolled = await master.apply("pending", GAME_MASTER, { kind: "chance" });
  assertEquals(rolled.moves, [{
    kind: "chance",
    chance: await expectedRoll(SEED, 0, "0:0:a:-"),
  }]);
  assertEquals(rolled.toMove, "a");
  assertEquals(events.map((e) => e.kind), ["chance"]);
});

Deno.test("a seedless record of a Game with chance is a server fault", async () => {
  const { master, store } = setup();
  const { seed: _seed, ...record } = await storePending(
    new InMemoryMatchStore(),
  );
  await store.create(record);
  await assertRejects(
    () => master.apply("pending", GAME_MASTER, { kind: "chance" }),
    Error,
    "no seed",
  );
});

Deno.test("a permanently failing roll is retried once per cooldown, not per request", async () => {
  let attempts = 0;
  const inner = new InMemoryMatchStore();
  const store: MatchStore = {
    create: (r) => inner.create(r),
    get: (id) => inner.get(id),
    update: (r) => {
      if (r.moves.at(-1)?.kind !== "chance") return inner.update(r);
      attempts++;
      return Promise.reject(new Error("store down"));
    },
  };
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const { master } = setup({
    store,
    now: () => new Date(clock),
    rollCooldownMs: 1000,
  });
  const { result, errors } = await quietly(async () => {
    const created = await master.createMatch("dice-race", HUMANS);
    const { match, tokens } = created;
    const refuse = () =>
      assertMatchError(
        () =>
          master.apply(match.id, GAME_MASTER, {
            kind: "forfeit",
            seat: "a",
            reason: "timeout",
          }),
        "chance-pending",
      );
    // One cycle for the opening roll (first try + 2 retries), then quiet.
    for (let i = 0; i < 5; i++) await master.getMatch(match.id);
    await refuse(); // also a barrier: queued behind any recovery roll
    await refuse();
    await assertMatchError(
      () =>
        master.apply(match.id, { token: tokens.a! }, {
          kind: "move",
          move: "f",
        }),
      "chance-pending",
    );
    const bounded = attempts;
    // After the cooldown, one trigger starts one more cycle.
    clock += 1001;
    await refuse();
    return { bounded, after: attempts };
  });
  assertEquals(result, { bounded: 3, after: 6 });
  assertEquals(errors.length, 6);
});

Deno.test("an explicit roll ignores the cooldown; a successful roll ends it", async () => {
  const { store, state } = flakyStore();
  state.failures = Infinity;
  const { master, events } = setup({
    store,
    now: () => new Date(0),
    rollCooldownMs: 1_000_000,
  });
  const { result } = await quietly(() =>
    master.createMatch("dice-race", HUMANS)
  );
  const { match, tokens } = result;
  const move = { kind: "move", move: "f" } as const;
  // Cooling down: a refused Move does not retry, even though the store works.
  state.failures = 0;
  await assertMatchError(
    () => master.apply(match.id, { token: tokens.a! }, move),
    "chance-pending",
  );
  assertEquals(events.map((e) => e.kind), ["created"]);
  // An explicit roll ignores the cooldown and succeeds.
  await master.apply(match.id, GAME_MASTER, { kind: "chance" });
  assertEquals(events.map((e) => e.kind), ["created", "chance"]);
  // The success cleared the cooldown: the Match plays on, and its next
  // roll happens at once.
  await master.apply(match.id, { token: tokens.a! }, move);
  assertEquals(events.map((e) => e.kind), [
    "created",
    "chance",
    "move",
    "chance",
  ]);
});
