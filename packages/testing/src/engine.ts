import {
  type Analysis,
  chancePending,
  type Engine,
  type GameRules,
  hasChance,
  pickChance,
  type Score,
  type SearchLimits,
} from "@boardwright/core";
import { seededRandom } from "./mod.ts";

export interface EngineContractOptions<Position = unknown> {
  /** PRNG seed for sampling Positions; printed on failure. Default 1. */
  readonly seed?: number;
  /** Number of non-terminal Positions to analyze. Default 8. */
  readonly positions?: number;
  /** Depth cap used on sampled Positions, to keep big Games cheap. Default 3. */
  readonly maxDepth?: number;
  /** Safety cap on plies when walking to sample Positions. Default 1000. */
  readonly maxPlies?: number;
  /** Longest one `next()` may take before the Engine counts as hung. Default 10000. */
  readonly stepTimeoutMs?: number;
  /** How far past `maxTimeMs` or an abort the Engine may run. Default 1000. */
  readonly slackMs?: number;
  /**
   * Terminal Positions to check (a Game whose random playouts rarely end, such
   * as chess, must supply one). Default: found by random playouts; the check
   * fails if none is found or given.
   */
  readonly terminalPositions?: readonly Position[];
}

/**
 * Orders Scores from the Seat-to-move's view: positive when `a` is better than
 * `b`. Wins beat values beat losses; sooner wins and later losses are better.
 */
function compareScores(a: Score, b: Score): number {
  const klass = (s: Score) =>
    s.kind === "win-in" ? 2 : s.kind === "value" ? 1 : 0;
  if (klass(a) !== klass(b)) return klass(a) - klass(b);
  if (a.kind === "win-in" && b.kind === "win-in") return b.plies - a.plies;
  if (a.kind === "loss-in" && b.kind === "loss-in") return a.plies - b.plies;
  if (a.kind === "value" && b.kind === "value") return a.value - b.value;
  return 0;
}

function wellFormed(s: Score): boolean {
  return s.kind === "value"
    ? Number.isFinite(s.value)
    : (s.kind === "win-in" || s.kind === "loss-in") &&
      Number.isInteger(s.plies) && s.plies >= 1;
}

/**
 * Checks that `engine` obeys the `Engine.analyze` contract for `rules`:
 * invalid limits throw a RangeError synchronously; only completed depths
 * (strictly increasing, from 1) are yielded; a terminal Position yields exactly one depth-0
 * Analysis; at least one Analysis despite `maxTimeMs` (time counts from the
 * first `next()`); every Line is a legal Move sequence with a well-formed
 * Score, best Lines first, distinct first Moves; time limits and aborts are
 * honoured. Every Engine package must call this from its tests.
 *
 * For a Game with chance (`hasChance(rules)`), sampling walks resolve Chance
 * events at random by their probabilities, Lines must end at the next Chance
 * event, and a Position with a pending Chance event must yield Analyses with
 * no Lines, a well-formed expected `score` and its perspective `seat` (one of
 * the Game's Seats) (ADR 0005). Every other Analysis has neither `score` nor
 * `seat`.
 */
