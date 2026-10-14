import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ChanceGameRules } from "@boardwright/core";
import {
  diceRace,
  type DiceRaceMove,
  type DiceRacePosition,
  type DiceRaceRoll,
} from "@boardwright/testing";
import { drawChance } from "./chance.ts";
import { EngineDriver } from "./engine-driver.ts";
import { type AnalysisRequest, EngineRunner } from "./engine-runner.ts";
import { EngineRegistry } from "./engines.ts";
import {
  GameMaster,
  MatchError,
  type MatchEvent,
  type MatchView,
} from "./game-master.ts";
import { type AnyGameRules, GameRegistry } from "./games.ts";
import { InMemoryMatchStore, type MatchStore } from "./match-store.ts";
import type { Player } from "./players.ts";

// "Pass race": dice race where a roll of 1 leaves no play but the empty one
// (`pass`), like a backgammon roll that cannot be played.
type PassMove = DiceRaceMove | "pass";
type Pos = DiceRacePosition;
const passRace: ChanceGameRules<Pos, PassMove, DiceRaceRoll> = {
  ...diceRace,
  id: "pass-race",
  legalMoves: (p) =>
    p.roll === 1 && diceRace.toMove(p) !== undefined
      ? ["pass"]
      : diceRace.legalMoves(p),
  play: (p, move) =>
    move === "pass"
      ? { ...p, turn: p.turn === "a" ? "b" : "a", roll: null }
      : diceRace.play(p, move),
  isPass: (move) => move === "pass",
  notation: {
    ...diceRace.notation,
    decodeMove: (text, p) =>
      text === "pass" ? "pass" : diceRace.notation.decodeMove(text, p),
  },
};

/** A game with the same shape but no `isPass`: a forced Move is just a Move. */
const { isPass: _hint, ...withoutHint } = passRace;
const noHint: ChanceGameRules<Pos, PassMove, DiceRaceRoll> = {
  ...withoutHint,
  id: "no-hint",
};

/** A pass that ends the Match: the Seat to move wins by passing. */
const endPass: ChanceGameRules<Pos, PassMove, DiceRaceRoll> = {
  ...passRace,
  id: "end-pass",
  play: (p, move) =>
    move === "pass"
      ? { ...p, [p.turn]: 6, turn: p.turn === "a" ? "b" : "a", roll: null }
      : diceRace.play(p, move),
};

const HUMANS = { a: { kind: "human" }, b: { kind: "human" } } as const;

/** A seed whose first draws roll `rolls` (dice-race: 1 below 0.5, 2 below 0.75, else 3). */
async function seedFor(rolls: readonly number[]): Promise<string> {
  const rollOf = (u: number) => u < 0.5 ? 1 : u < 0.75 ? 2 : 3;
  for (let i = 0;; i++) {
    const seed = `seed-${i}`;
    let ok = true;
    for (let n = 0; n < rolls.length && ok; n++) {
      ok = rollOf(await drawChance(seed, n)) === rolls[n];
    }
    if (ok) return seed;
  }
}

function setup(
  seed: string,
  options: {
    store?: MatchStore;
    engines?: EngineRegistry;
    retryDelaysMs?: readonly number[];
    cooldownMs?: number;
    now?: () => Date;
  } = {},
) {
  const master = new GameMaster({
    games: new GameRegistry([passRace, noHint, endPass] as AnyGameRules[]),
    store: options.store ?? new InMemoryMatchStore(),
    ...options.engines && { engines: options.engines },
    newSeed: () => seed,
    rollRetryDelaysMs: options.retryDelaysMs ?? [],
    rollCooldownMs: options.cooldownMs ?? 0,
    ...options.now && { now: options.now },
  });
  const events: MatchEvent[] = [];
  master.onMatchChanged((e) => {
    events.push(e);
  });
  return { master, events };
}

const list = (match: MatchView) =>
  match.moves.map((e) => e.kind === "move" ? e.move : `[${e.chance}]`);

Deno.test("a forced pass is played by the Game master, then the next roll follows", async () => {
  const { master, events } = setup(await seedFor([1, 3]));
  const { match } = await master.createMatch("pass-race", HUMANS);
  // Opening roll 1, a's only Move is `pass`, then b's roll 3.
  assertEquals(list(match), ["[1]", "pass", "[3]"]);
  assertEquals(match.toMove, "b");
  assertEquals(match.legalMoves, ["f", "1"]);
  assertEquals(
    events.map((e) => e.kind === "move" ? `move ${e.seat} ${e.move}` : e.kind),
    ["created", "chance", "move a pass", "chance"],
  );
  assertEquals(events.map((e) => e.version), [1, 2, 3, 4]);
});

Deno.test("a pass after a Player's Move chains: Move, roll, pass, roll", async () => {
  const { master } = setup(await seedFor([3, 1, 2]));
  const { match, tokens } = await master.createMatch("pass-race", HUMANS);
  assertEquals(list(match), ["[3]"]);
  assertEquals(match.toMove, "a"); // roll 3: a has a choice, no auto-play
  const after = await master.apply(match.id, { token: tokens.a! }, {
    kind: "move",
    move: "f",
  });
  assertEquals(list(after), ["[3]", "f", "[1]", "pass", "[2]"]);
  assertEquals(after.toMove, "a");
});

