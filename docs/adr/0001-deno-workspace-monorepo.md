---
status: proposed
---

# Deno workspace monorepo in TypeScript

Server, web UI, Games and Engines live in one Deno workspace (root `deno.json` with `workspace` members), written in TypeScript, so all of them share the `@boardwright/core` contracts and one toolchain: `deno fmt`, `deno lint`, `deno check`, `deno test`, with no build step and no `node_modules`. Deno was chosen over Node + npm workspaces for its built-in tooling, web-standard APIs (`Deno.serve`, `fetch`, Web Workers for running Engines off the main thread) and explicit permissions, which suit running third-party Engine code. HTTP uses Hono for the same web-standards reason. Engines in other languages are not excluded: they would plug in through a future out-of-process engine protocol rather than a polyglot workspace.
