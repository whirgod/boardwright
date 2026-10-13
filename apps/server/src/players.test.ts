import { assertEquals, assertMatch } from "@std/assert";
import { MAX_SEARCH_TIME_MS, parsePlayer } from "./players.ts";

function problem(value: unknown): string {
  const parsed = parsePlayer(value);
  if (parsed.ok) throw new Error("expected a problem");
  return parsed.problem;
}

Deno.test("parses humans and Engines", () => {
  assertEquals(parsePlayer({ kind: "human" }), {
    ok: true,
    player: { kind: "human" },
  });
  assertEquals(
    parsePlayer({
      kind: "engine",
      engineId: "minimax",
      limits: { maxDepth: 3, maxTimeMs: 50, lines: 2 },
    }),
    {
      ok: true,
      player: {
        kind: "engine",
        engineId: "minimax",
        limits: { maxDepth: 3, maxTimeMs: 50, lines: 2 },
      },
    },
  );
  // Limits are optional and default to none.
  assertEquals(parsePlayer({ kind: "engine", engineId: "m" }), {
    ok: true,
    player: { kind: "engine", engineId: "m", limits: {} },
  });
});

Deno.test("rejects malformed Players", () => {
  assertMatch(problem(null), /object/);
  assertMatch(problem([]), /object/);
  assertMatch(problem({ kind: "robot" }), /unknown Player kind/);
  assertMatch(problem({ kind: "human", extra: 1 }), /unexpected/);
  assertMatch(problem({ kind: "engine" }), /engineId/);
  assertMatch(problem({ kind: "engine", engineId: "" }), /engineId/);
  assertMatch(problem({ kind: "engine", engineId: "m", x: 1 }), /unexpected/);
});

Deno.test("rejects bad limits", () => {
  const bad = (limits: unknown) =>
    problem({ kind: "engine", engineId: "m", limits });
  assertMatch(bad("deep"), /limits/);
  assertMatch(bad([]), /limits/);
  assertMatch(bad({ depth: 1 }), /unexpected/);
  assertMatch(bad({ maxDepth: 0 }), /maxDepth/);
  assertMatch(bad({ maxDepth: 1.5 }), /maxDepth/);
  assertMatch(bad({ maxDepth: "3" }), /maxDepth/);
  assertMatch(bad({ maxTimeMs: -1 }), /maxTimeMs/);
  assertMatch(bad({ maxTimeMs: MAX_SEARCH_TIME_MS + 1 }), /maxTimeMs/);
  assertMatch(bad({ maxTimeMs: NaN }), /maxTimeMs/);
  assertMatch(bad({ lines: 0 }), /lines/);
});
