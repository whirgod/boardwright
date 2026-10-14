#!/usr/bin/env -S deno run --no-prompt
/**
 * A tiny external Engine (docs/external-engine-protocol.md): plays a random
 * legal Move, for any Game Boardwright hosts. It speaks the protocol over
 * stdin/stdout, one JSON message per line, and runs with no Deno permissions
 * at all (the shebang grants none; it only needs stdin and stdout).
 *
 * It answers every search with one depth-1 Analysis: `limits.lines` distinct
 * random Moves, each scored 0. A real Engine would search deeper while
 * `limits.maxTimeMs` allows and stream an Analysis per completed depth.
 *
 * Run by the server as a configured external Engine, e.g. with
 * `examples/random-engine/external-engines.json`. Running this file directly
 * (shebang, `env -S`) works on Linux and macOS; elsewhere configure
 * `"command": "deno", "args": ["run", "--no-prompt", "./random-engine.ts"]`
 * (see the spec on the broader `--allow-run=deno` that needs).
 */
import {
  type Analysis,
  chancePending,
  type GameRules,
  type SearchLimits,
} from "@boardwright/core";
import { backgammon } from "@boardwright/game-backgammon";
import { checkers } from "@boardwright/game-checkers";
import { chess } from "@boardwright/game-chess";
import { nineMensMorris } from "@boardwright/game-nine-mens-morris";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";

type AnyRules = GameRules<unknown, unknown>;

const GAMES = new Map<string, AnyRules>(
  [backgammon, checkers, chess, nineMensMorris, ticTacToe].map((
    rules,
  ) => [rules.id, rules as unknown as AnyRules]),
);

/** Writes one protocol message (a JSON line) to stdout. */
const send = (message: Record<string, unknown>) =>
  console.log(JSON.stringify(message));

function analyze(
  rules: AnyRules,
  text: string,
  limits: SearchLimits,
): Analysis<string> {
  const position = rules.notation.decodePosition(text);
  if (rules.outcome(position) !== undefined) return { depth: 0, lines: [] };
  if (chancePending(rules, position)) {
    // A Chance event is pending: no Lines, only an expected Score.
    return {
      depth: 1,
      lines: [],
      score: { kind: "value", value: 0 },
      seat: rules.seats[0]!,
    };
  }
  const moves = [...rules.legalMoves(position)];
  for (let i = moves.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [moves[i], moves[j]] = [moves[j], moves[i]];
  }
  return {
    depth: 1,
    lines: moves.slice(0, limits.lines ?? 1).map((move) => ({
      moves: [rules.notation.encodeMove(move)],
      score: { kind: "value", value: 0 },
    })),
  };
}

let rules: AnyRules | undefined;

async function* lines(stream: ReadableStream<Uint8Array>) {
  let buffer = "";
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
    }
  }
}

for await (const line of lines(Deno.stdin.readable)) {
  if (line.trim() === "") continue;
  const message = JSON.parse(line);
  switch (message.type) {
    case "hello":
      rules = GAMES.get(message.gameId);
      if (message.protocol !== 1 || rules === undefined) {
        send({ type: "error", message: `cannot play ${message.gameId}` });
      } else {
        send({
          type: "ready",
          protocol: 1,
          gameId: rules.id,
          name: "Random mover",
        });
      }
      break;
    case "analyze":
      // Searches here are instant, so a later `stop` always finds the search
      // finished and is ignored.
      try {
        const analysis = analyze(rules!, message.position, message.limits);
        send({ type: "analysis", id: message.id, analysis });
        send({ type: "done", id: message.id });
      } catch (error) {
        send({ type: "error", id: message.id, message: String(error) });
      }
      break;
    case "quit":
      Deno.exit(0);
  }
}
// stdin closed: the server is gone.
