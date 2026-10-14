import { assertEquals } from "@std/assert";
import type { MoveListEntry } from "./api.ts";
import { entryLabels } from "./move-labels.ts";

const moves = (...m: string[]): MoveListEntry[] =>
  m.map((move) => ({ kind: "move", move }));

Deno.test("chess Moves are shown in SAN", () => {
  assertEquals(
    entryLabels("chess", moves("e2e4", "e7e5", "g1f3", "b8c6", "f1b5")),
    ["e4", "e5", "Nf3", "Nc6", "Bb5"],
  );
});

Deno.test("chess SAN covers captures, castling and mate", () => {
  assertEquals(
    entryLabels("chess", moves("f2f3", "e7e5", "g2g4", "d8h4")).slice(3),
    ["Qh4#"],
  );
  assertEquals(
    entryLabels(
      "chess",
      moves(
        "e2e4",
        "d7d5",
        "e4d5",
        "g8f6",
        "f1e2",
        "c8d7",
        "g1f3",
        "d7c8",
        "e1g1",
      ),
    ).slice(2),
    ["exd5", "Nf6", "Be2", "Bd7", "Nf3", "Bc8", "O-O"],
  );
});

Deno.test("a Move that does not replay keeps Notation, and so do later ones", () => {
  assertEquals(
    entryLabels("chess", moves("e2e4", "e2e4", "g1f3")),
    ["e4", "e2e4", "g1f3"],
  );
});

Deno.test("Games without a formatter show Notation", () => {
  assertEquals(
    entryLabels("tic-tac-toe", [
      { kind: "move", move: "b2" },
      { kind: "chance", chance: "3-4" },
    ]),
    ["b2", "3-4"],
  );
});
