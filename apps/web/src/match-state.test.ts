import { assertEquals } from "@std/assert";
import type { MatchView, MoveListEntry } from "./api.ts";
import {
  analysisWanted,
  boardRequest,
  invites,
  matchStatus,
  moveListRows,
  playerLabel,
  seatPlayers,
} from "./match-state.ts";
import { playingTokens } from "./seat-tokens.ts";

const mv = (move: string): MoveListEntry => ({ kind: "move", move });
const roll = (chance: string): MoveListEntry => ({ kind: "chance", chance });

const MATCH: MatchView = {
  id: "m1",
  gameId: "tic-tac-toe",
  seats: { x: { kind: "human" }, o: { kind: "engine", engineId: "minimax" } },
  moves: [mv("a1")],
  position: "x........:o",
  toMove: "o",
  legalMoves: ["b2", "c3"],
  outcome: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
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
    outcome: { kind: "rules", winner: "x", reason: "three-in-a-row" } as const,
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
    moves: ["a1"],
    legalMoves: MATCH.legalMoves,
    selection: ["a"],
  });
  assertEquals(
    boardRequest(MATCH, matchStatus(MATCH, {}), []).legalMoves,
    [],
  );
});

Deno.test("boardRequest: an earlier Position is read-only and highlights its own last Move", () => {
  const mine = { ...MATCH, moves: [mv("a1"), mv("b2")], toMove: "x" };
  const status = matchStatus(mine, { x: "t" });
  assertEquals(
    boardRequest(mine, status, ["a"], { ply: 1, position: "x........:o" }),
    {
      position: "x........:o",
      moves: ["a1"],
      legalMoves: [],
      selection: [],
    },
  );
  // The last ply is the current Position again, playable.
  const current = boardRequest(mine, status, ["a"], { ply: 2, position: "?" });
  assertEquals(current.position, mine.position);
  assertEquals(current.legalMoves, mine.legalMoves);
  assertEquals(current.selection, ["a"]);
});

Deno.test("boardRequest: Analysis arrows and a previewed Line pass through", () => {
  const status = matchStatus(MATCH, {});
  assertEquals(
    boardRequest(MATCH, status, [], undefined, { arrows: ["b2", "c3"] })
      .arrows,
    ["b2", "c3"],
  );
  const previewed = boardRequest(MATCH, status, [], undefined, {
    arrows: [],
    preview: ["b2", "c3"],
  });
  assertEquals(previewed.arrows, []);
  assertEquals(previewed.preview, ["b2", "c3"]);
  assertEquals("arrows" in boardRequest(MATCH, status, []), false);
});

Deno.test("analysisWanted: off while playing a running Match, on otherwise, unless overridden", () => {
  const finished = {
    ...MATCH,
    outcome: { kind: "rules", winner: "x", reason: "three-in-a-row" } as const,
  };
  assertEquals(analysisWanted(MATCH, { x: "t" }, undefined), false);
  assertEquals(analysisWanted(MATCH, {}, undefined), true); // Spectator
  assertEquals(analysisWanted(finished, { x: "t" }, undefined), true);
  assertEquals(analysisWanted(null, { x: "t" }, undefined), false);
  assertEquals(analysisWanted(MATCH, { x: "t" }, true), true);
  assertEquals(analysisWanted(finished, {}, false), false);
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
  const afterOne = { ...fresh, moves: [mv("a1")], toMove: "o" };
  assertEquals(invites(afterOne, shared).map((i) => i.handedOver), [
    false,
    true,
  ]);
  assertEquals(
    invites({ ...afterOne, moves: [mv("a1"), mv("b2")] }, shared),
    [],
  );
  // Playing both Seats here (hot seat): nothing to offer once play started.
  assertEquals(invites(afterOne, both), []);
  // Holding one Seat, Engine Seats, finished Matches: nothing to offer.
  assertEquals(invites(fresh, { tokens: { x: "tx" }, handedOver: [] }), []);
  assertEquals(invites({ ...MATCH, moves: [] }, both), []);
  const finished = {
    ...fresh,
    toMove: null,
    outcome: { kind: "rules", reason: "board-full" } as const,
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
  assertEquals(moveListRows([mv("a1"), mv("b2"), mv("c3")]), [
    { number: 1, entries: [mv("a1"), mv("b2")], first: 0 },
    { number: 2, entries: [mv("c3")], first: 2 },
  ]);
});

Deno.test("moveListRows: a Chance event goes with the Move after it", () => {
  assertEquals(
    moveListRows([roll("3"), mv("f"), roll("1"), mv("1"), roll("2")]),
    [
      {
        number: 1,
        entries: [roll("3"), mv("f"), roll("1"), mv("1")],
        first: 0,
      },
      { number: 2, entries: [roll("2")], first: 4 },
    ],
  );
});

Deno.test("a Game with chance: status while rolling, board and invites count Moves only", () => {
  const rolling: MatchView = {
    ...MATCH,
    seats: { a: { kind: "human" }, b: { kind: "human" } },
    moves: [roll("2")],
    toMove: null,
  };
  assertEquals(matchStatus(rolling, { a: "ta" }), { kind: "chance" });
  const rolled = {
    ...rolling,
    moves: [roll("2"), mv("f"), roll("1")],
    toMove: "b",
  };
  assertEquals(
    boardRequest(rolled, matchStatus(rolled, {}), []).moves,
    ["f"],
  );
  const both = { tokens: { a: "ta", b: "tb" }, handedOver: [] };
  // The opening roll is no Move: Seats can still be handed over.
  assertEquals(
    invites({ ...rolling, toMove: "a" }, both).map((i) => i.canHandOver),
    [true, true],
  );
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
