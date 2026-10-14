/**
 * External Engines: Engines that run as their own process, written in any
 * language, and speak the external Engine protocol (ADR 0008, spec in
 * docs/external-engine-protocol.md): JSON messages, one per line, over the
 * process's stdin/stdout, with Positions and Moves in the Game's Notation.
 *
 * {@link externalAdapter} is the Engine runner's adapter for them. Per Engine
 * it keeps a small pool of processes, each started once, handshaken and then
 * reused for one search after another. It turns everything that can go wrong
 * with a process into a {@link SearchError}, decides when a process is still
 * usable and when it is killed and replaced, and rebuilds every Analysis from
 * checked parts (Moves decoded and played through the Game's rules), so
 * nothing else an Engine sends reaches clients.
 */
import {
  type Analysis,
  chancePending,
  type GameId,
  type Line,
  type Score,
  type SearchLimits,
} from "@boardwright/core";
import { type EngineAdapter, SearchError } from "./engine-runner.ts";
import type { ExternalEngineCommand, ExternalEngineEntry } from "./engines.ts";
import type { AnyGameRules, GameRegistry } from "./games.ts";

/** The protocol version this server speaks. */
export const PROTOCOL_VERSION = 1;

/** Longest line (in bytes, without its `\n`) an Engine may send; longer is `unreadable-reply`. */
export const MAX_LINE_BYTES = 1 << 20;

/** Longest Engine name kept from `ready` (characters, after removing control characters). */
export const MAX_NAME_LENGTH = 64;

/**
 * Environment variables an Engine process inherits from the server (when the
 * server may read them); everything else is cleared. `PATH` finds
 * interpreters such as `deno` in a shebang, `HOME` their caches.
 */
export const INHERITED_ENV = ["PATH", "HOME", "LANG"] as const;

/**
 * How long, after the process exits, its remaining output is still read
 * before the exit is reported (a grandchild may hold stdout open forever).
 */
const EXIT_DRAIN_MS = 200;

/** A message from the server to an external Engine. */
export type ServerMessage =
  | {
    readonly type: "hello";
    readonly protocol: number;
    readonly gameId: GameId;
  }
  | {
    readonly type: "analyze";
    readonly id: number;
    readonly position: string;
    readonly limits: SearchLimits;
  }
  | { readonly type: "stop"; readonly id: number }
  | { readonly type: "quit" };

/** A message from an external Engine to the server (unknown fields are ignored). */
export type EngineMessage =
  | {
    readonly type: "ready";
    readonly protocol: number;
    readonly gameId: GameId;
    readonly name: string;
  }
  | {
    readonly type: "analysis";
    readonly id: number;
    readonly analysis: unknown;
  }
  | { readonly type: "done"; readonly id: number }
  | { readonly type: "error"; readonly id?: number; readonly message: string };

/**
 * Parses one line from an Engine; `undefined` when it is not a protocol
 * message (not JSON, unknown `type`, missing or mistyped fields). A `ready`
 * name loses control characters and is cut to {@link MAX_NAME_LENGTH}; it
 * must not end up empty. The Analysis itself is checked by
 * {@link readAnalysis}.
 */
