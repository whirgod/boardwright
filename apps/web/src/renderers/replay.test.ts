// Seam-level invariant for the multi-click Games: replaying a legal Move's
// targets (`path` then `effects`) through `click` yields that Move, and the
// destination highlights after any selection are exactly the targets whose
// click advances it.
import { assertEquals } from "@std/assert";
import type { GameRules } from "@boardwright/core";
import { checkers } from "@boardwright/game-checkers";
import { chess } from "@boardwright/game-chess";
import { nineMensMorris } from "@boardwright/game-nine-mens-morris";
import { bindRenderer } from "./mod.ts";
import { clickOrder } from "./compose.ts";
import type { BoardRenderer, Selection } from "./board.ts";
import { checkersRenderer } from "./checkers.ts";
import { chessRenderer } from "./chess.ts";
import { nineMensMorrisRenderer } from "./nine-mens-morris.ts";

function check<P, M>(
  rules: GameRules<P, M>,
  renderer: BoardRenderer<P, M>,
  seed: number,
  plies: number,
  start?: P,
) {
  const view = bindRenderer(rules, renderer);
  const { notation } = rules;
  let state = seed;
  const random = (n: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return Math.floor(state / 65536) % n;
  };
  let position = start ?? rules.initialPosition();
  for (let ply = 0; ply < plies; ply++) {
    const legal = rules.legalMoves(position);
    if (legal.length === 0) return;
    const text = notation.encodePosition(position);
    const legalMoves = legal.map(notation.encodeMove);
    const request = (selection: Selection) => ({
      position: text,
      moves: [],
      legalMoves,
      selection,
    });
    const targets = renderer.scene(position).targets.map((t) => t.id);
    const checked = new Set<string>();
    for (const move of legal) {
      const clicks = clickOrder(renderer.moveTargets(move, position));
      for (let i = 0; i < clicks.length; i++) {
        const selection = clicks.slice(0, i);
        const key = selection.join(">");
        if (i > 0 && !checked.has(key)) {
          checked.add(key);
          const shown = view.board(request(selection)).highlights
            .filter((h) => h.kind === "destination").map((h) => h.target)
            .sort();
          const advancing = targets.filter((t) => {
            const c = view.click(request(selection), t);
            // Re-picking (a click that restarts the selection) is not an advance.
            if (c.kind === "move") {
              const done = clickOrder(
                renderer.moveTargets(
                  notation.decodeMove(c.move, position),
                  position,
                ),
              );
              return selection.every((s, j) => done[j] === s);
            }
            return c.kind === "select" && c.selection.length === i + 1 &&
              selection.every((s, j) => c.selection[j] === s);
          }).sort();
          assertEquals(shown, advancing);
        }
        assertEquals(
          view.click(request(selection), clicks[i]!),
          i < clicks.length - 1
            ? { kind: "select", selection: clicks.slice(0, i + 1) }
            : { kind: "move", move: notation.encodeMove(move) },
        );
      }
    }
    position = rules.play(position, legal[random(legal.length)]!);
  }
}

Deno.test("morris: click replay matches input and destination highlights", () => {
  for (const seed of [1, 2, 3]) {
    check(nineMensMorris, nineMensMorrisRenderer, seed, 60);
  }
});

Deno.test("checkers: click replay matches input and destination highlights", () => {
  for (const seed of [1, 2, 3]) {
    check(checkers, checkersRenderer, seed, 60);
  }
});

Deno.test("chess: click replay matches input and destination highlights", () => {
  for (const seed of [1, 2, 3]) {
    check(chess, chessRenderer, seed, 80);
  }
});

Deno.test("chess: click replay covers promotion and castling", () => {
  // Promotions and both castlings are legal in these Positions.
  for (
    const fen of [
      "r3k2r/1P4P1/8/8/8/8/8/R3K2R w KQkq - 0 1",
      "r3k2r/8/8/8/8/8/1p4p1/R3K2R b KQkq - 0 1",
    ]
  ) {
    check(chess, chessRenderer, 1, 1, chess.notation.decodePosition(fen));
  }
});