Deno.test("no auto-play when the Seat has a choice or the Game declares no pass", async () => {
  const choice = setup(await seedFor([2]));
  const { match } = await choice.master.createMatch("pass-race", HUMANS);
  assertEquals(list(match), ["[2]"]);
  assertEquals(match.legalMoves, ["f", "1"]);
  const error = await assertRejects(
    () => choice.master.apply(match.id, { gameMaster: true }, { kind: "pass" }),
    MatchError,
  );
  assertEquals(error.code, "conflict");

  // Same forced single Move, but not declared a pass: the Seat plays it.
  const plain = setup(await seedFor([1]));
  const forced = (await plain.master.createMatch("no-hint", HUMANS)).match;
  assertEquals(list(forced), ["[1]"]);
  assertEquals(forced.legalMoves, ["pass"]);
  assertEquals(forced.toMove, "a");
});

Deno.test("a pass that failed to store is applied by getMatch after a restart", async () => {
  const seed = await seedFor([1, 2]);
  const inner = new InMemoryMatchStore();
  let failing = true;
  const store: MatchStore = {
    create: (r) => inner.create(r),
    list: (q) => inner.list(q),
    get: (id) => inner.get(id),
    update: (r) =>
      failing && r.moves.at(-1)?.kind === "move"
        ? Promise.reject(new Error("store down"))
        : inner.update(r),
  };
  const logged = console.error;
  console.error = () => {};
  try {
    const { match } = await setup(seed, { store }).master.createMatch(
      "pass-race",
      HUMANS,
    );
    assertEquals(list(match), ["[1]"]); // stuck at the forced pass
    failing = false;
    // "Restart": a new Game master over the same store.
    const restarted = setup(seed, { store }).master;
    let view = await restarted.getMatch(match.id); // queues the pass
    for (let i = 0; i < 100 && view.moves.length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      view = await restarted.getMatch(match.id);
    }
    assertEquals(list(view), ["[1]", "pass", "[2]"]);
  } finally {
    console.error = logged;
  }
});

Deno.test("Engines are not asked to play a forced pass", async () => {
  const seed = await seedFor([1, 3]);
  const searched: string[] = [];
  const engines = new EngineRegistry([{
    id: "forward",
    name: "Forward",
    gameId: "pass-race",
    module: "unused:",
  }]);
  const { master } = setup(seed, { engines });
  const runner = new EngineRunner({
    adapter: {
      async *analyze(request: AnalysisRequest) {
        searched.push(request.position);
        yield {
          depth: 1,
          lines: [{ moves: ["f"], score: { kind: "value", value: 0 } }],
        };
      },
    },
  });
  const driver = new EngineDriver(master, { runner });
  const engine: Player = { kind: "engine", engineId: "forward", limits: {} };
  try {
    const { match } = await master.createMatch("pass-race", {
      a: engine,
      b: engine,
    });
    await driver.idle();
    const view = await master.getMatch(match.id);
    // a's pass was the Game master's; b searched once and played `f`.
    assertEquals(list(view).slice(0, 4), ["[1]", "pass", "[3]", "f"]);
    assertEquals(searched[0], "0:0:b:3"); // never "0:0:a:1", the pass
    assert(searched.every((p) => !p.endsWith(":1")), searched.join(" "));
  } finally {
    await driver.close();
  }
});

/** A store whose Move-list updates ending in a Move fail while `state.failing`. */
function flaky(inner = new InMemoryMatchStore()) {
  const state = { failing: true, attempts: 0 };
  const store: MatchStore = {
    create: (r) => inner.create(r),
    list: (q) => inner.list(q),
    get: (id) => inner.get(id),
    update: (r) => {
      if (state.failing && r.moves.at(-1)?.kind === "move") {
        state.attempts++;
        return Promise.reject(new Error("store down"));
      }
      return inner.update(r);
    },
  };
  return { store, state };
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const logged = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = logged;
  }
}

