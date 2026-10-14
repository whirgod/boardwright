import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { fileURLToPath } from "node:url";
import { externalAdapter } from "./external-engine.ts";
import {
  parseExternalEngineConfig,
  readExternalEngineConfig,
  registerExternalEngines,
} from "./external-engine-config.ts";

const SCRATCH = fileURLToPath(new URL("../../../.test-tmp/", import.meta.url));
const TEST_ENGINE = fileURLToPath(
  new URL("./test-engines/external.ts", import.meta.url),
);

Deno.test("parseExternalEngineConfig resolves paths against the config's directory", () => {
  const configs = parseExternalEngineConfig({
    engines: [
      { gameId: "g", id: "a", command: "./bin/a", args: ["--x"] },
      { gameId: "g", id: "b", name: "B", command: "stockfish", cwd: "work" },
      { gameId: "g", id: "c", command: "/opt/c", cwd: "/tmp" },
    ],
  }, "/srv/conf");
  assertEquals(configs, [
    {
      gameId: "g",
      id: "a",
      command: "/srv/conf/bin/a",
      args: ["--x"],
      cwd: "/srv/conf",
    },
    {
      gameId: "g",
      id: "b",
      name: "B",
      command: "stockfish",
      args: [],
      cwd: "/srv/conf/work",
    },
    { gameId: "g", id: "c", command: "/opt/c", args: [], cwd: "/tmp" },
  ]);
});

Deno.test("parseExternalEngineConfig lists every problem", () => {
  assertThrows(
    () => parseExternalEngineConfig([], "/"),
    Error,
    'expected { "engines": [...] }',
  );
  const error = assertThrows(() =>
    parseExternalEngineConfig({
      engines: [
        7,
        { id: "", command: "x", name: 1 },
        { gameId: "g", id: "i", command: "x", args: [1], cwd: "" },
      ],
    }, "/"), Error);
  assertEquals(
    error.message,
    [
      "Invalid external Engine config:",
      "- engines[0]: not an object",
      "- engines[1].gameId: expected a non-empty string",
      "- engines[1].id: expected a non-empty string",
      "- engines[1].name: expected a non-empty string",
      "- engines[2].cwd: expected a non-empty string",
      "- engines[2].args: expected an array of strings",
    ].join("\n"),
  );
});

Deno.test("readExternalEngineConfig: missing file, bad JSON, valid file", async () => {
  await Deno.mkdir(SCRATCH, { recursive: true });
  const missing = `${SCRATCH}no-such-config.json`;
  assertEquals(await readExternalEngineConfig(missing, { optional: true }), []);
  await assertRejects(
    () => readExternalEngineConfig(missing),
    Error,
    "Cannot read external Engine config",
  );
  const path = `${SCRATCH}external-engines.json`;
  try {
    await Deno.writeTextFile(path, "{ nope");
    await assertRejects(
      () => readExternalEngineConfig(path, { optional: true }),
      Error,
      "is not JSON",
    );
    await Deno.writeTextFile(
      path,
      JSON.stringify({ engines: [{ gameId: "g", id: "e", command: "./e" }] }),
    );
    assertEquals(await readExternalEngineConfig(path), [
      {
        gameId: "g",
        id: "e",
        command: `${SCRATCH}e`,
        args: [],
        cwd: SCRATCH.slice(0, -1),
      },
    ]);
  } finally {
    await Deno.remove(path);
  }
});

const config = (id: string, mode: string, extra = {}) => ({
  gameId: "tic-tac-toe",
  id,
  command: TEST_ENGINE,
  args: [mode],
  cwd: SCRATCH,
  ...extra,
});

Deno.test("registerExternalEngines names Engines from the config or their handshake", async () => {
  const adapter = externalAdapter({ stderr: "null" });
  try {
    const entries = await registerExternalEngines(
      [config("a", "ok"), config("b", "ok", { name: "Bee" })],
      adapter,
      new Set(["tic-tac-toe"]),
    );
    assertEquals(entries.map((e) => [e.id, e.name]), [
      ["a", "External test"],
      ["b", "Bee"],
    ]);
    assertEquals(entries[0]!.external, {
      command: TEST_ENGINE,
      args: ["ok"],
      cwd: SCRATCH,
    });
  } finally {
    await adapter.close();
  }
});

Deno.test("registerExternalEngines rejects with every problem", async () => {
  const adapter = externalAdapter({ stderr: "null" });
  try {
    const error = await assertRejects(() =>
      registerExternalEngines(
        [
          config("ok", "ok"),
          config("game", "ok", { gameId: "go" }),
          config("run", "ok", { command: "/bin/true" }),
          config("wrong", "wrong-game"),
        ],
        adapter,
        new Set(["tic-tac-toe"]),
      ), Error);
    assertEquals(
      error.message.split("\n"),
      [
        "Invalid external Engines:",
        '- External Engine "game" of Game "go": no such Game',
        '- External Engine "run" of Game "tic-tac-toe": not allowed to run /bin/true (start the server with --allow-run=/bin/true)',
        '- External Engine "wrong" of Game "tic-tac-toe": external Engine "wrong" is ready for Game "chess", not "tic-tac-toe"',
      ],
    );
  } finally {
    await adapter.close();
  }
});
