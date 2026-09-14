# ADR-0249: Node REPL persistent kernel — Jupyter-style per-session node process

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0204 (shell-snapshot — per-turn shell prefix sibling, also under `src/runtime/`),
  ADR-0238 (Bun.spawn production adapter idiom this slice mirrors),
  Codex `~/.codex/node_repl/active_execs/{execId}.json` pattern.
- **References**:
  `src/runtime/node-repl/types.ts` (typed `KernelId`, `KernelSpec`, `KernelState`,
  `ExecResult`, `KernelError`),
  `src/runtime/node-repl/port.ts` (closed `NodeReplKernel` port),
  `src/runtime/node-repl/default-kernel.ts` (production node-REPL adapter; `node -i` until sep-14),
  `src/runtime/node-repl/state-store.ts` (`<quanta home>/node_repl/active_execs/{id}.json`, 0600/0700),
  `src/runtime/node-repl/headless-stub.ts` (deterministic test adapter — no real spawn),
  `src/runtime/node-repl/index.ts` (barrel),
  `tests/unit/runtime/node-repl-hellgate.test.ts` (16 cases at acceptance; later real-kernel protocol arms added).

**ADR-number reconciliation.** Initially booked 0248 but a parallel-track ADR
landed on that number first; per the user-deference / parallel-track renumber
policy this slice moved to the next-free **0249** (cross-refs in src / tests /
catalog updated atomically).

## Context

Codex absorbs a long-running `node -i` REPL per session, persisting handle
metadata at `~/.codex/node_repl/active_execs/{execId}.json`. Variables
defined in one turn (`let x = 42`) remain reachable in the next
(`console.log(x)` → `42`). The kernel is the persistence unit; the
on-disk JSON only stores the handle (pid / startedAtMs / lastUseMs /
sessionId) so a crashed CLI can list / kill orphaned kernels on next
launch — the *state* (variable bindings) lives in the live node process.

quanta has no equivalent. Every turn that runs node code today re-spawns
the interpreter, losing per-turn computation. The cost is observable on
long evaluation sessions and on `--continue` resume flows that want to
re-attach an interpreter the user was iterating in.

This ADR ships the slice primitive (closed port + production adapter +
state-store + deterministic test stub + 16-case hellgate). Wiring into
a tool, into the composition root, and integration with conversation
checkpoint / fork is deferred — the catalog entry records the deliberate
hold.

## Decision

### Slice layout

```
src/runtime/node-repl/
  types.ts            — KernelId, KernelSpec, KernelState, ExecResult, KernelError
  port.ts             — NodeReplKernel { spawn, exec, status, kill, list }
  default-kernel.ts   — promptless node:repl + line-protocol stdin/stdout
  state-store.ts      — <quanta home>/node_repl/active_execs/{id}.json (0600 / dir 0700)
  headless-stub.ts    — deterministic no-spawn adapter for tests
  index.ts            — barrel
```

### Types (`types.ts`)

```ts
export type KernelId = Id<"NodeReplKernel">

export type KernelState = "starting" | "ready" | "running" | "idle" | "dead"

export interface KernelSpec {
  readonly id: KernelId
  readonly pid: number
  readonly startedAtMs: number
  readonly lastUseMs: number
  readonly sessionId: string
}

export interface ExecResult {
  readonly id: KernelId
  readonly stdout: string
  readonly stderr: string
  readonly hadError: boolean
}

export type KernelError =
  | { kind: "node-missing"; detail: string }
  | { kind: "kernel-dead"; id: KernelId }
  | { kind: "spawn-failed"; detail: string }
  | { kind: "exec-aborted"; id: KernelId }
  | { kind: "invalid-id"; raw: string }
```

`KernelState` is a closed string union — no enum object so it stays a
zero-runtime-cost type.

### Port (`port.ts`)

```ts
export interface NodeReplSpawnOptions {
  readonly sessionId: string
  readonly id?: string                // sanitized + nonce-suffixed if supplied
  readonly signal?: AbortSignal       // abort propagates to exec only; spawn is sync
}

export interface NodeReplExecOptions {
  readonly signal?: AbortSignal       // abort kills the process and resolves with exec-aborted
  readonly timeoutMs?: number         // hard cap per exec; past it the process is killed (exec-timeout)
}

export interface NodeReplKernel {
  spawn(opts: NodeReplSpawnOptions): Promise<Result<KernelSpec, KernelError>>
  exec(id: KernelId, code: string, opts?: NodeReplExecOptions):
    Promise<Result<ExecResult, KernelError>>
  status(id: KernelId): KernelState
  kill(id: KernelId): Promise<void>
  list(): ReadonlyArray<{ spec: KernelSpec; state: KernelState; inUse: boolean }>
}
```

`inUse` distinguishes a kernel currently running an exec (state "running")
from one that's "ready" / "idle" — the wire-layer queue / round-robin can
schedule on it.

### Default adapter (`default-kernel.ts`)

- Spawned through the scrubbed-env funnel as `node --no-warnings -e <boot>`. **Amended
  sep-14 (three times — see the module doc for each measured failure):** the boot script
  starts `node:repl` with a private input and output, rebinds `console` to the process,
  and reads one JSON line `{ code, sentinel }` per command from stdin. Each command is
  evaluated WHOLE by the REPL's `eval` (no readline line splitting), one at a time; it is
  finished by its callback or by the REPL writing an uncaught error to its private
  output (routed to stderr), whichever comes first. The value, if any, goes to stdout;
  after two `setImmediate` turns the sentinel goes to stderr then stdout, and the kernel
  reads each stream up to it. `hadError` is "the exec wrote to stderr" (a throw does).
  Same behaviour measured on Node 22 and 25. The earlier `node -i` + prompt scrub, the
  line-fed promptless REPL, and a serialised-eval variant each mis-attributed output.
