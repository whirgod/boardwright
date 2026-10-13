import { assertEquals } from "@std/assert";
import type { MatchView } from "./api.ts";
import {
  boardRequest,
  invites,
  matchStatus,
  moveListRows,
  playerLabel,
  seatPlayers,
} from "./match-state.ts";
import { playingTokens } from "./seat-tokens.ts";

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

Deno.test("invites: hand over one of several human Seats before the first Move", () => {
  const fresh: MatchView = {
    ...MATCH,
    seats: { x: { kind: "human" }, o: { kind: "human" } },
    moves: [],
    toMove: "x",
  };
  const both = { tokens: { x: "tx", o: "to" }, handedOver: [] };
  assertEquals(invites(fresh, both), [
    { seat: "x", token: "tx", handedOver: false, canHandOver: true },
    { seat: "o", token: "to", handedOver: false, canHandOver: true },
  ]);
  // After handing O over, X cannot be given away too (one Seat stays here).
  const shared = { ...both, handedOver: ["o"] };
  assertEquals(invites(fresh, shared), [
    { seat: "x", token: "tx", handedOver: false, canHandOver: false },
    { seat: "o", token: "to", handedOver: true, canHandOver: false },
  ]);
  // The link stays visible after the first Move, until each Seat has moved.
  const afterOne = { ...fresh, moves: ["a1"], toMove: "o" };
  assertEquals(invites(afterOne, shared).map((i) => i.handedOver), [
    false,
    true,
  ]);
  assertEquals(invites({ ...afterOne, moves: ["a1", "b2"] }, shared), []);
  // Playing both Seats here (hot seat): nothing to offer once play started.
  assertEquals(invites(afterOne, both), []);
  // Holding one Seat, Engine Seats, finished Matches: nothing to offer.
  assertEquals(invites(fresh, { tokens: { x: "tx" }, handedOver: [] }), []);
  assertEquals(invites({ ...MATCH, moves: [] }, both), []);
  const finished = {
    ...fresh,
    toMove: null,
    outcome: { reason: "board-full" },
  };
  assertEquals(invites(finished, both), []);
});

Deno.test("matchStatus: a handed-over Seat is not played here", () => {
  const humans: MatchView = {
    ...MATCH,
    seats: { x: { kind: "human" }, o: { kind: "human" } },
  };
  const holding = { tokens: { x: "tx", o: "to" }, handedOver: ["o"] };
  assertEquals(matchStatus(humans, playingTokens(holding)), {
    kind: "waiting",
    seat: "o",
    player: { kind: "human" },
  });
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
