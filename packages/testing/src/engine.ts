import type {
  Analysis,
  Engine,
  GameRules,
  Score,
  SearchLimits,
} from "@boardwright/core";
import { seededRandom } from "./mod.ts";

export interface EngineContractOptions {
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
}

/** Total order on Scores from the Seat-to-move's view (higher is better). */
function rank(score: Score): number {
  if (score.kind === "win-in") return 1e300 - score.plies;
  if (score.kind === "loss-in") return -1e300 + score.plies;
  return score.value;
}

/**
 * Checks that `engine` obeys the `Engine.analyze` contract for `rules`:
 * invalid limits throw a RangeError synchronously; only completed depths
 * (1, 2, 3, ...) are yielded; a terminal Position yields exactly one depth-0
 * Analysis; at least one Analysis despite `maxTimeMs` (time counts from the
 * first `next()`); every Line is a legal Move sequence with a well-formed
 * Score, best Lines first, distinct first Moves; time limits and aborts are
 * honoured. Every Engine package must call this from its tests.
 */
export async function assertEngineContract<Position, Move>(
  engine: Engine<Position, Move>,
  rules: GameRules<Position, Move>,
  options: EngineContractOptions = {},
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
  ): Promise<Analysis<Move>[]> {
    const it = engine.analyze(position, limits, signal)[Symbol.asyncIterator]();
    const all: Analysis<Move>[] = [];
    const deadline = performance.now() + stepTimeout;
    try {
      for (;;) {
        const left = Math.max(1, deadline - performance.now());
        const r = await step(it, left, what);
        if (r.done) return all;
        all.push(r.value);
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
  const walkTo = (stopAt: number): Position | undefined => {
    let p = rules.initialPosition();
    for (let ply = 0; ply < maxPlies; ply++) {
      if (rules.toMove(p) === undefined) {
        terminal ??= p;
        return undefined;
      }
      if (ply >= stopAt) return p;
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
  // A full playout, so a terminal Position is covered whenever one is reachable.
  for (let w = 0; w < 20 && terminal === undefined; w++) walkTo(maxPlies);

  // A terminal Position yields exactly one { depth: 0, lines: [] }.
  if (terminal !== undefined) {
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
          a.depth === i + 1,
          `${where}: depths must be completed and consecutive from 1, got ${depths}`,
        );
        check(
          a.depth <= (limits.maxDepth ?? Infinity),
          `${at}: exceeds maxDepth`,
        );
        check(
          a.lines.length >= 1 && a.lines.length <= wanted,
          `${at}: ${a.lines.length} Lines, expected 1..${wanted}`,
        );
        const firsts = new Set<string>();
        let previous = Infinity;
        for (const line of a.lines) {
          const played = line.moves.map(moveText).join(" ");
          check(line.moves.length >= 1, `${at}: Line has no Moves`);
          const s = line.score;
          check(
            s.kind === "value"
              ? Number.isFinite(s.value)
              : (s.kind === "win-in" || s.kind === "loss-in") &&
                Number.isInteger(s.plies) && s.plies >= 1,
            `${at}: malformed Score ${JSON.stringify(s)}`,
          );
          check(
            rank(s) <= previous,
            `${at}: Lines are not best first (${
              JSON.stringify(a.lines.map((l) => l.score))
            })`,
          );
          previous = rank(s);
          let p = position;
          for (const move of line.moves) {
            const m = moveText(move);
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
  await drain(root, {}, "pre-aborted search", pre.signal);

  // Aborting mid-search stops it within the slack.
  const controller = new AbortController();
  const it = engine.analyze(root, {}, controller.signal)
    [Symbol.asyncIterator]();
  try {
    let aborted = false;
    let afterAbort = 0;
    for (;;) {
      const r = await step(
        it,
        aborted ? slack : stepTimeout,
        aborted ? "search after abort (abort ignored?)" : "search before abort",
      );
      if (r.done) break;
      if (!aborted) {
        controller.abort();
        aborted = true;
      } else {
        // The depth in flight when abort fires is discarded; nothing more
        // than a stray Analysis or two may follow.
        check(++afterAbort <= 2, "Engine keeps yielding Analyses after abort");
      }
    }
  } finally {
    close(it);
  }
}
