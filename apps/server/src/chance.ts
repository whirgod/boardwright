// How the Game master draws Chance events (ADR 0005): from a secret per-Match
// seed, the n-th draw being a pure function of (seed, n), so a revealed seed
// lets anyone check every roll of a finished Match.
import type { ChanceResult } from "@boardwright/core";

/** A new secret seed: 256 random bits, hex. */
export function newChanceSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The `n`-th draw (0-based: the Match's n-th Chance event) from `seed`, a
 * number in [0, 1): the first 48 bits of SHA-256 of `"<seed>:<n>"` (UTF-8),
 * divided by 2^48.
 */
export async function drawChance(seed: string, n: number): Promise<number> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${seed}:${n}`),
    ),
  );
  let value = 0;
  for (let i = 0; i < 6; i++) value = value * 256 + digest[i]!;
  return value / 2 ** 48;
}

/**
 * The result a draw `u` in [0, 1) selects: the first result whose cumulative
 * probability, in the Game's order, exceeds `u` (the last one if rounding
 * leaves `u` beyond the sum). `results` must not be empty.
 */
export function pickChance<Chance>(
  results: readonly ChanceResult<Chance>[],
  u: number,
): Chance {
  let rest = u;
  for (const { chance, probability } of results) {
    rest -= probability;
    if (rest < 0) return chance;
  }
  return results[results.length - 1]!.chance;
}
