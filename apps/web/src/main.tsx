// Browser entry point, bundled by `deno task build:web` (ADR 0004).
import "./style.css";
import { render } from "preact";
import { ApiClient } from "./api.ts";
import { App } from "./app.tsx";
import { SeatTokens } from "./seat-tokens.ts";

function localStorageOrUndefined(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // Blocked (e.g. privacy settings): keep tokens in memory.
  }
}

render(
  <App
    api={new ApiClient()}
    tokens={new SeatTokens(localStorageOrUndefined())}
  />,
  document.getElementById("app")!,
);
