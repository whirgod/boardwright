import { assertEquals } from "@std/assert";
import { streamUrl, webSocketConnect } from "./socket.ts";

Deno.test("streamUrl: ws on http, wss on https, same host", () => {
  const path = "/api/analysis/stream";
  assertEquals(
    streamUrl(path, { protocol: "http:", host: "127.0.0.1:3000" }),
    "ws://127.0.0.1:3000/api/analysis/stream",
  );
  assertEquals(
    streamUrl(path, { protocol: "https:", host: "example.org" }),
    "wss://example.org/api/analysis/stream",
  );
});

/** An echo server: replies to each text message with "echo:<text>". */
function echoServer() {
  return Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const { socket, response } = Deno.upgradeWebSocket(request);
      socket.onmessage = (e) => socket.send(`echo:${e.data}`);
      return response;
    },
  );
}

Deno.test("webSocketConnect: opens, exchanges text, reports the close once", async () => {
  const server = echoServer();
  const page = { protocol: "http:", host: `127.0.0.1:${server.addr.port}` };
  const events: string[] = [];
  const closed = Promise.withResolvers<void>();
  const socket = webSocketConnect(page)("/x", {
    onOpen: () => {
      events.push("open");
      socket.send("hi");
    },
    onMessage: (text) => {
      events.push(text);
      // Ask the server to close: our handler must run exactly once.
      server.shutdown();
    },
    onClose: () => {
      events.push("close");
      closed.resolve();
    },
  });
  socket.send("dropped: not open yet");
  await closed.promise;
  await server.finished;
  assertEquals(events, ["open", "echo:hi", "close"]);
});

Deno.test("webSocketConnect: a refused connection reports onClose", async () => {
  const server = echoServer();
  const port = server.addr.port;
  await server.shutdown();
  const closed = Promise.withResolvers<void>();
  webSocketConnect({ protocol: "http:", host: `127.0.0.1:${port}` })("/x", {
    onOpen: () => {},
    onMessage: () => {},
    onClose: () => closed.resolve(),
  });
  await closed.promise;
});

Deno.test("webSocketConnect: no handler runs after close()", async () => {
  const server = echoServer();
  const page = { protocol: "http:", host: `127.0.0.1:${server.addr.port}` };
  const events: string[] = [];
  const opened = Promise.withResolvers<void>();
  const socket = webSocketConnect(page)("/x", {
    onOpen: () => opened.resolve(),
    onMessage: (text) => events.push(text),
    onClose: () => events.push("close"),
  });
  await opened.promise;
  socket.send("late");
  socket.close();
  socket.send("after close");
  await server.shutdown();
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(events, []);
});
