import { assertEquals } from "@std/assert";
import { describeOutcome, seatLabel } from "./outcome.ts";

Deno.test("seatLabel capitalizes Seat ids", () => {
  assertEquals(seatLabel("x"), "X");
  assertEquals(seatLabel("white"), "White");
  assertEquals(seatLabel(""), "");
});

Deno.test("describeOutcome: by the rules, winner or draw, known reasons worded", () => {
  assertEquals(
    describeOutcome({ kind: "rules", winner: "x", reason: "three-in-a-row" }),
    { headline: "X wins", detail: "three in a row" },
  );
  assertEquals(describeOutcome({ kind: "rules", reason: "board-full" }), {
    headline: "Draw",
    detail: "the board is full",
  });
  assertEquals(describeOutcome({ kind: "rules", reason: "mill-blocked" }), {
    headline: "Draw",
    detail: "mill-blocked",
  });
});

Deno.test("describeOutcome: Resignation names the Seat that resigned", () => {
  assertEquals(
    describeOutcome({ kind: "resignation", winner: "o", seat: "x" }),
    { headline: "O wins", detail: "X resigned" },
  );
});

Deno.test("describeOutcome: Forfeit names the Seat and words known codes", () => {
  assertEquals(
    describeOutcome({
      kind: "forfeit",
      winner: "x",
      seat: "o",
      reason: "timeout",
    }),
    { headline: "X wins", detail: "O forfeited: ran out of time" },
  );
  assertEquals(
    describeOutcome({
      kind: "forfeit",
      winner: "x",
      seat: "o",
      reason: "new-code",
    }),
    { headline: "X wins", detail: "O forfeited: new-code" },
  );
});