export async function assertEngineContract<Position, Move>(
  engine: Engine<Position, Move>,
  rules: GameRules<Position, Move>,
  options: EngineContractOptions<Position> = {},
): Promise<void> {
  const seed = options.seed ?? 1;
  const sampleCount = options.positions ?? 8;
  const depthCap = options.maxDepth ?? 3;
  const maxPlies = options.maxPlies ?? 1000;
  const stepTimeout = options.stepTimeoutMs ?? 10_000;
  const slack = options.slackMs ?? 1000;
  const n = rules.notation;
  const label = `[engine-contract ${engine.name} seed=${seed}]`;
  const fail = (msg: string): never => {
    throw new Error(`${label} ${msg}`);
  };
  const check = (ok: boolean, msg: string) => {
    if (!ok) fail(msg);
  };
  const show = (p: Position) => n.encodePosition(p);
  const moveText = (m: Move) => n.encodeMove(m);

  check(engine.name.length > 0, "engine name is empty");
  check(
    engine.gameId === rules.id,
    `gameId ${engine.gameId} does not match rules ${rules.id}`,
  );

  /** Steps `it`, failing if one step takes longer than `ms`. */
  async function step(
    it: AsyncIterator<Analysis<Move>>,
    ms: number,
    what: string,
  ): Promise<IteratorResult<Analysis<Move>>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} ${what}: no result within ${ms}ms`)),
        ms,
      );
    });
    try {
      return await Promise.race([it.next(), hung]);
    } finally {
      clearTimeout(timer);
    }
  }

  const close = (it: AsyncIterator<Analysis<Move>>) => {
    void it.return?.()?.catch(() => {});
  };

  async function drain(
    position: Position,
    limits: SearchLimits,
    what: string,
    signal?: AbortSignal,
    totalMs?: number,
  ): Promise<Analysis<Move>[]> {
    const it = engine.analyze(position, limits, signal)[Symbol.asyncIterator]();
    const all: Analysis<Move>[] = [];
    const deadline = performance.now() + (totalMs ?? Infinity);
    try {
      for (;;) {
        const left = Math.min(
          stepTimeout,
          Math.max(1, deadline - performance.now()),
        );
        const r = await step(it, left, what);
        if (r.done) return all;
        all.push(r.value);
        if (performance.now() > deadline) {
          fail(`${what}: stream still yielding after ${totalMs}ms`);
        }
      }
    } finally {
      close(it);
    }
  }

  // Invalid limits throw a RangeError synchronously from analyze().
  const initial = rules.initialPosition();
  const badLimits: SearchLimits[] = [
    { maxDepth: 0 },
    { maxDepth: -1 },
    { maxDepth: 1.5 },
    { maxDepth: NaN },
    { maxTimeMs: -1 },
    { maxTimeMs: NaN },
    { lines: 0 },
    { lines: 1.5 },
    { lines: NaN },
  ];
  for (const bad of badLimits) {
    let thrown: unknown;
    try {
      engine.analyze(initial, bad);
    } catch (e) {
      thrown = e;
    }
    check(
      thrown instanceof RangeError,
      `analyze(${JSON.stringify(bad)}) must throw a RangeError synchronously; ${
        thrown === undefined ? "it did not throw" : `got ${thrown}`
      }`,
    );
  }

  // Sample Positions with seeded random walks from the initial Position.
  const rand = seededRandom(seed);
  const sampled = new Map<string, Position>();
  let terminal: Position | undefined;
  const pending = (p: Position) => chancePending(rules, p);
  const walkTo = (stopAt: number): Position | undefined => {
    let p = rules.initialPosition();
    for (let ply = 0; ply < maxPlies; ply++) {
      if (rules.outcome(p) !== undefined) {
        terminal ??= p;
        return undefined;
      }
      if (ply >= stopAt) return p;
      if (hasChance(rules) && pending(p)) {
        // Resolve the Chance event at random, by its probabilities.
        p = rules.resolveChance(p, pickChance(rules.chanceEvents(p), rand()));
        continue;
      }
      const legal = rules.legalMoves(p);
      p = rules.play(p, legal[Math.floor(rand() * legal.length)] as Move);
    }
    return undefined;
  };
  for (let w = 0; w < sampleCount * 4 && sampled.size < sampleCount; w++) {
    const p = walkTo(Math.floor(rand() * 12));
    if (p !== undefined) sampled.set(show(p), p);
  }
  check(sampled.size > 0, "could not sample any non-terminal Position");
  check(
    !hasChance(rules) || [...sampled.values()].some(pending),
    "could not sample a Position with a pending Chance event",
  );
  // A full playout, so a terminal Position is covered whenever one is reachable.
  for (let w = 0; w < 20 && terminal === undefined; w++) walkTo(maxPlies);
  const terminals = options.terminalPositions ??
    (terminal === undefined ? [] : [terminal]);
  check(
    terminals.length > 0,
    "no terminal Position found by random playouts; pass `terminalPositions`",
  );

  // A terminal Position yields exactly one { depth: 0, lines: [] }.
  for (const terminal of terminals) {
    for (const limits of [{}, { maxDepth: 2 }, { maxTimeMs: 0 }]) {
      const got = await drain(terminal, limits, "terminal Position");
      const where = `terminal Position ${show(terminal)} with ${
        JSON.stringify(limits)
      }`;
      check(
        got.length === 1,
        `${where}: expected 1 Analysis, got ${got.length}`,
      );
      check(
        got[0]!.depth === 0 && got[0]!.lines.length === 0,
        `${where}: expected { depth: 0, lines: [] }, got ${
          JSON.stringify(got[0])
        }`,
      );
    }
  }

  // Non-terminal Positions.
  const limitSets: SearchLimits[] = [
    { maxDepth: depthCap },
    { maxDepth: depthCap, lines: 3 },
    { maxTimeMs: 0, maxDepth: depthCap },
  ];
  for (const [text, position] of sampled) {
    for (const limits of limitSets) {
      const where = `Position ${text} with ${JSON.stringify(limits)}`;
      const got = await drain(position, limits, where);
      check(got.length >= 1, `${where}: no Analysis yielded`);
      const wanted = limits.lines ?? 1;
      const depths = got.map((x) => x.depth).join(",");
      got.forEach((a, i) => {
        const at = `${where}, depth ${a.depth}`;
        check(
          Number.isInteger(a.depth) && a.depth >= 1 &&
            (i === 0 || a.depth > got[i - 1]!.depth),
          `${where}: depths must be integers >= 1 and strictly increasing, got ${depths}`,
        );
        check(
          a.depth <= (limits.maxDepth ?? Infinity),
          `${at}: exceeds maxDepth`,
        );
        if (a.score !== undefined) {
          check(
            wellFormed(a.score),
            `${at}: malformed expected Score ${JSON.stringify(a.score)}`,
          );
        }
        check(
          (a.seat === undefined) === (a.score === undefined),
          `${at}: seat must be present exactly when score is`,
        );
        if (pending(position)) {
          check(
            a.lines.length === 0,
            `${at}: a pending Chance event has no Lines, got ${a.lines.length}`,
          );
          check(
            a.score !== undefined,
            `${at}: a pending Chance event needs an expected score`,
          );
          check(
            rules.seats.includes(a.seat!),
            `${at}: seat ${
              JSON.stringify(a.seat)
            } is not one of the Game's Seats`,
          );
          return;
        }
        check(
          a.score === undefined,
          `${at}: score is only for a pending Chance event (Lines carry the Scores)`,
        );
        check(
          a.lines.length >= 1 && a.lines.length <= wanted,
          `${at}: ${a.lines.length} Lines, expected 1..${wanted}`,
        );
        const firsts = new Set<string>();
        let previous: Score | undefined;
        for (const line of a.lines) {
          const played = line.moves.map(moveText).join(" ");
          check(line.moves.length >= 1, `${at}: Line has no Moves`);
          const s = line.score;
          check(wellFormed(s), `${at}: malformed Score ${JSON.stringify(s)}`);
          check(
            previous === undefined || compareScores(previous, s) >= 0,
            `${at}: Lines are not best first (${
              JSON.stringify(a.lines.map((l) => l.score))
            })`,
          );
          previous = s;
          let p = position;
          for (const move of line.moves) {
            const m = moveText(move);
            check(
              !pending(p),
              `${at}: Line [${played}] continues past a Chance event with ${m}`,
            );
            check(
              rules.toMove(p) !== undefined &&
                rules.legalMoves(p).some((x) => moveText(x) === m),
              `${at}: Line [${played}] has illegal Move ${m}`,
            );
            p = rules.play(p, move);
          }
          const first = moveText(line.moves[0] as Move);
          check(!firsts.has(first), `${at}: two Lines start with ${first}`);
          firsts.add(first);
        }
      });
    }

    // maxTimeMs counts from the first next(): waiting before iterating must
    // not leave the Engine without time for its first depth.
    const lazy = engine.analyze(position, { maxTimeMs: 1, maxDepth: depthCap });
    await new Promise((r) => setTimeout(r, 25));
    const it = lazy[Symbol.asyncIterator]();
    try {
      const first = await step(it, stepTimeout, "lazy start");
      check(
        !first.done,
        `Position ${text}: no Analysis when iteration starts after maxTimeMs ` +
          `elapsed (time must count from the first next())`,
      );
    } finally {
      close(it);
    }
  }

  // Time and abort behaviour on a search without a depth cap.
  const root = sampled.values().next().value as Position;
  const t0 = performance.now();
  const timed = await drain(root, { maxTimeMs: 30 }, "maxTimeMs search");
  const took = performance.now() - t0;
  check(timed.length >= 1, "maxTimeMs search yielded nothing");
  check(
    took <= 30 + slack,
    `maxTimeMs=30 search ran ${Math.round(took)}ms (slack ${slack}ms)`,
  );

  // A pre-aborted signal ends the search without throwing.
  const pre = new AbortController();
  pre.abort();
  await drain(root, {}, "pre-aborted search", pre.signal, slack);

  // Aborting mid-search stops it within the slack.
  const controller = new AbortController();
  const it = engine.analyze(root, {}, controller.signal)
    [Symbol.asyncIterator]();
  try {
    // Once aborted, the stream must end within `slack`; how many buffered
    // Analyses arrive before it ends is not constrained.
    let abortDeadline: number | undefined;
    for (;;) {
      const left = abortDeadline === undefined
        ? stepTimeout
        : Math.max(1, abortDeadline - performance.now());
      const r = await step(
        it,
        left,
        abortDeadline === undefined
          ? "search before abort"
          : `mid-search abort: stream did not end within ${slack}ms`,
      );
      if (r.done) break;
      if (abortDeadline === undefined) {
        controller.abort();
        abortDeadline = performance.now() + slack;
      } else {
        check(
          performance.now() <= abortDeadline,
          `mid-search abort: stream still yielding ${slack}ms after abort`,
        );
      }
    }
  } finally {
    close(it);
  }
}
