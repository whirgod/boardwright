import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type ChanceGameRules,
  type GameRules,
  hasChance,
  pickChance,
} from "@boardwright/core";

export interface ContractOptions {
  /** PRNG seed; printed on failure so runs are reproducible. Default 1. */
  readonly seed?: number;
  /** Number of random playouts. Default 200. */
  readonly playouts?: number;
  /** Safety cap on plies per playout (Moves and Chance events). Default 1000. */
  readonly maxPlies?: number;
  /** Extra strings that `decodePosition` / `decodeMove` (/ `decodeChance`) must reject. */
  readonly garbage?: readonly string[];
  /** Check that `play` throws on Moves that are not legal. Default true. */
  readonly checkIllegalMoves?: boolean;
  /** Illegal-Move candidates sampled per Position. Default 8. */
  readonly illegalSamples?: number;
  /** Max size of the candidate Move pool (by Notation). Default 256. */
  readonly illegalPoolSize?: number;
}

const DEFAULT_GARBAGE = [
  "",
  " ",
  "garbage",
  "\u0000",
  "????",
  "null",
  "{}",
  "-1",
  "zz9:zz",
];

/** Tolerance for the sum of a Chance event's probabilities. */
const PROBABILITY_EPSILON = 1e-9;

/** mulberry32: small deterministic PRNG returning floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Checks that `rules` obeys the `GameRules` contract using seeded random
 * playouts. Every Game package without chance must call this from its tests
 * (Games with chance call {@link assertChanceGameRulesContract}). Failures
 * are prefixed with the game id and seed, and name the offending Move list.
 */
export function assertGameRulesContract<Position, Move>(
  rules: GameRules<Position, Move>,
  options: ContractOptions = {},
): void {
  if (hasChance(rules)) {
    throw new Error(
      `[contract ${rules.id}] has Chance events; use assertChanceGameRulesContract`,
    );
  }
  runContract(rules, undefined, options);
}

/**
 * Checks that `rules` obeys the `ChanceGameRules` contract (ADR 0005): the
 * whole `GameRules` contract with Chance events resolved at random by their
 * probabilities during playouts, plus: a pending Chance event (no Seat to
 * move, no Outcome) has no legal Moves and at least one result; results
 * encode uniquely and round-trip; probabilities are in (0, 1] and sum to 1;
 * every result resolves without mutating the Position; `chanceEvents` is
 * empty and `resolveChance` throws when nothing is pending; replaying Moves
 * and Chance events reproduces every Position; some playout meets a Chance
 * event. Every Game package with chance must call this from its tests.
 */
export function assertChanceGameRulesContract<Position, Move, Chance>(
  rules: ChanceGameRules<Position, Move, Chance>,
  options: ContractOptions = {},
): void {
  if (!hasChance(rules)) {
    throw new Error(
      `[contract ${
        (rules as GameRules<Position, Move>).id
      }] is not a ChanceGameRules (chanceEvents, resolveChance, encodeChance, decodeChance)`,
    );
  }
  runContract(rules, rules, options);
}

/** One step of a playout: a Move or a Chance event, in Notation. */
type Step = { readonly chance: boolean; readonly text: string };

const showSteps = (steps: readonly Step[]) =>
  steps.map((s) => (s.chance ? `[${s.text}]` : s.text)).join(" ");

/**
 * Bounded, deduplicated pool of encoded texts seen anywhere; a seeded sample
 * of it is probed in each Position, so the cost per Position is constant.
 */
function samplePool(cap: number, rand: () => number) {
  const items: string[] = [];
  const set = new Set<string>();
  return {
    add(text: string) {
      if (set.has(text)) return;
      if (items.length < cap) {
        items.push(text);
      } else {
        const i = Math.floor(rand() * cap);
        set.delete(items[i] as string);
        items[i] = text;
      }
      set.add(text);
    },
    sample(n: number): Set<string> {
      const sampled = new Set<string>();
      for (let k = 0; k < n && items.length > 0; k++) {
        sampled.add(items[Math.floor(rand() * items.length)] as string);
      }
      return sampled;
    },
  };
}