- State transitions: `starting` → (warm-up sentinel read) → `ready` → (exec
  in flight) → `running` → (exec done) → `idle` → … → `dead` (process
  exit, kill, or unrecoverable parse error).
- AbortSignal during `exec` kills the process and resolves with
  `{ kind: "exec-aborted" }`; an exec past `timeoutMs` kills it and resolves with
  `{ kind: "exec-timeout" }` (round-10: this was `kernel-dead`, rendered "process
  exited"). Either way the kernel is `dead` and not restarted; the `node_repl` tool
  spawns a fresh session kernel on its next exec (it used to keep the dead id).
  (Amended sep-14: abort once wrote `.exit` to stdin; the channel now carries JSON
  commands only.)
- Synchronous `Bun.spawn` throw on ENOENT (`node` not on PATH) becomes
  `{ kind: "node-missing", detail }` — same idiom as
  `shell-snapshot/bun-spawner.ts`.

### State store (`state-store.ts`)

- Directory: `<quanta home>/node_repl/active_execs/` (mode 0700, created on
  first write). **Amended sep-14:** was `~/.quanta/…` from `os.homedir()`, which ignored
  a relocated `QUANTA_HOME`.
- Per-kernel file: `{id}.json`, mode 0600, body:
  `{ id, pid, startedAtMs, lastUseMs, sessionId }`.
- Written on spawn-success; updated on every successful `exec` (the
  `lastUseMs` bump); deleted on `kill` / process-death detection.
- A startup `list()` call reads the directory and probes each pid; any
  file whose pid is no longer alive is removed (orphan reaper).
- `safeId(raw)` mirrors the shell-snapshot pattern — strip
  `/[^A-Za-z0-9._-]/`, drop leading `[-.]`, length-cap 48, nonce-suffix
  8 hex from `crypto.randomUUID()`. Empty after sanitisation →
  `{ kind: "invalid-id", raw }`.

### Headless stub (`headless-stub.ts`)

- Returns the closed `NodeReplKernel` port with deterministic behaviour:
  - `spawn` succeeds without spawning a real process; the returned spec
    carries a synthetic `pid` of 0 and a caller-controllable
    `startedAtMs` (via factory option, default `Date.now()`).
  - `exec` evaluates a tiny safe-subset (`1+1`, variable-assignment +
    bareword reference, `throw new Error(...)`, syntax errors) so the
    hellgate's persistence + error-classification branches can run
    without node on PATH. The subset is documented in the file header
    and rejects everything else with a marker (`<<unsupported in stub>>`).
  - `kill` flips the state to `dead` and removes the state-store entry.
- Default-OFF byte-identical: nothing in `src/` constructs this in
  production paths; only tests reach for it.

### Barrel (`index.ts`)

Re-exports the closed port, the production factory, the headless-stub
factory, and the public types. State-store helpers (`stateDir`,
`writeKernel`, `removeKernel`, `listKernels`) are also exported so the
caller can do orphan reaping at composition root without re-implementing
the path discipline.

## Consequences

**Positive**

- The slice primitive lands as a closed port with one production and one
  deterministic adapter — same shape as `src/runtime/shell-snapshot/`,
  which keeps the audit reflex transferable.
- The on-disk state-store is **handle-only**; the persistence unit is
  the live node process. A crashed CLI can list orphans on next launch
  and clean them up without ever needing to re-execute user code from a
  log.
- 0600/0700 file/dir permissions block other unix users on multi-tenant
  hosts from reading the `sessionId` linkage between agent threads and
  spawned interpreters — defense-in-depth on top of `os` jail.

**Negative / accepted trade-offs**

- The line-protocol uses a per-exec sentinel string. A pathological
  user program that *prints the exact sentinel* would mis-frame.
  Mitigation: sentinel includes `execId` (random nonce) — collision
  probability is `2^-64`. Documented in the adapter header.
- The default adapter needs a `node` whose REPL `eval` calls back with `e === null` on
  success (measured on Node 22.22 and 25.9; on 22 an awaited `Promise.reject(null)` is
  indistinguishable from a value of `undefined`, a stated limit). A
  stripped CI image without `node` resolves at `spawn` time as
  `node-missing`; the caller's gate decides whether to degrade or
  surface to the user.
- The slice is shipped **default-OFF**. No tool consumes it yet — the
  catalog entry records the deliberate hold (full Jupyter protocol
  with `msg_id`/`parent_header` + multi-output frames + restart policy
  are all follow-ups; this round delivers the kernel primitive only).
  This is intentional per RFC §1.2 — byte-identical landing first,
  feature wiring later.

## Rejected alternatives

- **Use a worker_thread instead of a child node process.** Faster startup
  but worker threads do not give the same isolation guarantees (shared
  ArrayBuffer, parent crash propagation), and the Codex pattern we're
  absorbing explicitly uses a real subprocess — deviating without an ROI
  story breaks the absorption discipline.
- **Persist the variable state to disk between turns.** This is the
  Jupyter Lab "checkpoint kernel" feature and is real value, but it
  requires either a structured-clone serializer or an out-of-band
  `v8.serialize()` snapshot — both of which fail on closures, sockets,
  native modules, etc. Codex doesn't do it; we don't either.
- **Default-ON.** Violates RFC §1.2 byte-identical landing. A user who
  never runs node code would pay a per-session kernel-spawn cost.
  Opt-in is the safer landing; the wiring round will add the env knob.