async function until(done: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200 && !(await done()); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

Deno.test("a pass that ends the Match sets the Outcome and no roll follows", async () => {
  const { master, events } = setup(await seedFor([1]));
  const { match } = await master.createMatch("end-pass", HUMANS);
  assertEquals(list(match), ["[1]", "pass"]);
  assertEquals(match.toMove, null);
  assertEquals(match.outcome, { kind: "rules", winner: "a", reason: "finish" });
  const last = events.at(-1)!;
  assertEquals(last.kind, "move");
  assertEquals(last.outcome, match.outcome);
});

Deno.test("a failing pass is retried, then waits out the cooldown", async () => {
  const seed = await seedFor([1, 2]);
  // Fails once, then the retry succeeds.
  const once = new InMemoryMatchStore();
  let failures = 0;
  const failOnce: MatchStore = {
    create: (r) => once.create(r),
    list: (q) => once.list(q),
    get: (id) => once.get(id),
    update: (r) =>
      r.moves.at(-1)?.kind === "move" && failures++ === 0
        ? Promise.reject(new Error("blip"))
        : once.update(r),
  };
  const retried = await quietly(async () => {
    const { master } = setup(seed, { store: failOnce, retryDelaysMs: [1] });
    return (await master.createMatch("pass-race", HUMANS)).match;
  });
  assertEquals(list(retried), ["[1]", "pass", "[2]"]);

  // Always fails: one cycle, then quiet during the cooldown, one more after.
  const down = flaky();
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const { master } = setup(seed, {
    store: down.store,
    retryDelaysMs: [],
    cooldownMs: 1000,
    now: () => new Date(clock),
  });
  await quietly(async () => {
    const { match } = await master.createMatch("pass-race", HUMANS);
    assertEquals(list(match), ["[1]"]);
    assertEquals(down.state.attempts, 1);
    for (let i = 0; i < 3; i++) await master.getMatch(match.id);
    await until(() => Promise.resolve(false)); // let queued heals run
    assertEquals(down.state.attempts, 1); // within the cooldown
    clock += 1001;
    await master.getMatch(match.id);
    await until(() => Promise.resolve(down.state.attempts > 1));
    assertEquals(down.state.attempts, 2);
  });
});

Deno.test("a Player may play the pass while the Game master's is queued", async () => {
  const seed = await seedFor([1, 2]);
  const { store, state } = flaky();
  const first = setup(seed, { store });
  const { match, tokens } = await quietly(() =>
    first.master.createMatch("pass-race", HUMANS)
  );
  assertEquals(list(match), ["[1]"]); // stuck at the forced pass
  state.failing = false;
  const { master } = setup(seed, { store });
  const healing = master.getMatch(match.id); // queues the Game master's pass
  const view = await master.apply(match.id, { token: tokens.a! }, {
    kind: "move",
    move: "pass",
  });
  await healing;
  await until(async () => (await master.getMatch(match.id)).version >= 4);
  const final = await master.getMatch(match.id);
  // One pass only, then the roll: the queued attempt found nothing to do.
  assertEquals(list(final), ["[1]", "pass", "[2]"]);
  assertEquals(view.moves.length >= 2, true);
});

Deno.test("Engine seats: a stuck forced pass is retried by the driver's re-checks", async () => {
  const seed = await seedFor([1, 3]);
  const { store, state } = flaky();
  const engines = new EngineRegistry([{
    id: "forward",
    name: "Forward",
    gameId: "pass-race",
    module: "unused:",
  }]);
  const { master } = setup(seed, { store, engines });
  const searched: string[] = [];
  const runner = new EngineRunner({
    adapter: {
      async *analyze(request: AnalysisRequest) {
        searched.push(request.position);
        yield {
          depth: 1,
          lines: [{ moves: ["f"], score: { kind: "value", value: 0 } }],
        };
      },
    },
  });
  const driver = new EngineDriver(master, { runner, passRecheckMs: 5 });
  const engine: Player = { kind: "engine", engineId: "forward", limits: {} };
  try {
    let id = "";
    await quietly(async () => {
      const { match } = await master.createMatch("pass-race", {
        a: engine,
        b: engine,
      });
      id = match.id;
      await driver.idle();
      assertEquals(list(match), ["[1]"]);
      assertEquals(searched, []); // no Engine search for the pass
      state.failing = false; // the store recovers; nobody polls the Match
      await until(async () => searched.length > 0);
      await driver.idle();
    });
    assertEquals(searched[0], "0:0:b:3");
    const view = await master.getMatch(id);
    assertEquals(list(view).slice(0, 4), ["[1]", "pass", "[3]", "f"]);
  } finally {
    await driver.close();
  }
});

Deno.test("resumeAll with a forced pass pending leaves it to the Game master", async () => {
  const seed = await seedFor([1, 3]);
  const { store, state } = flaky();
  const engines = new EngineRegistry([{
    id: "forward",
    name: "Forward",
    gameId: "pass-race",
    module: "unused:",
  }]);
  const engine: Player = { kind: "engine", engineId: "forward", limits: {} };
  const id = await quietly(async () => {
    const { master } = setup(seed, { store, engines });
    return (await master.createMatch("pass-race", { a: engine, b: engine }))
      .match.id;
  });
  state.failing = false;
  const { master } = setup(seed, { store, engines });
  const searched: string[] = [];
  const runner = new EngineRunner({
    adapter: {
      async *analyze(request: AnalysisRequest) {
        searched.push(request.position);
        yield {
          depth: 1,
          lines: [{ moves: ["f"], score: { kind: "value", value: 0 } }],
        };
      },
    },
  });
  const driver = new EngineDriver(master, { runner, passRecheckMs: 5 });
  try {
    await driver.resumeAll();
    await until(async () => (await master.getMatch(id)).moves.length >= 4);
    await driver.idle();
    assertEquals(searched[0], "0:0:b:3"); // never the pass Position
    assertEquals(list(await master.getMatch(id)).slice(0, 3), [
      "[1]",
      "pass",
      "[3]",
    ]);
  } finally {
    await driver.close();
  }
});
