import type { ChanceGameRules, ChanceResult, Seat } from "@boardwright/core";

/**
 * A tiny Game with chance, for testing chance support (ADR 0005) without a
 * real Game: two Seats race their counters from 0 to {@link DICE_RACE_GOAL}.
 * Every turn starts with a Chance event, the roll of an uneven die (1 with
 * probability 1/2, 2 and 3 with 1/4 each), including the opening one. The
 * Seat to move then plays `f` (forward by the roll) or `1` (forward by one).
 * Reaching the goal wins ("finish").
 *
 * Notation: Position `a:b:turn:roll` (roll `-` while the die is pending),
 * e.g. `0:0:a:-`; Moves `f` and `1`; chance results `1`, `2`, `3`.
 */
export interface DiceRacePosition {
  readonly a: number;
  readonly b: number;
  readonly turn: "a" | "b";
  /** The roll to play, or `null` while it is pending. */
  readonly roll: 1 | 2 | 3 | null;
}
export type DiceRaceMove = "f" | "1";
export type DiceRaceRoll = 1 | 2 | 3;

export const DICE_RACE_GOAL = 6;

const ROLLS: readonly ChanceResult<DiceRaceRoll>[] = [
  { chance: 1, probability: 0.5 },
  { chance: 2, probability: 0.25 },
  { chance: 3, probability: 0.25 },
];

function winner(p: DiceRacePosition): Seat | undefined {
  if (p.a >= DICE_RACE_GOAL) return "a";
  if (p.b >= DICE_RACE_GOAL) return "b";
  return undefined;
}

export const diceRace: ChanceGameRules<
  DiceRacePosition,
  DiceRaceMove,
  DiceRaceRoll
> = {
  id: "dice-race",
  name: "Dice race",
  seats: ["a", "b"],
  initialPosition: () => ({ a: 0, b: 0, turn: "a", roll: null }),
  toMove: (p) =>
    winner(p) === undefined && p.roll !== null ? p.turn : undefined,
  legalMoves: (p) =>
    winner(p) === undefined && p.roll !== null ? ["f", "1"] : [],
  play(p, move) {
    if (!diceRace.legalMoves(p).includes(move)) {
      throw new Error(`illegal Move ${move}`);
    }
    const step = move === "f" ? p.roll! : 1;
    return {
      a: p.turn === "a" ? p.a + step : p.a,
      b: p.turn === "b" ? p.b + step : p.b,
      turn: p.turn === "a" ? "b" : "a",
      roll: null,
    };
  },
  outcome(p) {
    const won = winner(p);
    return won === undefined ? undefined : { winner: won, reason: "finish" };
  },
  chanceEvents: (p) => winner(p) === undefined && p.roll === null ? ROLLS : [],
  resolveChance(p, roll) {
    if (diceRace.chanceEvents(p).every((r) => r.chance !== roll)) {
      throw new Error(`no roll ${roll} is pending`);
    }
    return { ...p, roll };
  },
  notation: {
    encodePosition: (p) => `${p.a}:${p.b}:${p.turn}:${p.roll ?? "-"}`,
    decodePosition(text) {
      const m = /^([0-8]):([0-8]):([ab]):([123-])$/.exec(text);
      if (!m) throw new Error(`bad Position ${JSON.stringify(text)}`);
      return {
        a: Number(m[1]),
        b: Number(m[2]),
        turn: m[3] as "a" | "b",
        roll: m[4] === "-" ? null : Number(m[4]) as DiceRaceRoll,
      };
    },
    encodeMove: (move) => move,
    decodeMove(text) {
      if (text !== "f" && text !== "1") {
        throw new Error(`bad Move ${JSON.stringify(text)}`);
      }
      return text;
    },
    encodeChance: (roll) => String(roll),
    decodeChance(text) {
      if (!/^[123]$/.test(text)) {
        throw new Error(`bad roll ${JSON.stringify(text)}`);
      }
      return Number(text) as DiceRaceRoll;
    },
  },
};
