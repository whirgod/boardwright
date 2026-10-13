import { assert, assertEquals, assertThrows } from "@std/assert";
import type { GameRules } from "@boardwright/core";

export interface ContractOptions {
  /** PRNG seed; printed on failure so runs are reproducible. Default 1. */
  readonly seed?: number;
  /** Number of random playouts. Default 200. */
  readonly playouts?: number;
  /** Safety cap on plies per playout. Default 1000. */
  readonly maxPlies?: number;
  /** Extra strings that `decodePosition` / `decodeMove` must reject. */
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
 * playouts. Every Game package must call this from its tests. Failures are
 * prefixed with the game id and seed, and name the offending Move list.
 */
export function assertGameRulesContract<Position, Move>(
  rules: GameRules<Position, Move>,
  options: ContractOptions = {},
): void {
  const seed = options.seed ?? 1;
  const playouts = options.playouts ?? 200;
  const maxPlies = options.maxPlies ?? 1000;
  const garbage = [...DEFAULT_GARBAGE, ...(options.garbage ?? [])];
  const checkIllegal = options.checkIllegalMoves ?? true;
  const rand = seededRandom(seed);
  // Bounded, deduplicated pool of encoded Moves seen anywhere; a seeded sample
  // of it is probed in each Position, so the cost per Position is constant.
  const samples = options.illegalSamples ?? 8;
  const poolCap = options.illegalPoolSize ?? 256;
  const probeRand = seededRandom(seed ^ 0x9e3779b9);
  const movePool: string[] = [];
  const poolSet = new Set<string>();
  const addToPool = (text: string) => {
    if (poolSet.has(text)) return;
    if (movePool.length < poolCap) {
      movePool.push(text);
    } else {
      const i = Math.floor(probeRand() * poolCap);
      poolSet.delete(movePool[i] as string);
      movePool[i] = text;
    }
    poolSet.add(text);
  };
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
    } catch (e) {
      fail(
        `decode accepted garbage ${JSON.stringify(g)}: ${(e as Error).message}`,
      );
    }
  }

  let reachedTerminal = false;
  for (let i = 0; i < playouts; i++) {
    const moves: string[] = [];
    try {
      let position = rules.initialPosition();
      const history: string[] = [n.encodePosition(position)];
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
        if (checkIllegal) {
          const legalSet = new Set(legal.map((m) => n.encodeMove(m)));
          const sampled = new Set<string>();
          for (let k = 0; k < samples && movePool.length > 0; k++) {
            sampled.add(
              movePool[Math.floor(probeRand() * movePool.length)] as string,
            );
          }
          for (const text of sampled) {
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
          addToPool(text);
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
        moves.push(n.encodeMove(move));
        history.push(n.encodePosition(next));
        position = next;
      }

      // Determinism: replaying the Move list reproduces every Position.
      let replay = rules.initialPosition();
      const replayed: string[] = [n.encodePosition(replay)];
      for (const text of moves) {
        replay = rules.play(replay, n.decodeMove(text, replay));
        replayed.push(n.encodePosition(replay));
      }
      assertEquals(replayed, history, "replay diverged");
    } catch (e) {
      fail(`playout ${i} (moves: ${moves.join(" ")}): ${(e as Error).message}`);
    }
  }
  if (!reachedTerminal) fail("no playout reached a terminal position");
}
