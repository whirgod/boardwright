/**
 * Seat tokens: bearer secrets that let a human Player move for one Seat.
 * Only their SHA-256 hashes are stored, so a leaked store does not leak them.
 */

const TOKEN_BYTES = 32;

/** A fresh random seat token (64 hex characters). */
export function newSeatToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/** SHA-256 of `token`, hex-encoded. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compare two hashes without short-circuiting on the first differing character. */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
