import { assertEquals } from "@std/assert";
import { ApiError, type MatchEvent, type MatchView } from "./api.ts";
import { applyMatchEvent, MatchFeed, matchStreamPath } from "./match-feed.ts";
import { fakeConnect, tick } from "./socket.testing.ts";

const MATCH: MatchView = {
  id: "m 1",
  gameId: "tic-tac-toe",
  seats: { x: { kind: "human" }, o: { kind: "engine", engineId: "minimax" } },
  moves: [{ kind: "move", move: "a1" }],
  position: "x........:o",
  toMove: "o",
  legalMoves: ["b2"],
  outcome: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 2,
};

const base = {
  matchId: "m 1",
  at: "2026-01-01T00:00:05.000Z",
  outcome: null,
} as const;
const moveEvent = (version: number, move: string): MatchEvent => ({
  ...base,
  kind: "move",
  version,
  seat: "o",
  move,
  position: "x...o....:x",
  toMove: "x",
});
const WIN = { kind: "rules", winner: "x", reason: "three-in-a-row" } as const;

Deno.test("applyMatchEvent: appends the next Move or Chance event; legal Moves wait for a reload", () => {
  const next = applyMatchEvent(MATCH, moveEvent(3, "b2"))!;
  assertEquals(next.moves, [
    { kind: "move", move: "a1" },
    { kind: "move", move: "b2" },
  ]);
  assertEquals(next.position, "x...o....:x");
  assertEquals(next.toMove, "x");
  assertEquals(next.version, 3);
  assertEquals(next.updatedAt, base.at);
  assertEquals(next.legalMoves, []);
  const rolled = applyMatchEvent(MATCH, {
    ...base,
    kind: "chance",
    version: 3,
    chance: "3-1",
    position: "p",
    toMove: "white",
  })!;
  assertEquals(rolled.moves.at(-1), { kind: "chance", chance: "3-1" });
});

Deno.test("applyMatchEvent: Resignations and Forfeits end the Match without a Move list entry", () => {
  const resigned = applyMatchEvent(MATCH, {
    ...base,
    kind: "resignation",
    version: 3,
    seat: "o",
    position: MATCH.position,
    toMove: null,
    outcome: { kind: "resignation", winner: "x", seat: "o" },
  })!;
  assertEquals(resigned.moves, MATCH.moves);
  assertEquals(resigned.outcome?.kind, "resignation");
});

Deno.test("applyMatchEvent: old events change nothing; a gap asks for a reload", () => {
  assertEquals(applyMatchEvent(MATCH, moveEvent(2, "b2")), MATCH);
  assertEquals(applyMatchEvent(MATCH, moveEvent(4, "b2")), undefined);
});

function setup(load: (id: string) => Promise<MatchView>) {
  const { connect, sockets } = fakeConnect();
  const views: MatchView[] = [];
  const errors: unknown[] = [];
  const live: boolean[] = [];
  const loads: string[] = [];
  const feed = new MatchFeed({
    matchId: "m 1",
    connect,
    load: (id) => {
      loads.push(id);
      return load(id);
    },
    onMatch: (v) => views.push(v),
    onError: (e) => errors.push(e),
    onLive: (l) => live.push(l),
    retryDelaysMs: [0, 5],
  });
  return { feed, sockets, views, errors, live, loads };
}

Deno.test("feed: the snapshot, then each event, then a reload for legal Moves", async () => {
  const reloaded = {
    ...applyMatchEvent(MATCH, moveEvent(3, "b2"))!,
    legalMoves: ["c3"],
  };
  const { feed, sockets, views, errors, live, loads } = setup(() =>
    Promise.resolve(reloaded)
  );
  const socket = sockets[0]!;
  assertEquals(socket.path, matchStreamPath("m 1"));
  assertEquals(socket.path, "/api/matches/m%201/stream");
  socket.accept();
  socket.receive({ type: "snapshot", match: MATCH });
  assertEquals(feed.match, MATCH);
  assertEquals(live, [true]);
  assertEquals(errors, [null]);
  socket.receive({ type: "event", event: moveEvent(3, "b2") });
  assertEquals(views.length, 2);
  assertEquals(views[1]!.legalMoves, []);
  assertEquals(loads, ["m 1"]);
  await tick();
  assertEquals(feed.match, reloaded);
  // A repeated event is ignored and triggers no reload.
  socket.receive({ type: "event", event: moveEvent(3, "b2") });
  await tick();
  assertEquals(loads.length, 1);
  feed.close();
  assertEquals(socket.closed, true);
});

Deno.test("feed: a skipped version reloads instead of guessing", async () => {
  const later = { ...MATCH, version: 5 };
  const { feed, sockets, loads } = setup(() => Promise.resolve(later));
  sockets[0]!.accept();
  sockets[0]!.receive({ type: "snapshot", match: MATCH });
  sockets[0]!.receive({ type: "event", event: moveEvent(4, "b2") });
  assertEquals(feed.match, MATCH);
  await tick();
  assertEquals(loads.length, 1);
  assertEquals(feed.match, later);
  feed.close();
});

