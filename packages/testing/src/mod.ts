import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type ChanceGameRules,
  type GameRules,
  hasChance,
  pickChance,
  type Seat,
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
 *
 * Also checks that `decodePosition(encodePosition(p))` plays identically to
 * `p`: same Seat to move, Outcome and legal Moves (by `encodeMove`, in the
 * same order); with chance, the same Chance events too.
 *
 * If the Game supplies a `transpositionKey`, checks it too: it never throws,
 * returns a stable string, and is the same for a decoded Position; and
 * Positions without an Outcome that share a key, across all playouts, play
 * alike: same Seat to move and legal Moves in the same order (with chance,
 * the same Chance events), and each Move (Chance result) leads to Positions
 * that share a key again. Random playouts reach the same Position by
 * different Move orders, so this compares Positions with different histories.
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
 * Like the plain contract, it also requires decoded Positions to play
 * identically, and checks a `transpositionKey` (see
 * {@link assertGameRulesContract}).
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

/**
 * What the contract kit remembers about a Position per Transposition key: its
 * text, and how it plays (Moves and Chance events in Notation, in order).
 */
interface KeyedPosition {
  readonly encoded: string;
  readonly seat: Seat | undefined;
  readonly moves: string;
  readonly chance: string;
}

/** One step of a playout: a Move or a Chance event, in Notation. */
type Step = { readonly chance: boolean; readonly text: string };

/** Chance events of `position` as text, in order, with probabilities. */
const showChance = <Position, Move, Chance>(
  c: ChanceGameRules<Position, Move, Chance>,
  position: Position,
) =>
  c.chanceEvents(position).map((e) =>
    `${c.notation.encodeChance(e.chance)}@${e.probability}`
  );

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

  const transpositionKey = rules.transpositionKey === undefined
    ? undefined
    : (p: Position) => rules.transpositionKey!(p);
  // Per Transposition key, the first Position seen without an Outcome: what
  // an Engine assumes about every Position without an Outcome with that key.
  const byKey = new Map<string, KeyedPosition>();

  /**
   * Checks `transpositionKey` on `position` (see `GameRules`): it never
   * throws, returns a stable string, and is kept by decoding. Positions
   * without an Outcome that share it play alike: same Seat to move, legal
   * Moves in the same order and Chance events, and every Move (or Chance
   * result) leads to Positions that share their key again.
   */
  function checkTranspositionKey(
    keyOf: (p: Position) => string,
    position: Position,
    encoded: string,
    terminal: boolean,
    seat: Seat | undefined,
    legal: readonly Move[],
  ): void {
    let key: unknown;
    try {
      key = keyOf(position);
    } catch (e) {
      fail(`transpositionKey threw in ${encoded}: ${e}`);
    }
    assertEquals(
      typeof key,
      "string",
      `transpositionKey did not return a string in ${encoded}`,
    );
    assertEquals(keyOf(position), key, "transpositionKey is not stable");
    assertEquals(
      keyOf(n.decodePosition(encoded)),
      key,
      "decoded position has a different transpositionKey",
    );
    if (terminal) return; // equal keys may differ in Outcome
    const seen: KeyedPosition = {
      encoded,
      seat,
      moves: legal.map((m) => n.encodeMove(m)).join(" "),
      chance: chance ? showChance(chance, position).join(" ") : "",
    };
    const first = byKey.get(key as string);
    if (first === undefined) {
      byKey.set(key as string, seen);
      return;
    }
    if (first.encoded === encoded) return; // the same Position again
    const shared = `transpositionKey ${JSON.stringify(key)} is shared by ` +
      `${first.encoded} and ${encoded}`;
    const differs = first.seat !== seen.seat
      ? "Seat to move"
      : first.moves !== seen.moves
      ? "legalMoves (set or order)"
      : first.chance !== seen.chance
      ? "chanceEvents"
      : undefined;
    if (differs) fail(`${shared}, which have a different ${differs}`);
    // The same Moves (Chance results), by index, lead to the same keys.
    const earlier = n.decodePosition(first.encoded);
    const earlierMoves = rules.legalMoves(earlier);
    legal.forEach((move, i) => {
      const mine = keyOf(rules.play(position, move));
      if (keyOf(rules.play(earlier, earlierMoves[i]!)) !== mine) {
        fail(`${shared}, but ${n.encodeMove(move)} leads to different keys`);
      }
    });
    if (chance) {
      const events = chance.chanceEvents(position);
      const earlierEvents = chance.chanceEvents(earlier);
      events.forEach(({ chance: result }, i) => {
        const mine = keyOf(chance.resolveChance(position, result));
        const theirs = keyOf(
          chance.resolveChance(earlier, earlierEvents[i]!.chance),
        );
        if (theirs !== mine) {
          fail(
            `${shared}, but [${
              chance.notation.encodeChance(result)
            }] leads to different keys`,
          );
        }
      });
    }
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
        if (typeof rules.isPass === "function") {
          for (const move of legal) {
            const text = n.encodeMove(move);
            let marked: unknown;
            try {
              marked = rules.isPass(move);
            } catch (e) {
              fail(`isPass threw on ${text} in ${encoded}: ${e}`);
            }
            assertEquals(
              typeof marked,
              "boolean",
              `isPass is not total/boolean on ${text} in ${encoded}`,
            );
            if (marked) {
              assertEquals(
                legal.length,
                1,
                `pass ${text} is not the only legal Move in ${encoded}`,
              );
              assert(
                n.encodePosition(rules.play(position, move)) !== encoded,
                `pass ${text} leaves ${encoded} unchanged (must hand the turn on)`,
              );
            }
          }
        }
        const pending = chance !== undefined && seat === undefined &&
          outcome === undefined;
        if (chance) {
          assertEquals(
            showChance(chance, position),
            showChance(chance, position),
            "chanceEvents is not stable",
          );
        }
        // A decoded Position must play identically (transposition tables key
        // on the encoded text): same Seat, Outcome, legal Moves in order.
        {
          const q = n.decodePosition(encoded);
          assertEquals(
            rules.toMove(q),
            seat,
            "decoded position has a different toMove",
          );
          assertEquals(
            rules.outcome(q),
            outcome,
            "decoded position has a different outcome",
          );
          assertEquals(
            rules.legalMoves(q).map((m) => n.encodeMove(m)),
            legal.map((m) => n.encodeMove(m)),
            "decoded position has different legalMoves (set or order)",
          );
          if (chance) {
            assertEquals(
              showChance(chance, q),
              showChance(chance, position),
              "decoded position has different chanceEvents",
            );
          }
        }
        if (transpositionKey) {
          checkTranspositionKey(
            transpositionKey,
            position,
            encoded,
            outcome !== undefined,
            seat,
            legal,
          );
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