function runContract<Position, Move, Chance>(
  rules: GameRules<Position, Move>,
  chance: ChanceGameRules<Position, Move, Chance> | undefined,
  options: ContractOptions,
): void {
  const seed = options.seed ?? 1;
  const playouts = options.playouts ?? 200;
  const maxPlies = options.maxPlies ?? 1000;
  const garbage = [...DEFAULT_GARBAGE, ...(options.garbage ?? [])];
  const checkIllegal = options.checkIllegalMoves ?? true;
  const rand = seededRandom(seed);
  const samples = options.illegalSamples ?? 8;
  const poolCap = options.illegalPoolSize ?? 256;
  const probeRand = seededRandom(seed ^ 0x9e3779b9);
  const movePool = samplePool(poolCap, probeRand);
  const chancePool = samplePool(poolCap, probeRand);
  const n = rules.notation;
  const label = `[contract ${rules.id} seed=${seed}]`;
  const fail = (msg: string): never => {
    throw new Error(`${label} ${msg}`);
  };

  if (rules.seats.length < 1) fail("seats must not be empty");
  if (new Set(rules.seats).size !== rules.seats.length) {
    fail("seats must be unique");
  }

  const initial = rules.initialPosition();
  for (const g of garbage) {
    try {
      assertThrows(() => n.decodePosition(g));
      assertThrows(() => n.decodeMove(g, initial));
      if (chance) assertThrows(() => chance.notation.decodeChance(g, initial));
    } catch (e) {
      fail(
        `decode accepted garbage ${JSON.stringify(g)}: ${(e as Error).message}`,
      );
    }
  }

  /** Checks a pending Chance event and returns a result drawn by probability. */
  function checkChance(
    c: ChanceGameRules<Position, Move, Chance>,
    position: Position,
    encoded: string,
  ): Chance {
    const events = c.chanceEvents(position);
    assert(events.length >= 1, "pending Chance event has no results");
    const texts = events.map((e) => c.notation.encodeChance(e.chance));
    assertEquals(
      new Set(texts).size,
      texts.length,
      "chance results encode uniquely",
    );
    let sum = 0;
    for (const [i, { chance: result, probability }] of events.entries()) {
      const text = texts[i]!;
      assert(
        Number.isFinite(probability) && probability > 0 && probability <= 1,
        `chance ${text} has probability ${probability}, not in (0, 1]`,
      );
      sum += probability;
      chancePool.add(text);
      assertEquals(
        c.notation.encodeChance(c.notation.decodeChance(text, position)),
        text,
        "chance round trip",
      );
      const next = c.resolveChance(position, result);
      assertEquals(
        n.encodePosition(position),
        encoded,
        "resolveChance mutated its input position",
      );
      n.encodePosition(next);
    }
    assert(
      Math.abs(sum - 1) <= PROBABILITY_EPSILON,
      `chance probabilities sum to ${sum}, not 1`,
    );
    // Results seen elsewhere but not offered here must be refused.
    const offered = new Set(texts);
    for (const text of chancePool.sample(samples)) {
      if (offered.has(text)) continue;
      let candidate: Chance;
      try {
        candidate = c.notation.decodeChance(text, position);
      } catch {
        continue; // not even decodable in this Position
      }
      if (offered.has(c.notation.encodeChance(candidate))) continue;
      assertThrows(
        () => c.resolveChance(position, candidate),
        Error,
        undefined,
        `resolveChance accepted ${text}, which is not offered in ${encoded}`,
      );
      assertEquals(
        n.encodePosition(position),
        encoded,
        "failed resolveChance mutated its input position",
      );
    }
    return pickChance(events, rand());
  }

  let reachedTerminal = false;
  let reachedChance = false;
  for (let i = 0; i < playouts; i++) {
    const steps: Step[] = [];
    try {
      let position = rules.initialPosition();
      const visited: string[] = [n.encodePosition(position)];
      for (let ply = 0;; ply++) {
        assert(ply <= maxPlies, `playout exceeded maxPlies=${maxPlies}`);
        const encoded = n.encodePosition(position);
        assertEquals(
          n.encodePosition(n.decodePosition(encoded)),
          encoded,
          "position round trip",
        );

        const seat = rules.toMove(position);
        const outcome = rules.outcome(position);
        const legal = rules.legalMoves(position);
        // Pure queries: repeated calls agree.
        assertEquals(rules.toMove(position), seat, "toMove is not stable");
        assertEquals(
          JSON.stringify(rules.outcome(position)),
          JSON.stringify(outcome),
          "outcome is not stable",
        );
        assertEquals(
          rules.legalMoves(position).map((m) => n.encodeMove(m)),
          legal.map((m) => n.encodeMove(m)),
          "legalMoves is not stable",
        );
        const pending = chance !== undefined && seat === undefined &&
          outcome === undefined;
        if (chance) {
          const show = () =>
            chance.chanceEvents(position).map((e) =>
              `${chance.notation.encodeChance(e.chance)}@${e.probability}`
            );
          assertEquals(show(), show(), "chanceEvents is not stable");
        }
        if (pending) {
          assertEquals(legal.length, 0, "pending Chance event has legal moves");
          reachedChance = true;
          const result = checkChance(chance, position, encoded);
          const next = chance.resolveChance(position, result);
          steps.push({
            chance: true,
            text: chance.notation.encodeChance(result),
          });
          visited.push(n.encodePosition(next));
          position = next;
          continue;
        }
        if (chance) {
          assertEquals(
            chance.chanceEvents(position).length,
            0,
            "chanceEvents is not empty while no Chance event is pending",
          );
          for (const text of chancePool.sample(1)) {
            let candidate: Chance;
            try {
              candidate = chance.notation.decodeChance(text, position);
            } catch {
              continue;
            }
            assertThrows(
              () => chance.resolveChance(position, candidate),
              Error,
              undefined,
              `resolveChance accepted ${text} with no Chance event pending in ${encoded}`,
            );
          }
        }
        if (checkIllegal) {
          const legalSet = new Set(legal.map((m) => n.encodeMove(m)));
          for (const text of movePool.sample(samples)) {
            if (legalSet.has(text)) continue;
            let candidate: Move;
            try {
              candidate = n.decodeMove(text, position);
            } catch {
              continue; // not even decodable in this Position
            }
            if (legalSet.has(n.encodeMove(candidate))) continue;
            assertThrows(
              () => rules.play(position, candidate),
              Error,
              undefined,
              `play accepted illegal move ${text} in ${encoded}`,
            );
            assertEquals(
              n.encodePosition(position),
              encoded,
              "failed play mutated its input position",
            );
          }
        }
        assert(
          (seat === undefined) === (outcome !== undefined),
          "toMove is undefined iff outcome is defined",
        );
        if (seat === undefined) {
          assertEquals(legal.length, 0, "terminal position has legal moves");
          assert(outcome!.reason.length > 0, "outcome reason is empty");
          assert(
            outcome!.winner === undefined ||
              rules.seats.includes(outcome!.winner),
            "outcome winner is not a seat",
          );
          reachedTerminal = true;
          break;
        }
        assert(rules.seats.includes(seat), `toMove ${seat} is not a seat`);
        assert(legal.length >= 1, "non-terminal position has no legal moves");

        const encodedMoves = legal.map((m) => n.encodeMove(m));
        assertEquals(
          new Set(encodedMoves).size,
          encodedMoves.length,
          "legal moves encode uniquely",
        );
        for (const text of encodedMoves) {
          movePool.add(text);
          assertEquals(
            n.encodeMove(n.decodeMove(text, position)),
            text,
            "move round trip",
          );
        }

        const move = legal[Math.floor(rand() * legal.length)] as Move;
        const next = rules.play(position, move);
        assertEquals(
          n.encodePosition(position),
          encoded,
          "play mutated its input position",
        );
        steps.push({ chance: false, text: n.encodeMove(move) });
        visited.push(n.encodePosition(next));
        position = next;
      }

      // Determinism: replaying the Move list reproduces every Position.
      let replay = rules.initialPosition();
      const replayed: string[] = [n.encodePosition(replay)];
      for (const step of steps) {
        replay = step.chance
          ? chance!.resolveChance(
            replay,
            chance!.notation.decodeChance(step.text, replay),
          )
          : rules.play(replay, n.decodeMove(step.text, replay));
        replayed.push(n.encodePosition(replay));
      }
      assertEquals(replayed, visited, "replay diverged");
    } catch (e) {
      fail(
        `playout ${i} (moves: ${showSteps(steps)}): ${(e as Error).message}`,
      );
    }
  }
  if (!reachedTerminal) fail("no playout reached a terminal position");
  if (chance && !reachedChance) fail("no playout reached a Chance event");
}

export { assertEngineContract } from "./engine.ts";
export type { EngineContractOptions } from "./engine.ts";
export {
  DICE_RACE_GOAL,
  diceRace,
  type DiceRaceMove,
  type DiceRacePosition,
  type DiceRaceRoll,
} from "./dice-race.ts";
