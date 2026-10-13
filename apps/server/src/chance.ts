// How the Game master draws Chance events (ADR 0005): from a secret per-Match
// seed, the n-th draw being a pure function of (seed, n), so a revealed seed
// lets anyone check every roll of a finished Match. The draw selects a result
// with `pickChance` from `@boardwright/core`.

/** A new secret seed: 256 random bits, as 64 lowercase hex digits. */
export function newChanceSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The `n`-th draw (0-based: the Match's n-th Chance event) from `seed`, a
 * number in [0, 1): the first 48 bits (12 hex digits) of SHA-256 of the
 * UTF-8 text `"<seed>:<n>"` (n in decimal), as an integer, divided by 2^48.
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
