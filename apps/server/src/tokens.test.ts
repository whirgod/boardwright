import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "@std/assert";
import { hashToken, newSeatToken, sameHash } from "./tokens.ts";

Deno.test("seat tokens are 256-bit random hex", () => {
  const a = newSeatToken();
  assertMatch(a, /^[0-9a-f]{64}$/);
  assertNotEquals(a, newSeatToken());
});

Deno.test("hashToken is hex SHA-256", async () => {
  assertEquals(
    await hashToken("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("sameHash compares whole strings", () => {
  assert(sameHash("abcd", "abcd"));
  assert(!sameHash("abcd", "abce"));
  assert(!sameHash("abcd", "xbcd"));
  assert(!sameHash("abcd", "abc"));
});