Deno.test("feed: older views (late replies) never replace newer ones", async () => {
  const { feed, sockets, views } = setup(() => Promise.resolve(MATCH));
  sockets[0]!.receive({ type: "snapshot", match: { ...MATCH, version: 3 } });
  feed.offer(MATCH);
  assertEquals(feed.match?.version, 3);
  feed.offer({ ...MATCH, version: 4 });
  assertEquals(views.map((v) => v.version), [3, 4]);
  // Garbage and messages before a snapshot are ignored.
  sockets[0]!.receive("not json");
  sockets[0]!.receive({ type: "error", error: { code: "x", message: "y" } });
  await tick();
  assertEquals(views.length, 2);
  feed.close();
});

Deno.test("feed: events before the snapshot are ignored", () => {
  const { feed, sockets, views, loads } = setup(() => Promise.resolve(MATCH));
  sockets[0]!.receive({ type: "event", event: moveEvent(3, "b2") });
  assertEquals(views, []);
  assertEquals(loads, []);
  feed.close();
});

Deno.test("feed: concurrent reloads run one at a time, then once more", async () => {
  const pending: ((v: MatchView) => void)[] = [];
  const { feed, loads } = setup(() =>
    new Promise<MatchView>((resolve) => pending.push(resolve))
  );
  feed.reload();
  feed.reload();
  feed.reload();
  assertEquals(loads.length, 1);
  pending[0]!(MATCH);
  await tick();
  assertEquals(loads.length, 2);
  pending[1]!(MATCH);
  await tick();
  assertEquals(loads.length, 2);
  feed.close();
});

Deno.test("feed: once the Match has an Outcome it stops listening", async () => {
  const finished = { ...MATCH, outcome: WIN, toMove: null, version: 3 };
  const { feed, sockets, live } = setup(() => Promise.resolve(finished));
  const socket = sockets[0]!;
  socket.accept();
  socket.receive({ type: "snapshot", match: MATCH });
  socket.receive({
    type: "event",
    event: { ...moveEvent(3, "c3"), outcome: WIN, toMove: null },
  });
  assertEquals(socket.closed, true);
  assertEquals(live, [true, false]);
  await tick(10);
  // The reload (for the seed of a Game with chance) still lands.
  assertEquals(feed.match, finished);
  assertEquals(sockets.length, 1); // no reconnect
  feed.close();
});

Deno.test("feed: a dropped stream reloads over REST and reconnects with backoff", async () => {
  const { feed, sockets, views, live } = setup(() => Promise.resolve(MATCH));
  sockets[0]!.drop(); // never opened
  await tick();
  assertEquals(views, [MATCH]); // caught up over REST
  assertEquals(sockets.length, 2); // first retry after 0 ms
  sockets[1]!.drop();
  await tick();
  assertEquals(sockets.length, 2); // the next waits 5 ms
  await tick(10);
  assertEquals(sockets.length, 3);
  sockets[2]!.accept();
  sockets[2]!.receive({ type: "snapshot", match: { ...MATCH, version: 3 } });
  assertEquals(live, [false, false, true]);
  // Connected again: the backoff starts over.
  sockets[2]!.drop();
  await tick();
  assertEquals(sockets.length, 4);
  feed.close();
  assertEquals(sockets[3]!.closed, true);
});

Deno.test("feed: close() during the reconnect backoff opens no further socket", async () => {
  const { connect, sockets } = fakeConnect();
  const feed = new MatchFeed({
    matchId: "m 1",
    connect,
    load: () => Promise.resolve(MATCH),
    onMatch: () => {},
    onError: () => {},
    retryDelaysMs: [10],
  });
  sockets[0]!.drop();
  feed.close();
  await tick(30);
  assertEquals(sockets.length, 1);
});

Deno.test("feed: an unknown Match reports the error and stops", async () => {
  const missing = new ApiError("unknown-match", "No Match", 404);
  const { feed, sockets, errors } = setup(() => Promise.reject(missing));
  sockets[0]!.drop(); // the upgrade was refused
  await tick(10);
  assertEquals(errors, [missing]);
  assertEquals(sockets.length, 1);
  feed.reload(); // nothing happens once stopped
  await tick();
  assertEquals(errors, [missing]);
});

Deno.test("feed: other load failures are reported and the feed keeps trying", async () => {
  const offline = new ApiError("network", "offline", 0);
  let fail = true;
  const { feed, sockets, errors } = setup(() =>
    fail ? Promise.reject(offline) : Promise.resolve(MATCH)
  );
  sockets[0]!.drop();
  await tick();
  assertEquals(errors, [offline]);
  assertEquals(sockets.length, 2);
  fail = false;
  feed.reload();
  await tick();
  assertEquals(errors, [offline, null]);
  feed.close();
});
