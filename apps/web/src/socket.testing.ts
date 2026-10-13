// Fake sockets for tests of stream logic (not bundled: only tests import it).
import type { Connect, SocketHandlers, StreamSocket } from "./socket.ts";

export class FakeSocket implements StreamSocket {
  readonly sent: unknown[] = [];
  closed = false;
  open = false;

  constructor(readonly path: string, readonly handlers: SocketHandlers) {}

  send(text: string): void {
    if (this.open && !this.closed) this.sent.push(JSON.parse(text));
  }

  close(): void {
    this.closed = true;
  }

  /** The server accepted the connection. */
  accept(): void {
    this.open = true;
    this.handlers.onOpen();
  }

  /** The server sends a message. */
  receive(message: unknown): void {
    this.handlers.onMessage(
      typeof message === "string" ? message : JSON.stringify(message),
    );
  }

  /** The connection drops (or never opened). */
  drop(): void {
    this.open = false;
    this.handlers.onClose();
  }
}

/** A `Connect` that records every socket it opens. */
export function fakeConnect(): { connect: Connect; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    connect: (path, handlers) => {
      const socket = new FakeSocket(path, handlers);
      sockets.push(socket);
      return socket;
    },
  };
}

/** Lets pending promise callbacks and zero-delay timers run. */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
