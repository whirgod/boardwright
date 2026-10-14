#!/usr/bin/env -S deno run --no-prompt
/**
 * Test external Engine for tic-tac-toe (docs/external-engine-protocol.md),
 * misbehaving as its first argument says. Every search is answered with the
 * first legal Move, scored with the number of searches this process has run
 * (so tests can tell a reused process from a fresh one).
 *
 * Modes: `ok`; `exit-at-start` (exits before reading anything); `silent`
 * (never answers `hello`); `refuse` (`error` instead of `ready`);
 * `wrong-game`; `wrong-protocol`; `junk-hello` (a non-JSON line instead of
 * `ready`); `early-analysis` (an `analysis` instead of `ready`); `junk` /
 * `unknown-type` / `wrong-id` / `long-line` / `unterminated` / `bad-analysis` (in reply to
 * `analyze`); `error` (`error` for every other search); `exit-mid-search`
 * (one Analysis, then exits); `stream` (an Analysis every 10 ms until
 * `stop`, then `done`); `deaf` (streams like `stream` but ignores `stop`);
 * `send <json>` (answers with that Analysis); `name <text>` (announces that
 * name). Exits at the end of stdin.
 */
import { ticTacToe } from "@boardwright/game-tic-tac-toe";

const mode = Deno.args[0] ?? "ok";
const send = (message: unknown) => console.log(JSON.stringify(message));
let searches = 0;
let streaming: ReturnType<typeof setInterval> | undefined;

const analysis = (position: string) => {
  const moves = ticTacToe.legalMoves(
    ticTacToe.notation.decodePosition(position),
  );
  if (moves.length === 0) return { depth: 0, lines: [] };
  return {
    depth: 1,
    lines: [{ moves: [moves[0]], score: { kind: "value", value: searches } }],
  };
};

if (mode === "exit-at-start") Deno.exit(3);

let buffer = "";
for await (
  const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())
) {
  buffer += chunk;
  let end: number;
  while ((end = buffer.indexOf("\n")) >= 0) {
    handle(JSON.parse(buffer.slice(0, end)));
    buffer = buffer.slice(end + 1);
  }
}

// stdin closed: the server is gone (intervals would keep a `deno` process alive).
Deno.exit(0);

function handle(message: Record<string, unknown>) {
  const { id } = message;
  switch (message.type) {
    case "hello":
      switch (mode) {
        case "silent":
          return;
        case "refuse":
          return send({ type: "error", message: "not today" });
        case "junk-hello":
          return console.log("hello there");
        case "early-analysis":
          return send({ type: "analysis", id: 1, analysis: {} });
      }
      return send({
        type: "ready",
        protocol: mode === "wrong-protocol" ? 2 : 1,
        gameId: mode === "wrong-game" ? "chess" : message.gameId,
        name: mode === "name" ? Deno.args[1] : "External test",
      });
    case "analyze": {
      searches++;
      const reply = {
        type: "analysis",
        id,
        analysis: analysis(message.position as string),
      };
      switch (mode) {
        case "junk":
          return console.log("bestmove a1");
        case "unknown-type":
          return send({ type: "info", id });
        case "wrong-id":
          return send({ ...reply, id: (id as number) + 1 });
        case "long-line":
          return console.log("x".repeat((1 << 20) + 10));
        case "unterminated": {
          // Over 1 MiB in 64 KiB writes, no end of line.
          const chunk = new TextEncoder().encode("y".repeat(1 << 16));
          for (let i = 0; i < 17; i++) {
            for (let n = 0; n < chunk.length;) {
              n += Deno.stdout.writeSync(chunk.subarray(n));
            }
          }
          return;
        }
        case "bad-analysis":
          return send({
            type: "analysis",
            id,
            analysis: { depth: -1, lines: [] },
          });
        case "error":
          if (searches % 2 === 0) {
            return send({ type: "error", id, message: "cannot analyze" });
          }
          break;
        case "exit-mid-search":
          send(reply);
          return Deno.exit(4);
        case "stream":
        case "deaf":
          streaming = setInterval(() => send(reply), 10);
          return;
        case "send":
          // Sends the Analysis given as the second argument (JSON).
          send({ type: "analysis", id, analysis: JSON.parse(Deno.args[1]!) });
          return send({ type: "done", id });
      }
      send(reply);
      return send({ type: "done", id });
    }
    case "stop":
      if (mode === "deaf" || streaming === undefined) return;
      clearInterval(streaming);
      streaming = undefined;
      return send({ type: "done", id });
    case "quit":
      Deno.exit(0);
  }
}
