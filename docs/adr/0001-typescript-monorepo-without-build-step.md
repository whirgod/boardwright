---
status: proposed
---

# TypeScript monorepo with npm workspaces and no build step

Server, web UI, Games and Engines live in one npm-workspaces monorepo written in TypeScript, so all of them share the `@boardwright/core` contracts and a single toolchain. Packages export their `.ts` sources directly and Node (>= 24) runs them via native type stripping; `tsc` only typechecks (`noEmit`). This keeps the repo free of per-package builds, at the cost of restricting code to erasable TypeScript syntax (no `enum`, no parameter properties, no namespaces) and importing with explicit `.ts` extensions. Engines in other languages are not excluded: they would plug in through a future out-of-process engine protocol rather than a polyglot workspace.
