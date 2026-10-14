# External Engine protocol (version 1)

An **external Engine** is a program, written in any language, that the server starts as a process and talks to over its stdin and stdout. Why this design: [ADR 0008](adr/0008-external-engine-protocol.md). A complete example is [`examples/random-engine/random-engine.ts`](../examples/random-engine/random-engine.ts) (about 100 lines).

## Transport

- Every message is one JSON object on one line, UTF-8, ended by `\n` (a trailing `\r` is tolerated). Empty lines are ignored. Lines longer than 1 MiB are a protocol error.
- The server writes to the Engine's **stdin**; the Engine writes to its **stdout**. Nothing but protocol messages may go to stdout: logs belong on **stderr** (the server passes them to its own stderr).
- Every message has a `type`. Fields not listed here are ignored, so later versions can add some.
- The Engine must exit when it receives `quit` or when stdin closes (the server is gone).

## Notation and Analysis

Positions and Moves are strings in the Game's Notation, the same text the HTTP API uses (each Game's `notation`, e.g. `games/tic-tac-toe`). An Analysis is the `Analysis` of `packages/core` with Moves in Notation:

```json
{
  "depth": 2,
  "lines": [
    { "moves": ["b2", "a1"], "score": { "kind": "value", "value": 0.5 } }
  ]
}
```

A Score is `{ "kind": "value", "value": <finite number> }`, `{ "kind": "win-in", "plies": n }` or `{ "kind": "loss-in", "plies": n }`, from the perspective of the Seat to move at the Line's start. The Engine contract (`Engine.analyze` in `packages/core`; checked by `assertEngineContract`) applies unchanged:

- Depths are integers >= 1 and strictly increasing; only completed depths are reported.
- Each Analysis of a Position with a Seat to move has 1 to `limits.lines` (default 1) Lines, best first, each starting with a different legal Move; a Line ends at the next Chance event.
- A Position with a pending Chance event (Games with chance) has no Lines: `{ "depth": d, "lines": [], "score": <expected Score>, "seat": "<Seat>" }`, the Score from `seat`'s perspective.
- A terminal Position gets exactly one `{ "depth": 0, "lines": [] }`.
- At least one Analysis per search, even with `maxTimeMs: 0`.

## Messages

Server to Engine:

| `type`    | Fields                               | Meaning                                                                                                       |
| --------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `hello`   | `protocol` (1), `gameId`             | First message. The Engine is to play this Game.                                                               |
| `analyze` | `id` (integer), `position`, `limits` | Start a search. `limits.maxTimeMs` is always set; `maxDepth` and `lines` are optional (as in `SearchLimits`). |
| `stop`    | `id`                                 | Finish search `id` now. Ignore it if that search already ended.                                               |
| `quit`    |                                      | Exit.                                                                                                         |

Engine to server:

| `type`     | Fields                           | Meaning                                                                                                                          |
| ---------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ready`    | `protocol` (1), `gameId`, `name` | Reply to `hello`: the Engine plays `gameId` (must equal the requested one); `name` is shown to users unless the config sets one. |
| `analysis` | `id`, `analysis`                 | One completed depth of search `id`.                                                                                              |
| `done`     | `id`                             | Search `id` is over (also after `stop`).                                                                                         |
| `error`    | `id`, `message`                  | Search `id` failed (it is over). Without `id`, in reply to `hello`: the Engine refuses (e.g. an unsupported Game).               |

## Session

```
server: {"type":"hello","protocol":1,"gameId":"tic-tac-toe"}
engine: {"type":"ready","protocol":1,"gameId":"tic-tac-toe","name":"Random mover"}
server: {"type":"analyze","id":1,"position":".........:x","limits":{"maxTimeMs":5000,"lines":2}}
engine: {"type":"analysis","id":1,"analysis":{"depth":1,"lines":[{"moves":["b2"],"score":{"kind":"value","value":0}},{"moves":["a1"],"score":{"kind":"value","value":0}}]}}
engine: {"type":"done","id":1}
server: {"type":"analyze","id":2,"position":"....x....:o","limits":{"maxTimeMs":5000}}
...
server: {"type":"stop","id":2}
engine: {"type":"done","id":2}
server: {"type":"quit"}
```

- One search at a time per process: the server sends the next `analyze` only after `done` or `error` of the previous one. To search in parallel the server starts more processes of the same Engine, each with its own handshake.
- Search ids increase per process. Every `analysis`, `done` and `error` names the running search.
- The Engine should honour `limits.maxTimeMs` itself (counting from `analyze`) and finish with `done`. The server stops a search with `stop` when the client no longer needs it, and treats a search that runs past `maxTimeMs` plus a grace period (5 s by default) as hung.
- After `stop` the Engine answers `done` (or `error`) for that search within 1 s; `analysis` messages sent before that are dropped.

## What the server does when things go wrong

| Situation                                                                                   | Result for the search                   | The process                 |
| ------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------- |
| Command cannot start (not found, not allowed)                                               | `worker-error`                          | —                           |
| Process exits during handshake or search                                                    | `worker-error` (after what it streamed) | replaced on the next search |
| No `ready` within 10 s                                                                      | `timeout`                               | killed                      |
| `error` instead of `ready`; wrong `protocol` or `gameId`                                    | `engine-error`                          | killed                      |
| A line that is not a protocol message, a message for another search, or `ready` out of turn | `unreadable-reply`                      | killed                      |
| An `analysis` that breaks the Analysis shape                                                | `unreadable-reply`                      | stopped, then reused        |
| `error` for the search                                                                      | `engine-error`                          | reused                      |
| Search runs past `maxTimeMs` + grace                                                        | `timeout`                               | stopped, then reused        |
| No `done` within 1 s of `stop`                                                              | —                                       | killed                      |

In a Match, a failed search is retried once, then the Engine's Seat forfeits (the reason is the code above). After 3 failures in a row that cost a process, the Engine cools down: for 30 s its searches fail at once with `worker-error`, then it gets another try. A completed search resets the count.

## Configuration

External Engines are listed in a JSON file the server reads at startup: `BOARDWRIGHT_EXTERNAL_ENGINES`, by default `external-engines.json` at the repository root (git-ignored; no file means no external Engines):

```json
{
  "engines": [
    {
      "gameId": "tic-tac-toe",
      "id": "random",
      "command": "./random-engine.ts"
    },
    {
      "gameId": "chess",
      "id": "my-engine",
      "name": "My Engine",
      "command": "/opt/my-engine/bin/engine",
      "args": ["--protocol", "boardwright"],
      "cwd": "/opt/my-engine"
    }
  ]
}
```

- `gameId`, `id` (unique per Game, also among the built-in Engines) and `command` are required; `name` (default: the name from `ready`), `args` and `cwd` are optional.
- A `command` containing `/` and `cwd` are relative to the config file's directory, which is also the default `cwd`. A bare `command` is looked up on `PATH`. No shell is involved.
- Each command must be allowed with Deno's `--allow-run=<command>`; the server also needs `--allow-read` for the config file (and `--allow-env=BOARDWRIGHT_EXTERNAL_ENGINES` to read the variable). The `start`/`dev` tasks grant read of `external-engines.json` but run no commands; run the server with your own `--allow-run` list, or try `deno task start:example-engine`, which registers the example Engine for tic-tac-toe and backgammon.
- At startup every listed Engine is started and handshaken; any problem (unknown Game, missing run permission, failed handshake) stops the server with all problems listed.

External Engines are trusted: they run with the server's user and environment, not in the Engine sandbox of ADR 0006.
