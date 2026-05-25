# ADR-0296 — Async-shell: `timeout_behavior:"background"` + `bash_await` + `bash_kill`

## Status

Accepted (default-OFF — the new schema field is optional, absent ⇒ legacy
`"kill"` byte-identical path).

## Source

Cursor 3.2's `TimeoutBehavior.BACKGROUND` pattern. When a shell command
exceeds its deadline, Cursor (a) detaches the process, (b) returns a
shell-id placeholder, and (c) lets the model resume control later via a
sibling `wait`/`kill` pair. quanta's existing `bash` tool only had the
opposite half (`timeout_behavior:"kill"`: SIGTERM on deadline, typed
`timeout` failure).

## Context

The pre-ADR bash tool treats the deadline as a HARD stop:
`runShell(...)` kills the child via the escalating `SIGTERM → SIGKILL`
helper and surfaces a typed `{ mode: "timeout" }` failure
(`deriveBashFailure`). For long-running tooling (dev servers, builds,
file watchers) this is wrong: the model wants to *check in* on a
running process, not be forced to either pre-pick a long-enough timeout
or constantly poll-and-restart.

Three constraints shaped the design:

1. **No installation of new deps.** `nanoid` was the natural choice for
   shell-ids; instead we reuse `crypto.randomUUID()` (already used by
   `runtime/node-repl/state-store` + `runtime/shell-snapshot/file-store`).
2. **`src/runtime/shell.ts` is owned by another track and must not be
   mutated.** The background path runs its own `Bun.spawn(...)` (with
   the SAME `scrubEnv` allowlist and OS-sandbox argv wrapper as
   `runShell`) so the legacy `"kill"` mode falls through to the
   unchanged `runShell` byte-identically.
3. **No heuristics; only validated techniques.** Cap-and-evict LRU
   (`Map` insertion-order = LRU-by-insertion); poll interval reused
   from the proven `node-repl/default-kernel` (50 ms).

## Decision

Three additive surfaces:

### 1. `timeout_behavior` field on the existing `bash` tool

```ts
timeout_behavior: z.enum(["kill", "background"]).optional()
```

* `undefined` / `"kill"` ⇒ legacy `runShell(...)` path,
  byte-identical.
* `"background"` ⇒ delegate to the new bg-registry path.

The dispatch shape never changes for any caller that has not opted in.

### 2. `BashBgRegistry` — module-level in-memory store

`src/runtime/bash-bg-registry.ts`. Closed-port `BashProcessHandlePort`
DI seam (production wires `Bun.spawn`; tests pass a deterministic
fake). Capabilities:

* `register({command, cwd, signal})` → spawn + drain into a handle.
* `awaitHandle(id, {regex?, timeoutMs?, signal?})` → block on the FIRST
  of (a) exit, (b) regex match against `stdout\nstderr`, (c) deadline.
* `kill(id)` → escalating SIGTERM→SIGKILL + final snapshot.
* `killAll()` → session-shutdown cleanup of every running handle.

LRU cap default 16; overflow evicts the OLDEST entry (whose child is
killed before drop). The 50 ms poll cadence is reused from
`runtime/node-repl/default-kernel` — proven cadence, no heuristic.

### 3. Two new tools — `bash_await` + `bash_kill`

`src/tool/bash/await.ts` and `src/tool/bash/kill.ts`. Both consult the
module-level registry singleton; both never throw past the loop.

* `bash_await(shell_id, regex?, timeout_ms?)` —
  `isConcurrencySafe: () => true` (pure polling). Returns typed
  `not_found` for an unknown id; typed `timeout` (with `outputSoFar`)
  when the deadline elapses before exit/match.
* `bash_kill(shell_id)` — `isConcurrencySafe: () => false` (signals an
  OS process). Returns typed `not_found` for an unknown id; otherwise
  `ok:true` with the final stdout/stderr/exitCode.

Both are registered in `buildDefaultTools()` (sessions that never use
`timeout_behavior:"background"` never populate the registry, so the
default-tool slot is free).

## Non-decisions / negative invariants

* The bg-registry is **not** re-exported through `@/runtime/index.ts`.
  Consumers import from `@/runtime/bash-bg-registry` directly. Keeping
  the barrel surface tight prevents accidental cross-slice coupling.
* No global state mutation on `src/runtime/shell.ts`. The background
  path is a parallel implementation.
* No new dep (no `nanoid`, no `p-queue`, no LRU lib). The cap is
  enforced via insertion-ordered `Map` iteration; uuid via
  `crypto.randomUUID()`.
* `bash_await` does **not** cancel the underlying shell when its
  `ctx.signal` aborts — only the await unblocks. The shell continues
  running in the registry; the caller can `bash_kill` separately.
  Mirrors the contract on `subagent_await`.
* Mutating-table cross-check: `bash_await` is `null` (read-only),
  `bash_kill` is `"bash_mutating"` (same kind as `bash` because the
  signal is irreversible like a destructive shell call).

## Slice / wiring

* `src/runtime/bash-bg-registry.ts` (new).
* `src/tool/bash/await.ts` + `src/tool/bash/kill.ts` (new).
* `src/tool/bash/index.ts` — schema + execute branch (modified ONLY in
  the two designated regions; `mode` (Track A) and HITL patterns
  (Track C) are untouched).
* `src/tool/index.ts` — register two new tools + re-export types.
* `src/agent/mode.ts` — add `bash_await`/`bash_kill` to
  `MUTATING_TOOL_TABLE` (required by `ADR-0036` cross-check).
* `src/agent/side-conversation/run.ts` — add `bash_await` to
  `SIDE_CONVERSATION_TOOL_NAMES` (read-only invariant).
* `tests/unit/bash-async-hellgate.test.ts` (new, 29 cases).

## Validation

* `tsc --noEmit` — 0 errors in the slice; pre-existing user-in-flight
  errors unrelated.
* `biome check` — 0 errors / 0 warnings in the slice.
* `bun test tests/unit` — 13109 pass / 16 fail; the 16 fails are all
  pre-existing user-in-flight tracks (observability env-wiring, V4A,
  FoundryProviderAdapter, applyPatch atomicity, anti-regression scan
  of 14 violations none of which are in this slice).
