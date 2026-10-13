---
status: proposed
---

# Web UI: Preact, bundled by `deno bundle`, served as static files by the server

The browser UI (`apps/web`) is a Preact single-page app written in TSX, bundled with Deno's built-in `deno bundle --platform=browser` from an HTML entrypoint into `apps/web/dist/` (git-ignored), and served by `apps/server` as static files at every non-API path (`buildApp({ webRoot })`, via `@std/http`'s `serveDir`). Pages route with the URL hash, so the server needs no fallback routing and stays a plain API + file host. `deno task start` builds the UI and starts the server; `deno task dev` runs the bundler and the server in watch mode together.

Why: it keeps the one-toolchain, no-`node_modules` workspace of ADR 0001 — the UI type-checks, lints, formats and tests with the rest (`apps/web` only adds the DOM lib and Preact's JSX settings to its `compilerOptions`) and can import Games directly to decode Positions with their Notation for board rendering. Preact (pinned exactly, `npm:preact@10.29.8`) gives components and hooks for about 4 KB gzipped; vanilla DOM code would get unwieldy once Review and live Analysis overlays arrive.

Considered and rejected: **Fresh** (server-rendered islands framework) — would replace Hono as the server's framework or run beside it, and server rendering buys little for an interactive board; **Vite** via npm — a second toolchain with `node_modules` and its own config; **plain DOM, no framework** — smallest, but state-heavy pages (polling, selection, overlays) become manual DOM bookkeeping; **bundling at server start (`Deno.bundle()`)** — needs the `--unstable-bundle` flag and runs the bundler (and grants its permissions) inside the server process.

Consequences: `deno bundle` is still marked experimental, so its flags may change, and HTML entrypoints need Deno >= 2.5; the build is one task (`apps/web` `build`) and easy to swap. The UI has a build step even though the rest of the workspace does not. Logic that needs no DOM (API client, routes, Match status, board renderers) lives in plain `.ts` modules tested with `deno test`; the `.tsx` components stay thin and are verified by running the app.
