---
status: accepted
---

# Engine workers run with read access to the Engine sources only

Engine code runs in a Web Worker the runner starts per search (`workerAdapter`). The worker is created with Deno's `deno.permissions` option granting `read` of the workspace source roots (`packages/`, `games/`, `engines/`) and nothing else: no net, env, write, run, ffi or sys, and no read of the server's own sources, the web build or any other file. An Engine can therefore compute but not exfiltrate, call out, spawn processes or read secrets; every attempt throws inside the worker and reaches the caller as `engine-error` (a Forfeit in a Match). Read of the source roots stays because `import(module)` in the worker is a run-time import that Deno checks against the worker's permissions (`permissions: "none"` fails it; statically known imports would not need it, but the module is only known per search). Engine sources are first-party and public, so this leaks nothing.

The option is unstable and needs `--unstable-worker-options`. It is enabled once, as `"unstable": ["worker-options"]` in the root `deno.json`, which applies to tasks, tests, type-checking and CI alike. We accept the flag: it is server-side only, Deno is pinned to `2.x` by CI, a breaking change would show up at once as failing sandbox tests (`engine-sandbox.test.ts`), and the alternative of running Engines unsandboxed is worse.

## Considered Options

- **Inherit the server's permissions** (before) — Engine code could use net, env and the read scope; fine for first-party Engines, not for third-party ones.
- **`permissions: "none"`** — does not work with the dynamic `import(module)`.
- **Out-of-process Engines** (#18) — stronger isolation (memory, CPU, native code), but a larger change; a further adapter behind the same runner seam, not a replacement for this.

## Consequences

- Test Engines live in `apps/server/src/test-engines/`; tests use `testWorkerAdapter()` (`engine-runner.testing.ts`), the same adapter with that directory added through `workerAdapter({ readDirs })`.
- Not covered: CPU and memory exhaustion inside the worker (the deadline terminates it, memory is not capped).
