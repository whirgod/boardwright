/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />
/**
 * Worker entry: runs one Engine search per message. Only Notation strings and
 * plain limits cross the boundary (see `engine-search.ts` for the protocol).
 * Runs with no permissions; the Engine module is loaded by URL.
 */
import type { Engine, GameRules, SearchLimits } from "@boardwright/core";
import type { SearchReply, SearchRequest } from "./engine-search.ts";

interface EngineModule {
  readonly rules: GameRules<unknown, unknown>;
  readonly engine: Engine<unknown, unknown>;
}

async function search(request: SearchRequest): Promise<string> {
  const { rules, engine } = await import(request.module) as EngineModule;
  const position = rules.notation.decodePosition(request.position);
  const limits: SearchLimits = request.limits;
  let best: unknown;
  for await (const analysis of engine.analyze(position, limits)) {
    const move = analysis.lines[0]?.moves[0];
    if (move !== undefined) best = move;
  }
  if (best === undefined) throw new Error("Engine returned no Move");
  return rules.notation.encodeMove(best);
}

self.onmessage = async (event: MessageEvent<SearchRequest>) => {
  let reply: SearchReply;
  try {
    reply = { ok: true, move: await search(event.data) };
  } catch (error) {
    reply = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  self.postMessage(reply);
};
