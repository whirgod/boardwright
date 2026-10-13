import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { diceRace } from "@boardwright/testing";
import { drawChance, newChanceSeed, pickChance } from "./chance.ts";
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

function setup(options: { store?: MatchStore; seed?: string } = {}) {
  const store = options.store ?? new InMemoryMatchStore();
  let ids = 0;
  const master = new GameMaster({
    games: new GameRegistry([diceRace as AnyGameRules]),
    store,
    newMatchId: () => `m${++ids}`,
    newSeed: () => options.seed ?? SEED,
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
    "not-your-turn",
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
    "not-your-turn",
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

Deno.test("while a Chance event is pending only the Game master acts", async () => {
  const { master, store, events } = setup();
  await storePending(store);
  const pending = await master.getMatch("pending");
  assertEquals(pending.toMove, null);
  assertEquals(pending.outcome, null);
  assertEquals(pending.legalMoves, []);
  const refused = await assertMatchError(
    () =>
      master.apply("pending", { engineSeat: "a" }, { kind: "move", move: "f" }),
    "not-your-turn",
  );
  assertEquals(
    refused.message,
    "A Chance event is pending; the Game master is to act",
  );
  await assertMatchError(
    () =>
      master.apply("pending", GAME_MASTER, {
        kind: "forfeit",
        seat: "a",
        reason: "timeout",
      }),
    "not-your-turn",
  );
  assertEquals(events, []);
  const rolled = await master.apply("pending", GAME_MASTER, { kind: "chance" });
  assertEquals(rolled.moves, [{
    kind: "chance",
    chance: await expectedRoll(SEED, 0, "0:0:a:-"),
  }]);
  assertEquals(rolled.toMove, "a");
  assertEquals(events.map((e) => e.kind), ["chance"]);
});

Deno.test("a roll that fails is logged and leaves the Move committed", async () => {
  const inner = new InMemoryMatchStore();
  let failRolls = true;
  const store: MatchStore = {
    create: (r) => inner.create(r),
    get: (id) => inner.get(id),
    update: (r) =>
      failRolls && r.moves.at(-1)?.kind === "chance"
        ? Promise.resolve(false)
        : inner.update(r),
  };
  const { master, events } = setup({ store });
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  let created: MatchView;
  try {
    created = (await master.createMatch("dice-race", HUMANS)).match;
  } finally {
    console.error = original;
  }
  assertEquals(errors.length, 1);
  assertEquals(created.version, 1);
  assertEquals(created.toMove, null);
  assertEquals(events.map((e) => e.kind), ["created"]);
  failRolls = false;
  const view = await master.apply(created.id, GAME_MASTER, { kind: "chance" });
  assertEquals(view.toMove, "a");
  assertEquals(view.version, 2);
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
