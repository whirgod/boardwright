import { assertEquals } from "@std/assert";
import type { Analysis } from "@boardwright/core";
import {
  ANALYSIS_STREAM_PATH,
  AnalysisClient,
  analysisOf,
  type AnalysisRequest,
  type AnalysisState,
} from "./analysis-client.ts";
import { fakeConnect, tick } from "./socket.testing.ts";

const REQUEST: AnalysisRequest = {
  gameId: "tic-tac-toe",
  engineId: "minimax",
  position: ".........:x",
  lines: 2,
  maxTimeMs: 5000,
};
const OTHER: AnalysisRequest = { ...REQUEST, position: "x........:o" };
const ANALYSIS: Analysis<string> = {
  depth: 1,
  lines: [{ moves: ["b2"], score: { kind: "value", value: 0 } }],
};

function setup() {
  const { connect, sockets } = fakeConnect();
  const states: AnalysisState[] = [];
  const client = new AnalysisClient({
    connect,
    onState: (s) => states.push(s),
    delayMs: 0,
  });
  return { client, sockets, states };
}

const start = (id: string, request: AnalysisRequest) => ({
  type: "start",
  id,
  gameId: request.gameId,
  engineId: request.engineId,
  position: request.position,
  limits: { lines: request.lines, maxTimeMs: request.maxTimeMs },
});

Deno.test("analyze: connects lazily, starts once open, streams deeper Analyses until done", async () => {
  const { client, sockets, states } = setup();
  assertEquals(client.state, { kind: "idle" });
  client.analyze(REQUEST);
  assertEquals(client.state, { kind: "running", request: REQUEST });
  assertEquals(sockets.length, 0); // waits for the delay
  await tick();
  const socket = sockets[0]!;
  assertEquals(socket.path, ANALYSIS_STREAM_PATH);
  socket.accept();
  assertEquals(socket.sent, [start("s1", REQUEST)]);
  socket.receive({ type: "analysis", id: "s1", analysis: ANALYSIS });
  const deeper = { ...ANALYSIS, depth: 2 };
  socket.receive({ type: "analysis", id: "s1", analysis: deeper });
  socket.receive({ type: "done", id: "s1" });
  assertEquals(states.at(-2), {
    kind: "running",
    request: REQUEST,
    analysis: deeper,
  });
  assertEquals(client.state, {
    kind: "done",
    request: REQUEST,
    analysis: deeper,
  });
  // The same request again does not search again.
  client.analyze({ ...REQUEST });
  await tick();
  assertEquals(socket.sent.length, 1);
});

Deno.test("analyze: a new Position replaces the search and drops the old one's replies", async () => {
  const { client, sockets } = setup();
  client.analyze(REQUEST);
  await tick();
  const socket = sockets[0]!;
  socket.accept();
  socket.receive({ type: "analysis", id: "s1", analysis: ANALYSIS });
  client.analyze(OTHER);
  // The old Position's Lines are gone at once.
  assertEquals(client.state, { kind: "running", request: OTHER });
  await tick();
  assertEquals(socket.sent.at(-1), start("s2", OTHER));
  // Replies about s1 still in flight are stale.
  socket.receive({ type: "analysis", id: "s1", analysis: ANALYSIS });
  socket.receive({ type: "done", id: "s1" });
  assertEquals(client.state, { kind: "running", request: OTHER });
  socket.receive({ type: "analysis", id: "s2", analysis: ANALYSIS });
  assertEquals(client.state, {
    kind: "running",
    request: OTHER,
    analysis: ANALYSIS,
  });
  assertEquals(sockets.length, 1); // one connection for all searches
});

Deno.test("analyze: stepping quickly through Positions starts only the last search", async () => {
  const { connect, sockets } = fakeConnect();
  const client = new AnalysisClient({ connect, onState: () => {}, delayMs: 5 });
  client.analyze(REQUEST);
  client.analyze(OTHER);
  client.analyze({ ...OTHER, lines: 3 });
  await tick(20);
  sockets[0]!.accept();
  assertEquals(sockets[0]!.sent, [start("s3", { ...OTHER, lines: 3 })]);
  client.close();
});

Deno.test("analyze: a start queued before the socket opens is sent on open (latest only)", async () => {
  const { client, sockets } = setup();
  client.analyze(REQUEST);
  await tick();
  client.analyze(OTHER);
  await tick();
  assertEquals(sockets.length, 1);
  sockets[0]!.accept();
  assertEquals(sockets[0]!.sent, [start("s2", OTHER)]);
});

