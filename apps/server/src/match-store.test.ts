import { InMemoryMatchStore } from "./match-store.ts";
import { assertMatchStoreContract } from "./match-store.contract.ts";

Deno.test("InMemoryMatchStore satisfies the MatchStore contract", (t) =>
  assertMatchStoreContract(t, () => new InMemoryMatchStore()));
