import { assertEquals } from "@std/assert";
import type { MatchView } from "./api.ts";
import {
  boardRequest,
  matchStatus,
  moveListRows,
  playerLabel,
  seatPlayers,
  shareableSeats,
} from "./match-state.ts";

const MATCH: MatchView = {
  id: "m1",
  gameId: "tic-tac-toe",
  seats: { x: { kind: "human" }, o: { kind: "engine", engineId: "minimax" } },
  moves: ["a1"],
  position: "x........:o",
  toMove: "o",
  legalMoves: ["b2", "c3"],
  outcome: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

Deno.test("matchStatus: your Move when this browser holds the token of the human Seat to move", () => {
  const match = { ...MATCH, toMove: "x" };
  assertEquals(matchStatus(match, { x: "tx" }), {
    kind: "your-move",
    seat: "x",
    token: "tx",
  });
});

Deno.test("matchStatus: waiting for an Engine or the Opponent", () => {
  assertEquals(matchStatus(MATCH, { x: "tx" }), {
    kind: "waiting",
    seat: "o",
    player: { kind: "engine", engineId: "minimax" },
  });
  const human = { ...MATCH, toMove: "x" };
  assertEquals(matchStatus(human, {}), {
    kind: "waiting",
    seat: "x",
    player: { kind: "human" },
  });
  // A token for an Engine Seat does not let this browser move for it.
  assertEquals(matchStatus(MATCH, { o: "stale" }).kind, "waiting");
});

Deno.test("matchStatus: finished once the Match has an Outcome", () => {
  const match = {
    ...MATCH,
    toMove: null,
    outcome: { winner: "x", reason: "three-in-a-row" },
  };
  assertEquals(matchStatus(match, { x: "tx" }), {
    kind: "finished",
    outcome: { headline: "X wins", detail: "three in a row" },
  });
});

Deno.test("boardRequest: legal Moves only on your Move", () => {
  const mine = { ...MATCH, toMove: "x" };
  assertEquals(boardRequest(mine, matchStatus(mine, { x: "t" }), ["a"]), {
    position: MATCH.position,
    moves: MATCH.moves,
    legalMoves: MATCH.legalMoves,
    selection: ["a"],
  });
  assertEquals(
    boardRequest(MATCH, matchStatus(MATCH, {}), []).legalMoves,
    [],
  );
});

Deno.test("shareableSeats: human Seats while this browser holds more than one", () => {
  const humans = {
    ...MATCH,
    seats: { x: { kind: "human" }, o: { kind: "human" } },
  } as const;
  assertEquals(shareableSeats(humans, { x: "tx", o: "to" }), ["x", "o"]);
  // Holding one Seat: nothing to hand over.
  assertEquals(shareableSeats(humans, { x: "tx" }), []);
  // Engine Seats are never shared.
  assertEquals(shareableSeats(MATCH, { x: "tx", o: "to" }), []);
  const finished = {
    ...humans,
    toMove: null,
    outcome: { reason: "board-full" },
  };
  assertEquals(shareableSeats(finished, { x: "tx", o: "to" }), []);
});

Deno.test("moveListRows: pairs Moves under 1-based Move numbers", () => {
  assertEquals(moveListRows([]), []);
  assertEquals(moveListRows(["a1", "b2", "c3"]), [
    { number: 1, moves: ["a1", "b2"] },
    { number: 2, moves: ["c3"] },
  ]);
});

Deno.test("playerLabel: Human, or the Engine by name when known", () => {
  assertEquals(playerLabel({ kind: "human" }), "Human");
  assertEquals(
    playerLabel({ kind: "engine", engineId: "minimax" }),
    "Engine: minimax",
  );
  assertEquals(
    playerLabel(
      { kind: "engine", engineId: "minimax" },
      new Map([["minimax", "Minimax"]]),
    ),
    "Engine: Minimax",
  );
  assertEquals(playerLabel(undefined), "Unknown");
});

Deno.test("seatPlayers: human and Engine Seats, with optional thinking time", () => {
  assertEquals(seatPlayers({ x: "human", o: { engineId: "minimax" } }), {
    x: { kind: "human" },
    o: { kind: "engine", engineId: "minimax" },
  });
  assertEquals(seatPlayers({ x: { engineId: "a" } }, 250), {
    x: { kind: "engine", engineId: "a", limits: { maxTimeMs: 250 } },
  });
});
