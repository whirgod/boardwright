// The WebSocket seam of the two streams (docs/ARCHITECTURE.md, "Streams").
// Stream logic (`match-feed.ts`, `analysis-client.ts`) only sees `Connect`,
// so tests drive it with fake sockets.

export interface SocketHandlers {
  onOpen(): void;
  /** One text message (both streams send one JSON object per message). */
  onMessage(text: string): void;
  /** The connection ended or never opened; called at most once, never after `close()`. */
  onClose(): void;
}

export interface StreamSocket {
  /** Sends a text message; dropped unless the socket is open. */
  send(text: string): void;
  /** Closes the socket; no handler runs afterwards. */
  close(): void;
}

/** Opens a stream at an API path such as `/api/analysis/stream`. */
export type Connect = (path: string, handlers: SocketHandlers) => StreamSocket;

/** The WebSocket URL of an API path on the page's own server (`ws:` or `wss:`). */
export function streamUrl(
  path: string,
  page: { readonly protocol: string; readonly host: string },
): string {
  const scheme = page.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${page.host}${path}`;
}

/** `Connect` with the platform's `WebSocket`, against `page` (the browser's `location`). */
export function webSocketConnect(
  page: { readonly protocol: string; readonly host: string },
): Connect {
  return (path, handlers) => {
    const ws = new WebSocket(streamUrl(path, page));
    let ended = false;
    ws.onopen = () => {
      if (!ended) handlers.onOpen();
    };
    ws.onmessage = (event) => {
      if (!ended && typeof event.data === "string") {
        handlers.onMessage(event.data);
      }
    };
    // An `error` is always followed by `close`.
    ws.onclose = () => {
      if (ended) return;
      ended = true;
      handlers.onClose();
    };
    return {
      send(text) {
        if (!ended && ws.readyState === WebSocket.OPEN) ws.send(text);
      },
      close() {
        ended = true;
        ws.close();
      },
    };
  };
}
