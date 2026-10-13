import { assert, assertEquals, assertRejects } from "@std/assert";
import { ticTacToe } from "@boardwright/game-tic-tac-toe";
import { diceRace } from "@boardwright/testing";
import { buildApp } from "./app.ts";
import {
  type CreatedMatch,
  GameMaster,
  type MatchEvent,
  type MatchView,
} from "./game-master.ts";
import { type AnyGameRules, GameRegistry } from "./games.ts";
import { InMemoryMatchStore } from "./match-store.ts";
import { MatchFollower, type MatchStreamMessage } from "./match-stream.ts";
import { serve, TestClient, type TestServer, until } from "./stream.testing.ts";

const HUMANS = { x: { kind: "human" }, o: { kind: "human" } } as const;

function setup() {
  const master = new GameMaster({
    games: new GameRegistry([ticTacToe, diceRace as AnyGameRules]),
    store: new InMemoryMatchStore(),
    rollRetryDelaysMs: [1, 1],
  });
  const server = serve(buildApp({ master }).fetch);
  return { master, server };
}

const playMove = (
  master: GameMaster,
  created: CreatedMatch,
  seat: string,
  move: string,
) =>
  master.apply(created.match.id, { token: created.tokens[seat]! }, {
    kind: "move",
    move,
  });

const streamUrl = (server: TestServer, id: string) =>
  `${server.wsUrl}/api/matches/${id}/stream`;

async function withStreams(
  run: (ctx: ReturnType<typeof setup>) => Promise<void>,
) {
  const ctx = setup();
  try {
    await run(ctx);
  } finally {
    await ctx.server.shutdown();
  }
}

Deno.test("connect: a snapshot of the Match comes first", async () => {
  await withStreams(async ({ master, server }) => {
    const created = await master.createMatch("tic-tac-toe", HUMANS);
    await playMove(master, created, "x", "a1");
    const client = await TestClient.connect(
      streamUrl(server, created.match.id),
    );
    const message = await client.next();
    assertEquals(message, {
      type: "snapshot",
      match: JSON.parse(
        JSON.stringify(await master.getMatch(created.match.id)),
      ),
    });
    assertEquals((message.match as MatchView).version, 2);
    assert(!JSON.stringify(message).includes(created.tokens.x!));
    await client.close();
  });
});

Deno.test("a Move is broadcast to every client, in version order", async () => {
  await withStreams(async ({ master, server }) => {
    const created = await master.createMatch("tic-tac-toe", HUMANS);
    const url = streamUrl(server, created.match.id);
    const clients = [
      await TestClient.connect(url),
      await TestClient.connect(url),
    ];
    for (const client of clients) {
      assertEquals((await client.next()).type, "snapshot");
    }
    await playMove(master, created, "x", "a1");
    await playMove(master, created, "o", "a2");
    for (const client of clients) {
      const first = await client.next() as { type: string; event: MatchEvent };
      const second = await client.next() as { type: string; event: MatchEvent };
      assertEquals(first.type, "event");
      assertEquals(
        [first.event, second.event].map((e) => [e.kind, e.version]),
        [["move", 2], ["move", 3]],
      );
      assertEquals(first.event.kind === "move" && first.event.move, "a1");
      assertEquals(first.event.toMove, "o");
      assertEquals(
        second.event.position,
        (await master.getMatch(created.match.id)).position,
      );
      await client.close();
    }
  });
});

Deno.test("events of other Matches are not sent", async () => {
  await withStreams(async ({ master, server }) => {
    const one = await master.createMatch("tic-tac-toe", HUMANS);
    const two = await master.createMatch("tic-tac-toe", HUMANS);
    const client = await TestClient.connect(streamUrl(server, one.match.id));
    await client.next();
    await playMove(master, two, "x", "a1");
    await playMove(master, one, "x", "b1");
    const event = await client.next() as { event: MatchEvent };
    assertEquals(event.event.matchId, one.match.id);
    assertEquals(event.event.kind === "move" && event.event.move, "b1");
    await client.close();
  });
});