Deno.test("stop: cancels on the server and ignores the search's later replies", async () => {
  const { client, sockets } = setup();
  client.stop(); // nothing running: nothing sent
  client.analyze(REQUEST);
  await tick();
  const socket = sockets[0]!;
  socket.accept();
  client.analyze(undefined);
  assertEquals(socket.sent.at(-1), { type: "stop" });
  assertEquals(client.state, { kind: "idle" });
  socket.receive({ type: "analysis", id: "s1", analysis: ANALYSIS });
  socket.receive({ type: "stopped", id: "s1" });
  assertEquals(client.state, { kind: "idle" });
  // Stopping before the delayed start was sent sends nothing.
  client.analyze(OTHER);
  client.stop();
  await tick();
  assertEquals(socket.sent.length, 2);
});

Deno.test("errors: server errors become readable states; retry starts again", async () => {
  const { client, sockets } = setup();
  client.analyze(REQUEST);
  await tick();
  const socket = sockets[0]!;
  socket.accept();
  socket.receive({
    type: "error",
    id: "s1",
    error: { code: "busy", message: "queue full" },
  });
  assertEquals(client.state, {
    kind: "error",
    request: REQUEST,
    message: "The server is busy with other searches; try again shortly.",
  });
  // The same request does not hammer the server; retry() does start again.
  client.analyze(REQUEST);
  await tick();
  assertEquals(socket.sent.length, 1);
  client.retry();
  await tick();
  assertEquals(socket.sent.at(-1), start("s2", REQUEST));
  socket.receive({
    type: "error",
    id: "s2",
    error: { code: "invalid-position", message: "bad Position" },
  });
  assertEquals(
    client.state.kind === "error" && client.state.message,
    "bad Position",
  );
  client.retry();
  await tick();
  socket.receive({ type: "error", id: "s3" });
  assertEquals(
    client.state.kind === "error" && client.state.message,
    "The search failed.",
  );
});

Deno.test("receive: ignores garbage, untagged and unknown messages", async () => {
  const { client, sockets } = setup();
  client.analyze(REQUEST);
  await tick();
  const socket = sockets[0]!;
  socket.accept();
  for (
    const message of [
      "not json",
      "[1]",
      "null",
      { type: "analysis", analysis: ANALYSIS }, // no id
      { type: "mystery", id: "s1" },
    ]
  ) {
    socket.receive(message);
  }
  assertEquals(client.state, { kind: "running", request: REQUEST });
  socket.receive({ type: "done", id: "s1" });
  socket.receive({ type: "analysis", id: "s1", analysis: ANALYSIS });
  assertEquals(client.state, { kind: "done", request: REQUEST });
});

Deno.test("connection loss: a running search fails; the next search reconnects", async () => {
  const { client, sockets } = setup();
  client.analyze(REQUEST);
  await tick();
  sockets[0]!.accept();
  sockets[0]!.receive({ type: "analysis", id: "s1", analysis: ANALYSIS });
  sockets[0]!.drop();
  assertEquals(client.state, {
    kind: "error",
    request: REQUEST,
    analysis: ANALYSIS,
    message: "Lost the connection to the server.",
  });
  client.retry();
  await tick();
  assertEquals(sockets.length, 2);
  sockets[1]!.accept();
  assertEquals(sockets[1]!.sent, [start("s2", REQUEST)]);
  // Losing an idle connection changes nothing.
  sockets[1]!.receive({ type: "done", id: "s2" });
  sockets[1]!.drop();
  assertEquals(client.state.kind, "done");
});

Deno.test("analysisOf: only an Analysis of the shown Position", () => {
  const state: AnalysisState = {
    kind: "running",
    request: REQUEST,
    analysis: ANALYSIS,
  };
  assertEquals(analysisOf(state, REQUEST.position), ANALYSIS);
  assertEquals(analysisOf(state, OTHER.position), undefined);
  assertEquals(analysisOf({ kind: "idle" }, REQUEST.position), undefined);
  assertEquals(
    analysisOf({ ...state, kind: "error", message: "x" }, REQUEST.position),
    ANALYSIS,
  );
});

Deno.test("close: closes the socket and ignores everything afterwards", async () => {
  const { client, sockets, states } = setup();
  client.analyze(REQUEST);
  await tick();
  const socket = sockets[0]!;
  socket.accept();
  client.close();
  assertEquals(socket.closed, true);
  const seen = states.length;
  client.analyze(OTHER);
  client.stop();
  client.retry();
  await tick();
  assertEquals(states.length, seen);
  assertEquals(sockets.length, 1);
});