export function parseEngineMessage(line: string): EngineMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const m = value;
  const isId = (id: unknown) => Number.isSafeInteger(id);
  switch (m.type) {
    case "ready": {
      if (
        typeof m.protocol !== "number" || typeof m.gameId !== "string" ||
        typeof m.name !== "string"
      ) return undefined;
      const name = [...m.name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim()]
        .slice(0, MAX_NAME_LENGTH).join("").trim();
      return name.length > 0
        ? { type: "ready", protocol: m.protocol, gameId: m.gameId, name }
        : undefined;
    }
    case "analysis":
      return isId(m.id) && "analysis" in m
        ? { type: "analysis", id: m.id as number, analysis: m.analysis }
        : undefined;
    case "done":
      return isId(m.id) ? { type: "done", id: m.id as number } : undefined;
    case "error":
      if (typeof m.message !== "string") return undefined;
      if (m.id === undefined) return { type: "error", message: m.message };
      return isId(m.id)
        ? { type: "error", id: m.id as number, message: m.message }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Rebuilds an Analysis an Engine sent for `position` from checked parts only:
 * an integer `depth` >= 0; Lines of Moves that decode in the Game's Notation
 * and are legal in sequence from `position` (re-encoded, none after the Game
 * ends or a Chance event is pending), each with a Score rebuilt field by
 * field, at most `maxLines` of them (checked first); a top-level `score`
 * with `seat` (one of the Game's Seats) exactly while a Chance event is
 * pending at `position`. Everything else is dropped. Throws an
 * `unreadable-reply` {@link SearchError} saying what is wrong.
 */
export function readAnalysis(
  value: unknown,
  rules: AnyGameRules,
  position: unknown,
  maxLines: number,
): Analysis<string> {
  const bad = (problem: string): never => {
    throw new SearchError("unreadable-reply", `malformed Analysis: ${problem}`);
  };
  if (!isRecord(value)) return bad("not an object");
  const { depth, lines, score, seat } = value;
  if (!Number.isInteger(depth) || (depth as number) < 0) bad("depth");
  if (!Array.isArray(lines)) return bad("lines");
  if (lines.length > maxLines) return bad(`more than ${maxLines} Lines`);
  const readLine = (line: unknown): Line<string> => {
    if (!isRecord(line)) return bad("Line is not an object");
    const { moves } = line;
    if (!Array.isArray(moves) || moves.length === 0) return bad("Line moves");
    const lineScore = readScore(line.score) ?? bad("Line score");
    let p = position;
    const encoded = moves.map((text: unknown) => {
      if (typeof text !== "string") return bad("Move is not a string");
      if (rules.outcome(p) !== undefined || chancePending(rules, p)) {
        return bad(`Move ${clip(text)} after the end or a Chance event`);
      }
      let move: unknown;
      try {
        move = rules.notation.decodeMove(text, p);
      } catch {
        return bad(`undecodable Move ${clip(text)}`);
      }
      const canonical = rules.notation.encodeMove(move);
      const legal = rules.legalMoves(p).some((m) =>
        rules.notation.encodeMove(m) === canonical
      );
      if (!legal) return bad(`illegal Move ${clip(text)}`);
      p = rules.play(p, move);
      return canonical;
    });
    return { moves: encoded, score: lineScore };
  };
  const analysis = { depth: depth as number, lines: lines.map(readLine) };
  if (!chancePending(rules, position)) {
    if (score === undefined && seat === undefined) return analysis;
    return bad("score and seat are only for a pending Chance event");
  }
  const expected = readScore(score) ?? bad("score");
  if (typeof seat !== "string" || !rules.seats.includes(seat)) {
    return bad("seat");
  }
  return { ...analysis, score: expected, seat };
}

/** A Score rebuilt from its own fields, or `undefined` if malformed. */
function readScore(value: unknown): Score | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, value: v, plies } = value;
  if (kind === "value") {
    return Number.isFinite(v) ? { kind, value: v as number } : undefined;
  }
  if (kind === "win-in" || kind === "loss-in") {
    return Number.isInteger(plies) && (plies as number) >= 0
      ? { kind, plies: plies as number }
      : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What a process has to say: a message, a line outside the protocol, or its end. */
type ProcessEvent =
  | { readonly kind: "message"; readonly message: EngineMessage }
  | { readonly kind: "malformed"; readonly reason: string }
  | { readonly kind: "exit"; readonly reason: string };

const encoder = new TextEncoder();
const NO_BYTES = new Uint8Array(0);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}

/** The environment of an Engine process: {@link INHERITED_ENV} plus its own. */
function engineEnv(command: ExternalEngineCommand): Record<string, string> {
  const env: Record<string, string> = {};
  for (const variable of INHERITED_ENV) {
    // Asking first: reading without permission could prompt on a terminal.
    if (
      Deno.permissions.querySync({ name: "env", variable }).state !== "granted"
    ) {
      continue;
    }
    const value = Deno.env.get(variable);
    if (value !== undefined) env[variable] = value;
  }
  return { ...env, ...command.env };
}

/**
 * One running external Engine process: writes messages to its stdin, turns
 * its stdout into {@link ProcessEvent}s. Single consumer: one `next()` at a
 * time.
 */
class EngineProcess {
  readonly #child: Deno.ChildProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #inbox: ProcessEvent[] = [];
  #wake: (() => void) | undefined;
  #exited = false;
  #killed = false;
  /**
   * Resolves once the process has exited and its output is read (or, if
   * something else holds stdout open, shortly after the exit).
   */
  readonly closed: Promise<void>;
  /** The id of the last search started on this process. */
  lastId = 0;

  /** Throws (e.g. `NotCapable`, `NotFound`) if the process cannot start. */
  constructor(command: ExternalEngineCommand, stderr: "inherit" | "null") {
    this.#child = new Deno.Command(command.command, {
      args: [...(command.args ?? [])],
      ...(command.cwd !== undefined && { cwd: command.cwd }),
      clearEnv: true,
      env: engineEnv(command),
      stdin: "piped",
      stdout: "piped",
      stderr,
    }).spawn();
    this.#writer = this.#child.stdin.getWriter();
    this.#reader = this.#child.stdout.getReader();
    const reading = this.#read();
    this.closed = this.#child.status.then(async (status) => {
      // Output written before the exit still counts, but a grandchild that
      // holds stdout open must not keep the exit from being reported.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        reading,
        new Promise((resolve) => timer = setTimeout(resolve, EXIT_DRAIN_MS)),
      ]);
      clearTimeout(timer);
      this.#exited = true;
      this.#release();
      await reading;
      this.#deliver({
        kind: "exit",
        reason: status.signal === null
          ? `exited with code ${status.code}`
          : `killed by ${status.signal}`,
      });
    });
  }

  /** Not exited, not killed, and nothing unread: ready for a search. */
  get usable(): boolean {
    return !this.#exited && !this.#killed && this.#inbox.length === 0;
  }

  /** Splits stdout into lines (bytes, linear) and parses each. */
  async #read(): Promise<void> {
    const decoder = new TextDecoder();
    let pending: Uint8Array = NO_BYTES; // The start of an unfinished line.
    try {
      for (;;) {
        const { done, value: chunk } = await this.#reader.read();
        if (done) return;
        let start = 0;
        for (let end; (end = chunk.indexOf(10, start)) >= 0; start = end + 1) {
          const piece = chunk.subarray(start, end);
          const line = pending.length > 0 ? concat(pending, piece) : piece;
          pending = NO_BYTES;
          if (line.length > MAX_LINE_BYTES) {
            this.#deliver({ kind: "malformed", reason: "line too long" });
          } else {
            this.#line(decoder.decode(line));
          }
        }
        if (pending.length + chunk.length - start > MAX_LINE_BYTES) {
          this.#deliver({ kind: "malformed", reason: "line too long" });
          this.kill();
          return;
        }
        pending = concat(pending, chunk.subarray(start));
      }
    } catch {
      // stdout failed or was cancelled: the exit event follows.
    }
  }

  #line(text: string): void {
    const line = text.endsWith("\r") ? text.slice(0, -1) : text;
    if (line.trim() === "") return;
    const message = parseEngineMessage(line);
    this.#deliver(
      message === undefined
        ? { kind: "malformed", reason: `not a protocol message: ${clip(line)}` }
        : { kind: "message", message },
    );
  }

  #deliver(event: ProcessEvent): void {
    this.#inbox.push(event);
    this.#wake?.();
  }

  /** The next event; `undefined` once `signal` aborts first. */
  async next(signal?: AbortSignal): Promise<ProcessEvent | undefined> {
    while (this.#inbox.length === 0) {
      if (signal?.aborted) return undefined;
      await new Promise<void>((resolve) => {
        const onAbort = () => resolve();
        this.#wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      this.#wake = undefined;
    }
    return this.#inbox.shift();
  }

  /** Writes a message; a dead process is reported by its exit event, not here. */
  async send(message: ServerMessage): Promise<void> {
    try {
      await this.#writer.write(encoder.encode(JSON.stringify(message) + "\n"));
    } catch {
      // Broken pipe or closed: the process is gone or going.
    }
  }

  /** Drops both pipes at once (no waiting for pending writes). */
  #release(): void {
    this.#writer.abort().catch(() => {});
    this.#reader.cancel().catch(() => {});
  }

  /**
   * Kills the process and drops its pipes, so a launcher's grandchild (see
   * the spec: launchers should `exec`) sees end of stdin and cannot hold up
   * {@link closed}.
   */
  kill(): void {
    if (this.#exited || this.#killed) return;
    this.#killed = true;
    try {
      this.#child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    this.#release();
  }

  /** Asks the process to exit (`quit`, then end of stdin); kills it after `graceMs`. */
  async quit(graceMs: number): Promise<void> {
    if (!this.#exited && !this.#killed) {
      const timer = setTimeout(() => this.kill(), graceMs);
      await this.send({ type: "quit" });
      await this.#writer.close().catch(() => {});
      await this.closed;
      clearTimeout(timer);
    }
    await this.closed;
  }
}

const clip = (text: string) =>
  text.length > 80 ? `${text.slice(0, 80)}...` : text;

export interface ExternalAdapterOptions {
  /** The hosted Games, whose rules check what Engines send. */
  readonly games: GameRegistry;
  /** Longest wait for `ready` after `hello`, ms. Default 10000. */
  readonly handshakeTimeoutMs?: number;
  /**
   * Longest wait for `done` (or `error`) after `stop`, ms; then the process
   * is killed. Also the grace for `quit`. Default 1000.
   */
  readonly stopTimeoutMs?: number;
  /** Idle processes kept per Engine for later searches. Default 2. */
  readonly maxIdle?: number;
  /**
   * Consecutive failures (a process that would not start, broke the
   * protocol, crashed or ignored `stop`) after which an Engine cools down.
   * Default 3.
   */
  readonly maxFailures?: number;
  /** How long a cooling-down Engine refuses searches (`worker-error`), ms. Default 30000. */
  readonly cooldownMs?: number;
  /** Where the Engines' stderr goes: the server's stderr, or nowhere. Default `inherit`. */
  readonly stderr?: "inherit" | "null";
}

/** The runner's adapter for external Engines, plus what startup and shutdown need. */
export interface ExternalAdapter extends EngineAdapter {
  /**
   * Starts a process for the Engine (or reuses an idle one) and resolves
   * with the name it announced in the handshake. The process stays idle for
   * the next search. Throws a {@link SearchError} like a search would.
   */
  connect(entry: ExternalEngineEntry, signal?: AbortSignal): Promise<string>;
  /**
   * Resolves once background work (stopping searches, finishing handshakes
   * of aborted searches) is done. For tests.
   */
  settled(): Promise<void>;
  /** Stops every process (idle ones get `quit`, busy ones are killed). */
  close(): Promise<void>;
}

/**
 * Runs external Engines (see the module doc). Per search: take an idle
 * process of the Engine or start one (`hello` -> `ready`, checked against the
 * Engine's Game), send `analyze`, yield each `analysis` (rebuilt by
 * {@link readAnalysis}) until `done`. Errors: a process that will not start
 * or exits is `worker-error`; a line outside the protocol or a message out of
 * turn is `unreadable-reply` (the process is killed), so is an Analysis
 * {@link readAnalysis} rejects (the search is stopped); an `error` message is
 * `engine-error` (the process stays usable); no `ready` within
 * `handshakeTimeoutMs` is `timeout`. When the search is aborted or abandoned
 * the adapter ends at once and, in the background, sends `stop` and waits up
 * to `stopTimeoutMs` for `done` before killing the process; a handshake in
 * progress completes in the background and the process joins the idle pool,
 * so a slow-starting Engine is not restarted on every short search.
 * Processes run with a cleared environment ({@link INHERITED_ENV} plus the
 * Engine's `env`). Restart policy: a broken process is replaced by a fresh
 * one on the next search; after `maxFailures` failures in a row the Engine
 * refuses searches for `cooldownMs`, then tries again.
 */
export function externalAdapter(
  options: ExternalAdapterOptions,
): ExternalAdapter {
  const settings: PoolSettings = {
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
    stopTimeoutMs: options.stopTimeoutMs ?? 1000,
    maxIdle: options.maxIdle ?? 2,
    maxFailures: options.maxFailures ?? 3,
    cooldownMs: options.cooldownMs ?? 30_000,
    stderr: options.stderr ?? "inherit",
  };
  const pools = new Map<string, EnginePool>();
  let closed = false;
  const poolOf = (entry: ExternalEngineEntry) => {
    if (closed) {
      throw new SearchError("worker-error", "external Engines are shut down");
    }
    const key = JSON.stringify([entry.gameId, entry.id]);
    let pool = pools.get(key);
    if (!pool) {
      const rules = options.games.get(entry.gameId);
      if (!rules) {
        throw new SearchError(
          "engine-error",
          `no Game ${JSON.stringify(entry.gameId)}`,
        );
      }
      pools.set(key, pool = new EnginePool(entry, rules, settings));
    }
    return pool;
  };
  return {
    analyze(request, signal) {
      const { engine } = request;
      if (engine.external === undefined) {
        throw new SearchError(
          "engine-error",
          `Engine ${JSON.stringify(engine.id)} is not an external Engine`,
        );
      }
      return poolOf(engine).analyze(request.position, request.limits, signal);
    },
    async connect(entry, signal) {
      const pool = poolOf(entry);
      const process = await pool.acquire(signal);
      if (!process) throw new SearchError("aborted", "connect aborted");
      pool.release(process);
      return pool.name!;
    },
    async settled() {
      await Promise.all([...pools.values()].map((pool) => pool.settled()));
    },
    async close() {
      closed = true;
      await Promise.all([...pools.values()].map((pool) => pool.close()));
    },
  };
}

/**
 * The SIGINT/SIGTERM handler `main.ts` installs: closes the external Engines
 * (so none outlive the server as orphans), then exits. Runs once.
 */
export function shutdownHandler(
  close: () => Promise<void>,
  exit: (code: number) => void = Deno.exit,
): () => Promise<void> {
  let started = false;
  return async () => {
    if (started) return;
    started = true;
    try {
      await close();
    } finally {
      exit(0);
    }
  };
}

interface PoolSettings {
  readonly handshakeTimeoutMs: number;
  readonly stopTimeoutMs: number;
  readonly maxIdle: number;
  readonly maxFailures: number;
  readonly cooldownMs: number;
  readonly stderr: "inherit" | "null";
}

/** The processes of one external Engine and its restart policy. */
class EnginePool {
  readonly #idle: EngineProcess[] = [];
  /** Every process not yet exited, idle or busy. */
  readonly #live = new Set<EngineProcess>();
  /** Background work (`stop` drains, handshakes), awaited on close. */
  readonly #background = new Set<Promise<void>>();
  #failures = 0;
  #coolUntil = 0;
  #closed = false;
  /** The name announced in the last handshake. */
  name: string | undefined;

  constructor(
    readonly entry: ExternalEngineEntry,
    readonly rules: AnyGameRules,
    readonly settings: PoolSettings,
  ) {}

  get #label(): string {
    return `external Engine ${JSON.stringify(this.entry.id)}`;
  }

  async *analyze(
    position: string,
    limits: SearchLimits,
    signal: AbortSignal,
  ): AsyncGenerator<Analysis<string>> {
    if (signal.aborted) return;
    let decoded: unknown;
    try {
      decoded = this.rules.notation.decodePosition(position);
    } catch (error) {
      throw new SearchError("engine-error", `undecodable Position`, {
        cause: error,
      });
    }
    const process = await this.acquire(signal);
    if (!process) return;
    const id = ++process.lastId;
    let open = true; // Until the search's end is known (or the process gone).
    try {
      await process.send({ type: "analyze", id, position, limits });
      for (;;) {
        const event = await process.next(signal);
        if (event === undefined) return; // Aborted: stopped in `finally`.
        if (event.kind !== "message") {
          open = false;
          throw this.#broken(process, event);
        }
        const message = event.message;
        if (message.type === "analysis" && message.id === id) {
          // A rejected Analysis throws; the search is stopped in `finally`.
          yield readAnalysis(
            message.analysis,
            this.rules,
            decoded,
            limits.lines ?? 1,
          );
        } else if (message.type === "done" && message.id === id) {
          open = false;
          this.#succeeded();
          this.release(process);
          return;
        } else if (message.type === "error" && message.id === id) {
          open = false;
          this.#succeeded(); // The process works; the Engine failed.
          this.release(process);
          throw new SearchError(
            "engine-error",
            `${this.#label} failed: ${message.message}`,
          );
        } else {
          open = false;
          throw this.#broken(process, {
            kind: "malformed",
            reason: `unexpected ${message.type} message during search ${id}`,
          });
        }
      }
    } finally {
      if (open) this.#stop(process, id);
    }
  }

  /**
   * An idle usable process, or a newly started and handshaken one;
   * `undefined` if `signal` aborts first (a handshake under way then
   * completes in the background and the process joins the idle pool).
   */
  async acquire(signal?: AbortSignal): Promise<EngineProcess | undefined> {
    if (this.#closed) {
      throw new SearchError("worker-error", `${this.#label} is shut down`);
    }
    if (
      this.#failures >= this.settings.maxFailures &&
      Date.now() < this.#coolUntil
    ) {
      throw new SearchError(
        "worker-error",
        `${this.#label} failed ${this.#failures} times in a row; ` +
          `cooling down until ${new Date(this.#coolUntil).toISOString()}`,
      );
    }
    for (let process; (process = this.#idle.pop());) {
      if (process.usable) return process;
      this.#discard(process); // Exited or spoke while idle.
    }
    if (signal?.aborted) return undefined;
    let process: EngineProcess;
    try {
      // Asking first: spawning without permission could prompt on a terminal.
      const { command } = this.entry.external;
      const { state } = Deno.permissions.querySync({ name: "run", command });
      if (state !== "granted") {
        throw new Error(`not allowed to run ${command} (--allow-run)`);
      }
      process = new EngineProcess(this.entry.external, this.settings.stderr);
    } catch (error) {
      this.#failed();
      throw new SearchError(
        "worker-error",
        `${this.#label} did not start: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    this.#live.add(process);
    process.closed.then(() => this.#live.delete(process));
    const ready = this.#handshake(process).then(
      (name) => {
        this.name = name;
        return process;
      },
      (error) => {
        process.kill();
        this.#failed();
        throw error;
      },
    );
    if (!signal) return await ready;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const winner = await Promise.race([ready, aborted]);
      if (winner === undefined) {
        this.#track(ready.then((p) => this.release(p), () => {}));
      }
      return winner;
    } finally {
      signal.removeEventListener("abort", onAbort!);
    }
  }

  /** `hello` -> `ready` within `handshakeTimeoutMs`; the announced name. */
  async #handshake(process: EngineProcess): Promise<string> {
    const { gameId } = this.entry;
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(),
      this.settings.handshakeTimeoutMs,
    );
    try {
      await process.send({ type: "hello", protocol: PROTOCOL_VERSION, gameId });
      const event = await process.next(timeout.signal);
      if (event === undefined) {
        throw new SearchError(
          "timeout",
          `${this.#label}: no ready within ${this.settings.handshakeTimeoutMs} ms`,
        );
      }
      if (event.kind === "exit") {
        throw new SearchError(
          "worker-error",
          `${this.#label} ${event.reason} during the handshake`,
        );
      }
      if (event.kind === "malformed") {
        throw new SearchError(
          "unreadable-reply",
          `${this.#label}: ${event.reason}`,
        );
      }
      const message = event.message;
      if (message.type === "error" && message.id === undefined) {
        throw new SearchError(
          "engine-error",
          `${this.#label} refused the handshake: ${message.message}`,
        );
      }
      if (message.type !== "ready") {
        throw new SearchError(
          "unreadable-reply",
          `${this.#label}: ${message.type} message before ready`,
        );
      }
      if (message.protocol !== PROTOCOL_VERSION) {
        throw new SearchError(
          "engine-error",
          `${this.#label} speaks protocol ${message.protocol}, not ${PROTOCOL_VERSION}`,
        );
      }
      if (message.gameId !== gameId) {
        throw new SearchError(
          "engine-error",
          `${this.#label} is ready for Game ${
            JSON.stringify(message.gameId)
          }, not ${JSON.stringify(gameId)}`,
        );
      }
      return message.name;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Back to the idle pool after a finished search (or quit if not needed). */
  release(process: EngineProcess): void {
    if (
      !this.#closed && process.usable &&
      this.#idle.length < this.settings.maxIdle
    ) {
      this.#idle.push(process);
    } else {
      this.#discard(process);
    }
  }

  /** Lets a process go without counting a failure. */
  #discard(process: EngineProcess): void {
    this.#track(process.quit(this.settings.stopTimeoutMs));
  }

  /** Kills a process that broke the protocol or exited; the search's error. */
  #broken(process: EngineProcess, event: ProcessEvent): SearchError {
    process.kill();
    this.#failed();
    return event.kind === "exit"
      ? new SearchError("worker-error", `${this.#label} ${event.reason}`)
      : new SearchError(
        "unreadable-reply",
        `${this.#label}: ${event.kind === "malformed" ? event.reason : ""}`,
      );
  }

  /**
   * Ends search `id` early: `stop`, then wait for its `done` (or `error`),
   * skipping its remaining Analyses, at most `stopTimeoutMs`; a process that
   * does not comply in time is killed.
   */
  #stop(process: EngineProcess, id: number): void {
    const drain = async () => {
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(),
        this.settings.stopTimeoutMs,
      );
      try {
        await process.send({ type: "stop", id });
        for (;;) {
          const event = await process.next(timeout.signal);
          if (event?.kind !== "message") break; // Timeout, exit, garbage.
          const { message } = event;
          if (message.type === "analysis" && message.id === id) continue;
          if (
            (message.type === "done" || message.type === "error") &&
            message.id === id
          ) {
            this.release(process);
            return;
          }
          break;
        }
        process.kill();
        this.#failed();
      } finally {
        clearTimeout(timer);
      }
    };
    this.#track(drain());
  }

  #track(task: Promise<void>): void {
    this.#background.add(task);
    task.finally(() => this.#background.delete(task));
  }

  #succeeded(): void {
    this.#failures = 0;
  }

  #failed(): void {
    this.#failures++;
    if (this.#failures >= this.settings.maxFailures) {
      this.#coolUntil = Date.now() + this.settings.cooldownMs;
    }
  }

  async settled(): Promise<void> {
    while (this.#background.size > 0) await Promise.all(this.#background);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const idle = this.#idle.splice(0);
    for (const process of this.#live) {
      if (!idle.includes(process)) process.kill();
    }
    await Promise.all(
      idle.map((process) => process.quit(this.settings.stopTimeoutMs)),
    );
    await this.settled();
    await Promise.all([...this.#live].map((process) => process.closed));
  }
}
