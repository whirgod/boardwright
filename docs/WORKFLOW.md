# Multi-agent workflow

Use this for **large, open-ended tasks** (e.g. "work through the roadmap", "add chess support").
Small, well-defined changes don't need it: just do them on a branch and open a PR.

## Roles

- **Coordinator** — the session the user talks to. Plans, splits work into tasks, spawns and
  steers subagents, merges. Writes little code itself; keeps its own context small by
  delegating reading and reviewing.
- **Implementer** — a subagent working on one task in its **own git worktree**
  (`isolation: "worktree"`), on branch `task/<issue>-<slug>`. Ends by opening a PR.
- **Reviewer** — a fresh subagent that reviews one PR and posts findings on GitHub.
  Never the implementer of that PR.

## Task tracking

Tasks are **GitHub issues** (the source of truth across sessions), labelled:

- `wave:<n>` — tasks in the same wave are independent and may run in parallel; a wave starts
  only after the waves it depends on are merged. Each issue lists its `Depends on: #..`.
- `model:haiku|sonnet|opus` — implementer size:
  - `haiku`: mechanical changes, docs, renames, config.
  - `sonnet` (default): a well-specified feature in one or two packages.
  - `opus`: design-heavy or intricate work — new contracts, cross-cutting API design,
    tricky algorithms/rules (chess, backgammon chance), anything needing an ADR.
- `paused` — work stopped for usage limits; the PR/issue has a resume note.

`docs/ROADMAP.md` stays the high-level, ordered view and links the issues.

## Lifecycle of a task

1. **Plan** (coordinator): write/refresh the issue — goal, scope, out-of-scope, acceptance
   criteria, files/packages touched, test expectations, dependencies, model label. Avoid two
   parallel tasks editing the same files; changes to `packages/core` contracts get their own
   task or are explicitly assigned to one task in the wave.
2. **Implement** (implementer, background, worktree):
   - Branch from up-to-date `main`; read `AGENTS.md` and the issue first.
   - Small commits; `deno task check` must pass (fmt, lint, typecheck, tests, coverage thresholds).
   - Tests cover the acceptance criteria, including edge cases and error paths.
   - Update docs (`AGENTS.md`, `docs/`, `GLOSSARY.md`, ADRs) in the same PR when affected —
     **except `docs/ROADMAP.md`**, which only the coordinator edits (at merge) to avoid every
     parallel PR conflicting on it.
   - Push and open a PR with `gh pr create` using the PR template; body contains `Closes #<issue>`.
   - Report back: PR URL, summary, anything uncertain.
3. **Validate**: CI (`.github/workflows/ci.yml`) runs `deno task check` on every PR. A red PR is
   sent back to its implementer before review.
4. **Review** (reviewer subagent, usually `opus` for `opus` tasks, else `sonnet`):
   - Read the issue and the diff (`gh pr diff`), check out the branch if needed, run checks.
   - Look for: correctness bugs, contract/architecture violations (ADRs, dependency rules),
     missing or weak tests, glossary misuse, missing doc updates, security issues.
   - Post **one** GitHub review (`gh api repos/{owner}/{repo}/pulls/<n>/reviews`, event
     `COMMENT`) with inline comments, each prefixed `[major]`, `[minor]` or `[nit]`.
     `[major]` = must fix before merge (bugs, missing tests for core behaviour, rule
     violations). Return a summary with counts per severity.
5. **Fix loop**: the coordinator sends the findings to the **same implementer** (`SendMessage`,
   so it keeps its context). It fixes, pushes, and replies on each GitHub comment with what it
   did. Then a **new review round** of the changed parts. Repeat until no `[major]` findings
   remain (cap: 3 rounds, then the coordinator decides or asks the user).
6. **Merge** (coordinator): CI green + no open `[major]` → squash-merge
   (`gh pr merge --squash --delete-branch`). Unaddressed `[minor]`s become follow-up issues.
   `main` requires branches to be up to date: if the PR is behind or conflicts only in docs, the
   coordinator rebases it in a scratch worktree, resolves, re-runs `deno task check`, pushes
   (`--force-with-lease`) and merges; code conflicts go back to the implementer.
   Update `docs/ROADMAP.md` if a roadmap item is complete. Then start dependent tasks.

## Usage limits

Subagents share the user's Claude plan limits (5-hour and 7-day windows). Running out mid-task
loses work, so pace and checkpoint.

- **Reading usage**: `scripts/claude-usage.sh` prints the latest snapshot from
  `~/.claude/state/rate-limits.json`. The snapshot is written by the user's status line
  (`~/.claude/statusline-command.sh`) and refreshes while the coordinator session is active;
  it lags the agents' real consumption, so keep margins. If missing, ask the user to run `/usage`.
- **Heartbeat**: while subagents run, the coordinator schedules a recurring check (CronCreate,
  ~every 7 min) that runs the script and applies the thresholds. This also keeps the snapshot
  fresh for implementers, since it only refreshes while the coordinator session is active.
  Delete the heartbeat when no subagents are running.
- **When to check**: coordinator before spawning anything, on every heartbeat and whenever a
  subagent reports;
  implementers before each major step (e.g. every commit).
- **Thresholds** (5-hour window; treat the 7-day window ≥ 90% the same as 5h ≥ 85%):
  - `< 70%` — normal. Typically ≤ 3 implementers in parallel (plus reviewers). Expect roughly
    1–2 % of the 5h window per minute with 3–4 agents running; plan waves accordingly.
  - `70–85%` — start nothing new; let running agents finish their current step.
  - `≥ 85%` — **checkpoint**: implementers commit and push WIP (open a **draft** PR if none),
    write a resume note (what's done, what's next, open questions) as a PR or issue comment,
    add the `paused` label, and stop. The coordinator records the plan state on the issues,
    then schedules a one-shot resume shortly after the window's `resets_at` (CronCreate)
    and stops spawning.
- **Resuming**: find `paused` issues/PRs, re-spawn an implementer (fresh context) pointed at the
  branch and resume note, remove the label, continue the lifecycle.

## Coordinator checklist

- Keep a short status table (task, issue, PR, state) in the conversation; the durable state is
  on GitHub.
- Prefer few, well-scoped tasks over many tiny ones; each PR should be reviewable in one sitting.
- Never merge red CI or a PR with open `[major]` findings.
- Keep `AGENTS.md`, this file and `docs/ROADMAP.md` current as the process evolves.
