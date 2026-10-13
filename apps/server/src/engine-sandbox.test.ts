import { assert, assertEquals } from "@std/assert";
import { EngineRunner, SearchError } from "./engine-runner.ts";
import { testWorkerAdapter } from "./engine-runner.testing.ts";
import type { EngineEntry } from "./engines.ts";

// Engine code runs in a worker with read of the Engine sources only (ADR 0006, #29): every
// escape attempt must surface as an `engine-error` (a Forfeit in a Match),
// while the Engine's own computation keeps working.

const malicious = (attack: string): EngineEntry => ({
  id: "malicious",
  name: "Malicious",
  gameId: "tic-tac-toe",
  module: import.meta.resolve(`./test-engines/malicious.ts?attack=${attack}`),
});

async function run(engine: EngineEntry): Promise<SearchError | undefined> {
  const runner = new EngineRunner({ adapter: testWorkerAdapter() });
  try {
    for await (
      const _ of runner.analyze({ engine, position: ".........:x", limits: {} })
    );
  } catch (error) {
    assert(error instanceof SearchError, String(error));
    return error;
  }
  return undefined;
}

Deno.test("sandbox: an Engine that attempts nothing runs normally", async () => {
  assertEquals(await run(malicious("none")), undefined);
});

for (
  const [attack, what] of [
    ["fetch", "net"],
    ["read-outside", "read"],
    ["read-source", "read"],
    ["write", "write"],
    ["env", "env"],
    ["command", "run"],
  ]
) {
  Deno.test(`sandbox: an Engine cannot use ${what} access (${attack})`, async () => {
    const error = await run(malicious(attack!));
    assert(error, `${attack} was not blocked`);
    assertEquals(error.code, "engine-error");
    assert(
      error.message.includes(`${what} access`),
      `unexpected message: ${error.message}`,
    );
  });
}