Deno.test("an Outcome by the rules arrives as part of the final Move event", async () => {
  await withStreams(async ({ master, server }) => {
    const created = await master.createMatch("tic-tac-toe", HUMANS);
    const client = await TestClient.connect(
      streamUrl(server, created.match.id),
    );
    await client.next();
    for (
      const [seat, move] of [["x", "a1"], ["o", "a2"], ["x", "b1"], [
        "o",
        "b2",
      ], ["x", "c1"]] as const
    ) {
      await playMove(master, created, seat, move);
    }
    let last: MatchEvent | undefined;
    for (let i = 0; i < 5; i++) {
      last = (await client.next() as { event: MatchEvent }).event;
    }
    assertEquals(last!.version, 6);
    assertEquals(last!.toMove, null);
    assertEquals(last!.outcome?.kind, "rules");
    await client.close();
  });
});

Deno.test("a Resignation Outcome is streamed", async () => {
  await withStreams(async ({ master, server }) => {
    const created = await master.createMatch("tic-tac-toe", HUMANS);
    const client = await TestClient.connect(
      streamUrl(server, created.match.id),
    );
    await client.next();
    await master.apply(created.match.id, { token: created.tokens.o! }, {
      kind: "resignation",
    });
    const { event } = await client.next() as { event: MatchEvent };
    assertEquals(event.kind, "resignation");
    assertEquals(event.outcome?.kind, "resignation");
    await client.close();
  });
});

Deno.test("Chance events are streamed as their own events", async () => {
  await withStreams(async ({ master, server }) => {
    const created = await master.createMatch("dice-race", {
      a: { kind: "human" },
      b: { kind: "human" },
    });
    // The opening roll already happened: it is in the snapshot's Move list.
    const client = await TestClient.connect(
      streamUrl(server, created.match.id),
    );
    const snapshot = await client.next() as { match: MatchView };
    assertEquals(snapshot.match.moves[0]?.kind, "chance");

    const seat = snapshot.match.toMove!;
    await playMove(master, created, seat, snapshot.match.legalMoves[0]!);
    const move = await client.next() as { event: MatchEvent };
    const chance = await client.next() as { event: MatchEvent };
    assertEquals(move.event.kind, "move");
    assertEquals(chance.event.kind, "chance");
    assertEquals(chance.event.version, move.event.version + 1);
    assert(
      "chance" in chance.event && typeof chance.event.chance === "string",
    );
    await client.close();
  });
});

Deno.test("an unknown Match is refused before the upgrade", async () => {
  await withStreams(async ({ server }) => {
    await assertRejects(() => TestClient.connect(streamUrl(server, "nope")));
    const res = await fetch(`${server.httpUrl}/api/matches/nope/stream`);
    assertEquals(res.status, 404);
    assertEquals((await res.json()).error.code, "unknown-match");
  });
});

Deno.test("the Match stream takes no messages and says where Moves go", async () => {
  await withStreams(async ({ master, server }) => {
    const created = await master.createMatch("tic-tac-toe", HUMANS);
    const client = await TestClient.connect(
      streamUrl(server, created.match.id),
    );
    await client.next();
    client.send({ type: "move", move: "a1", token: created.tokens.x });
    const reply = await client.next() as {
      type: string;
      error: { code: string; message: string };
    };
    assertEquals(reply.type, "error");
    assertEquals(reply.error.code, "invalid-request");
    assert(reply.error.message.includes("POST /api/matches/:id/moves"));
    // Nothing was played.
    assertEquals((await master.getMatch(created.match.id)).version, 1);
    await client.close();
  });
});

/** A referee whose `getMatch` waits on a gate and can answer with a stale view. */
class GatedMaster extends GameMaster {
  readonly gate = Promise.withResolvers<void>();
  snapshot: MatchView | undefined;
  current(id: string): Promise<MatchView> {
    return super.getMatch(id);
  }
  override async getMatch(id: string): Promise<MatchView> {
    await this.gate.promise;
    return this.snapshot ?? await super.getMatch(id);
  }
}

