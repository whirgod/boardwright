/**
 * Test support for the WebSocket streams; never import from production code.
 * Serves an app on a free loopback port and gives tests a message queue per
 * client socket.
 */

export interface TestServer {
  /** `ws://127.0.0.1:<port>` */
  readonly wsUrl: string;
  /** `http://127.0.0.1:<port>` */
  readonly httpUrl: string;
  shutdown(): Promise<void>;
}

export function serve(
  handler: (request: Request) => Response | Promise<Response>,
): TestServer {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    handler,
  );
  const { port } = server.addr as Deno.NetAddr;
  return {
    wsUrl: `ws://127.0.0.1:${port}`,
    httpUrl: `http://127.0.0.1:${port}`,
    shutdown: () => server.shutdown(),
  };
}

/** A client socket whose received JSON messages queue up for `next()`. */
export class TestClient {
  readonly #socket: WebSocket;
  readonly #inbox: unknown[] = [];
  #wake: (() => void) | undefined;
  readonly closed: Promise<void>;
  readonly opened: Promise<void>;

  constructor(url: string) {
    this.#socket = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.#socket.onopen = () => resolve();
      this.#socket.onerror = () => reject(new Error("WebSocket failed"));
    });
    this.closed = new Promise((resolve) => {
      this.#socket.onclose = () => resolve();
    });
    this.#socket.onmessage = (event) => {
      this.#inbox.push(JSON.parse(event.data as string));
      this.#wake?.();
    };
  }

  /** Connected client; rejects if the upgrade is refused. */
  static async connect(url: string): Promise<TestClient> {
    const client = new TestClient(url);
    try {
      await client.opened;
    } catch (error) {
      await client.closed;
      throw error;
    }
    return client;
  }

  send(message: unknown): void {
    this.#socket.send(
      typeof message === "string" ? message : JSON.stringify(message),
    );
  }

  sendRaw(data: string | Uint8Array<ArrayBuffer>): void {
    this.#socket.send(data);
  }

  /** The next message, in order; fails after `timeoutMs`. */
  async next<T = Record<string, unknown>>(timeoutMs = 3000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (this.#inbox.length === 0) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out waiting for a message");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    return this.#inbox.shift() as T;
  }

  /** Messages received and not yet taken. */
  get pending(): number {
    return this.#inbox.length;
  }

  async close(): Promise<void> {
    if (this.#socket.readyState < WebSocket.CLOSING) this.#socket.close();
    await this.closed;
  }
}

/** Polls until `condition` holds; fails after `timeoutMs`. */
export async function until(
  condition: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
