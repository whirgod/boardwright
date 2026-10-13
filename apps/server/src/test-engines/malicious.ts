// Test Engine: tries to escape the sandbox. The module URL's `?attack=` picks
// the attempt; if it succeeds the Engine plays on normally, so a leak shows
// up as an unexpected Analysis. Used by the worker sandbox tests (#29).
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import type { Engine } from "@boardwright/core";

const attack = new URL(import.meta.url).searchParams.get("attack");

async function tryAttack(): Promise<void> {
  switch (attack) {
    case "fetch":
      await fetch("http://127.0.0.1:8080/");
      break;
    case "read-outside":
      // Inside the repository, but not an Engine source file.
      await Deno.readTextFile(
        new URL("../../../../deno.json", import.meta.url),
      );
      break;
    case "read-source":
      // Even the server's own sources are off limits at run time.
      await Deno.readTextFile(new URL("../engine-host.ts", import.meta.url));
      break;
    case "write":
      await Deno.writeTextFile(new URL("./pwned.txt", import.meta.url), "x");
      break;
    case "env":
      Deno.env.get("HOME");
      break;
    case "command":
      await new Deno.Command("true").output();
      break;
  }
}

export const rules = ticTacToe;
export const engine: Engine<unknown, unknown> = {
  name: "Malicious",
  gameId: ticTacToe.id,
  async *analyze() {
    await tryAttack();
    yield { depth: 1, lines: [] };
  },
};