Deno.test("MatchFollower: events racing the snapshot are neither lost nor repeated", async () => {
  const master = new GatedMaster({
    games: new GameRegistry([ticTacToe]),
    store: new InMemoryMatchStore(),
  });
  const created = await master.createMatch("tic-tac-toe", HUMANS);
  const sent: MatchStreamMessage[] = [];
  const follower = new MatchFollower(
    master,
    created.match.id,
    (m) => sent.push(m),
  );
  const starting = follower.start(); // subscribed, snapshot gated
  await playMove(master, created, "x", "a1"); // v2: ends up inside the snapshot
  master.snapshot = await master.current(created.match.id);
  assertEquals(master.snapshot.version, 2);
  await playMove(master, created, "o", "a2"); // v3: newer than the snapshot
  master.gate.resolve();
  await starting;
  await playMove(master, created, "x", "b1"); // v4: live
  follower.close();
  assertEquals(
    sent.map((m) =>
      m.type === "snapshot"
        ? ["snapshot", m.match.version]
        : m.type === "event"
        ? [m.event.kind, m.event.version]
        : [m.type]
    ),
    [["snapshot", 2], ["move", 3], ["move", 4]],
  );
});

Deno.test("closing the socket unsubscribes from the referee", async () => {
  const { master, server } = setup();
  let subscribed = 0;
  let unsubscribed = 0;
  const subscribe = master.onMatchChanged.bind(master);
  master.onMatchChanged = (listener) => {
    subscribed++;
    const off = subscribe(listener);
    return () => {
      unsubscribed++;
      off();
    };
  };
  try {
    const created = await master.createMatch("tic-tac-toe", HUMANS);
    const client = await TestClient.connect(
      streamUrl(server, created.match.id),
    );
    await client.next();
    assertEquals([subscribed, unsubscribed], [1, 0]);
    await client.close();
    await until(() => unsubscribed === 1);
  } finally {
    await server.shutdown();
  }
});

Deno.test("a cross-origin upgrade is refused, same-origin and no Origin pass", async () => {
  await withStreams(async ({ master, server }) => {
    const created = await master.createMatch("tic-tac-toe", HUMANS);
    const host = new URL(server.httpUrl).host;
    for (const path of [`/api/matches/${created.match.id}/stream`]) {
      for (const origin of ["http://evil.example", "not a url"]) {
        const res = await fetch(server.httpUrl + path, {
          headers: { origin, upgrade: "websocket", connection: "Upgrade" },
        });
        assertEquals(res.status, 403);
        assertEquals((await res.json()).error.code, "forbidden-origin");
      }
      // Same host passes the guard (this plain request then fails the upgrade itself).
      const res = await fetch(server.httpUrl + path, {
        headers: { origin: `http://${host}` },
      });
      assert(res.status !== 403);
      await res.body?.cancel();
    }
  });
});

Deno.test("MatchFollower: nothing is sent after close, and a missing Match rejects", async () => {
  const { master } = setup();
  const created = await master.createMatch("tic-tac-toe", HUMANS);
  const sent: MatchStreamMessage[] = [];
  const follower = new MatchFollower(
    master,
    created.match.id,
    (m) => sent.push(m),
  );
  await follower.start();
  follower.close();
  follower.close(); // idempotent
  await playMove(master, created, "x", "a1");
  assertEquals(sent.length, 1);

  const missing = new MatchFollower(master, "nope", (m) => sent.push(m));
  await assertRejects(() => missing.start());

  // Closed before the snapshot arrives: nothing is sent.
  const early = new MatchFollower(
    master,
    created.match.id,
    (m) => sent.push(m),
  );
  const starting = early.start();
  early.close();
  await starting;
  assertEquals(sent.length, 1);
});
