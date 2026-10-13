import { assertEquals } from "@std/assert";
import { describeOutcome, seatLabel } from "./outcome.ts";

Deno.test("seatLabel capitalizes Seat ids", () => {
  assertEquals(seatLabel("x"), "X");
  assertEquals(seatLabel("white"), "White");
  assertEquals(seatLabel(""), "");
});

Deno.test("describeOutcome: winner or draw, with known reasons worded", () => {
  assertEquals(describeOutcome({ winner: "x", reason: "three-in-a-row" }), {
    headline: "X wins",
    detail: "three in a row",
  });
  assertEquals(describeOutcome({ reason: "board-full" }), {
    headline: "Draw",
    detail: "the board is full",
  });
});

Deno.test("describeOutcome: unknown reasons are shown as sent, not parsed", () => {
  const reason = "engine-failure: minimax for o: timeout";
  assertEquals(describeOutcome({ winner: "x", reason }), {
    headline: "X wins",
    detail: reason,
  });
});
