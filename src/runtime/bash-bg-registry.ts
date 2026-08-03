/**
 * ADR-0296 — Background-shell registry for `timeout_behavior: "background"`.
 *
 * Cursor's `TimeoutBehavior.BACKGROUND` absorption. When a bash command exceeds
 * its `timeout_ms` deadline, instead of being SIGTERM'd (the legacy "kill"
 * mode, still the default), the process is DETACHED — it continues to run, its
 * stdout/stderr buffer is owned by this registry, and the bash tool returns a
 * `{ shellId }` placeholder. The LLM later calls `bash_await` (block until a
 * pattern matches / process exits) or `bash_kill` (terminate + collect).
 *
 * Design notes (no-heuristics-only-validated):
 *  - Cap-and-evict LRU (default {@link DEFAULT_MAX_BG_SHELLS}=16). On overflow
 *    the OLDEST entry is killed + dropped (`evicted=true` is set on the
 *    survivor). Cap is closed-port — the test harness installs its own.
 *  - {@link BashProcessHandlePort} is the DI seam — production wires
 *    {@link defaultBashProcessHandlePort} (real `Bun.spawn`), tests pass a
 *    fake that returns a deterministic handle.
 *  - `crypto.randomUUID()` for shell-ids (no nanoid dep, byte-identical to the
 *    other registry IDs across the codebase — see `runtime/node-repl/state-store`,
 *    `runtime/shell-snapshot/file-store`).
 *  - Session cleanup is via {@link killAll}; the assembly seam can call it on
 *    session shutdown / SIGINT. Without it the registry is module-scoped (lives
 *    for the process lifetime) — which is the same lifetime as the legacy
 *    `getShellSandbox()` holder pattern.
 *  - Slice fence: this module lives in `@/runtime` so `@/tool/bash` (which can
 *    reach `@/runtime`) consumes it through the slice-isolated path. The
 *    registry is NOT re-exported through `@/runtime/index.ts` to keep the
 *    runtime barrel surface tight — consumers import from
 *    `@/runtime/bash-bg-registry` directly.
 *  - The registry NEVER throws into the bash tool's terminal `result` event.
 *    Lookup misses return `null`; the tool maps that to a typed `ToolFailure`.
 */

import { type BoundedBuffer, createBoundedBuffer } from "./bounded-buffer"
import { escalatingKill, type KillableChild } from "./guarded-spawn"
import { defaultPpidWalkKiller, type ProcessTreeKiller } from "./process-tree"
import { scrubEnv } from "./sandbox"
import { asScrubbedEnv, bunScrubbedSpawner } from "./scrubbed-spawn"
import { getShellSandbox } from "./shell-sandbox-holder"

/** Default registry cap. Overflow evicts the OLDEST (insertion-ordered Map
 *  iteration) entry — its process is SIGTERM'd before the entry drops. */
export const DEFAULT_MAX_BG_SHELLS = 16

/** D1 — whole-tree killer for background shells. Module-level singleton (the
 *  adapter is pure per `signalTree`). A long-running `bash -lc "npm run dev"`
 *  forks node→workers; on `bash_kill` / cap-eviction / abort this reaps the
 *  whole tree instead of leaking the workers (legacy single-PID). When a fake
 *  handle without a numeric `pid` is registered (tests), `escalatingKill`
 *  auto-falls back to the single-PID `proc.kill()` — byte-identical. */
const BG_TREE_KILLER: ProcessTreeKiller = defaultPpidWalkKiller()

/** D2 — per-handle VERBATIM output budget. Output AT OR UNDER this is preserved
 *  in full (the ADR-0411 contract: a background COMPLETED result is not
 *  head-sliced); only ONCE it exceeds this does the buffer elide the middle,
 *  keeping an 8k head + 4k tail (see `bounded-buffer.ts`). This is the OOM fix:
 *  a `tail -f`/`yes` can no longer grow the accumulator without bound — the
 *  retained buffer is O(this), not O(total streamed).
 *
 *  Value = 200_000, the SAME budget as the foreground `capToolOutput`
 *  (`DEFAULT_TOOL_OUTPUT_MAX` in `src/tool/output-spill.ts` — POLICY SOURCE).
 *  Re-declared locally (named const) rather than imported, to avoid crossing
 *  the `@/runtime` ↔ `@/tool` slice fence. */
export const MAX_BG_BUFFER_BYTES = 200_000

/** Polling interval for `awaitHandle` regex match. A tight loop would burn CPU;
 *  too coarse a window would make the await feel sluggish. 50ms is the same
 *  cadence node-repl uses for its execute-poll, no heuristic — proven cadence. */
const AWAIT_POLL_INTERVAL_MS = 50

/** Status of a registered background shell. `running` = still alive,
 *  `completed` = exited (zero or non-zero exit code), `killed` = SIGTERM'd
 *  through `bash_kill` or registry cap eviction, `aborted` = the host's
 *  AbortSignal fired (rare — typically session shutdown). */
export type BgShellStatus = "running" | "completed" | "killed" | "aborted"

/** A live handle pointing into the registry. Returned by `register`, looked up
 *  by `get` / `await` / `kill`. Mutable internally; the registry exposes only
 *  the by-value snapshot shape ({@link BgShellSnapshot}) to consumers. */
export interface BgShellHandle {
  readonly id: string
  /** RFC02-0 — the caller-provided STABLE owner identity (session/thread) that
   *  gates cross-session kill. Provided at `register`/`adopt` time by the
   *  composition; NEVER derived from the id/PID/cwd. Absent = a legacy/unowned
   *  entry: visible to an operator list but not killable through `killOwned`. */
  readonly ownerId?: string
  readonly command: string
  readonly cwd: string
  readonly startedAt: number
  status: BgShellStatus
  /** Output accumulators — bytes-as-decoded-utf8 since the bash tool only ever
   *  surfaces text to the model. D2: BOUNDED head+tail buffers (cap
   *  {@link MAX_BG_BUFFER_BYTES}) so a `tail -f`/`yes` cannot OOM the agent.
   *  `snapshot()` reads `.value()`; the external `BgShellSnapshot.stdout: string`
   *  shape is unchanged. */
  readonly stdout: BoundedBuffer
  readonly stderr: BoundedBuffer
  exitCode: number | null
  /** Resolves the moment the OS reaps the child (regardless of WHY — exit,
   *  kill, abort). The registry await loop races this against the regex/poll. */
  readonly exited: Promise<void>
  /** Terminate the child + (after the escalating-kill grace window) SIGKILL.
   *  Idempotent — safe to call after the child already exited. */
  readonly kill: () => void
}

/** By-value snapshot of a {@link BgShellHandle}. Returned by `get` so consumers
 *  cannot mutate registry-owned buffers. */
export interface BgShellSnapshot {
  readonly id: string
  /** RFC02-0 — mirror of {@link BgShellHandle.ownerId}. Absent for
   *  legacy/unowned entries (an operator list renders these as `owner:unknown`;
   *  the owner-scoped kill path refuses them). */
  readonly ownerId?: string
  readonly command: string
  readonly cwd: string
  readonly startedAt: number
  readonly status: BgShellStatus
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
}

/** RFC02-0 — typed outcome of {@link BashBgRegistry.killOwned}. On success the
 *  reaped snapshot; on refusal a CLOSED reason union (never a boolean) so every
 *  surface renders a specific message and a new arm is a compile error. */
export type OwnedKillResult =
  | { readonly ok: true; readonly snapshot: BgShellSnapshot }
  | {
      readonly ok: false
      readonly reason: "not_found" | "ambiguous" | "not_owned"
    }

/** The minimal `Bun.Subprocess`-like slice the registry needs. Kept structural
 *  so the spawner adapter can be a test fake without dragging the full Bun
 *  type into the suite. */
export interface BashSubprocess extends KillableChild {
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
}

/** Closed-port DI seam. The default port (below) wraps `Bun.spawn`; tests pass
 *  a fake that yields deterministic chunks/exit codes. */
export interface BashProcessHandlePort {
  /** Spawn a `bash -lc <command>` subprocess with the SAME env-scrubbing +
   *  sandbox-argv-wrap as `runShell`. The result is a structural handle the
   *  registry drains. */
  spawn(args: { command: string; cwd: string }): Promise<BashSubprocess>
}

/** Production adapter — uses `Bun.spawn` with the shared `scrubEnv` allowlist
 *  and (when installed) the OS-sandbox argv wrapper. Mirrors the spawn surface
 *  of `runShell` so a background shell runs under the same sandbox/env contract
 *  as a foreground shell — there is NO posture downgrade when going async. */
export const defaultBashProcessHandlePort: BashProcessHandlePort = {
  async spawn({ command, cwd }) {
    // S1 — the env is BRANDED at the scrubber chokepoint, then handed to the
    // typed `spawnScrubbed` boundary: an inherit-by-omission / raw-spread leak
    // here is a tsc error, not just an R-D3 scan hit.
    const env = asScrubbedEnv(scrubEnv())
    const baseArgv: ReadonlyArray<string> = ["bash", "-lc", command]
    const slot = getShellSandbox()
    const argv = slot !== undefined ? (await slot.wrap(baseArgv, cwd)).argv : [...baseArgv]
    const proc = bunScrubbedSpawner(argv, { cwd, env, stdout: "pipe", stderr: "pipe" })
    return proc as BashSubprocess
  },
}

/** Registry surface. The bash tool and the await/kill tools talk to this
 *  through {@link getBashBgRegistry}; tests build a fresh instance via
 *  {@link createBashBgRegistry} (no module slot pollution between tests). */
export interface BashBgRegistry {
  /** Spawn + register a background shell. Returns the handle; the caller is
   *  expected to start draining (drain is owned by THIS module — the caller
   *  only spawns). `signal`, when aborted, marks the handle `"aborted"` and
   *  kills the child. */
  register(args: {
    command: string
    cwd: string
    signal?: AbortSignal
    /** RFC02-0 — optional STABLE owner identity from the composition. */
    ownerId?: string
  }): Promise<BgShellHandle>
  /** ADR-0296 auto-background — ADOPT a child already spawned + drained by
   *  `runShell` (foreground path that hit its deadline). Unlike {@link register}
   *  (which spawns afresh, bypassing the foreground sandbox/env/wrap pipeline),
   *  `adopt` takes ownership of an EXISTING live process: its `kill`/`disarm`
   *  closures, the `stdout`/`stderr` BoundedBuffers that `runShell` is STILL
   *  appending to, the child's `exited` code promise, and the `drainsDone`
   *  promise that resolves when both pipes finish. The registry wires only the
   *  terminal lifecycle (status `running`→`completed`/exit-code latch + disarm)
   *  — it does NOT start a new drain (the caller's drain keeps feeding the same
   *  buffers). Cap-and-evict applies identically to `register`. Returns the new
   *  id + an initial snapshot. */
  adopt(args: {
    readonly command: string
    readonly cwd: string
    readonly kill: () => void
    readonly disarm: () => void
    readonly stdout: BoundedBuffer
    readonly stderr: BoundedBuffer
    readonly exited: Promise<number>
    readonly drainsDone: Promise<void>
    /** RFC02-0 — optional STABLE owner identity from the composition. */
    readonly ownerId?: string
    /** RFC02-0 (test seam) — supply a deterministic id instead of a random
     *  UUID. Production callers omit this; only tests that need to assert
     *  prefix resolution pass an explicit id. */
    readonly id?: string
  }): Promise<{ id: string; snapshot: BgShellSnapshot }>
  /** Lookup a snapshot by id. Returns `null` when the id is unknown / evicted. */
  get(id: string): BgShellSnapshot | null
  /** Block until the shell exits OR the optional `regex` matches the combined
   *  stdout+stderr OR `timeoutMs` elapses. Returns the FINAL snapshot. A
   *  `timeoutMs=0` polls once and returns; `regex` undefined ⇒ wait until exit
   *  (or `timeoutMs`). Returns `null` if the id is unknown. */
  awaitHandle(
    id: string,
    opts?: { regex?: RegExp; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ snapshot: BgShellSnapshot; matched: boolean; timedOut: boolean } | null>
  /** SIGTERM the shell (escalating to SIGKILL after the grace window). Returns
   *  the final snapshot once the child has been reaped. `null` for unknown id.
   *
   *  UNSCOPED — this is HOST-SHUTDOWN / operator-tree machinery and MUST NOT be
   *  reached from a model-facing or cross-session surface. Owner-scoped surfaces
   *  use {@link killOwned}. */
  kill(id: string): Promise<BgShellSnapshot | null>
  /** RFC02-0 — bounded, owner-scoped snapshot list. Returns ONLY the shells
   *  whose `ownerId` deep-equals `ownerId`, in insertion order. Never leaks
   *  another owner's shells and never legacy/unowned entries (those have no
   *  owner to match). Pure read; no side effects. */
  listOwned(ownerId: string): readonly BgShellSnapshot[]
  /** RFC02-0 — the ONLY kill path a model tool / cross-session surface may use.
   *  Resolves `idOrPrefix` to EXACTLY one shell that (a) is owned by `ownerId`
   *  and (b) matches by exact id OR unique prefix. Refuses (typed reason, no
   *  kill) on: unknown id, an ambiguous prefix, or a shell owned by someone else
   *  / unowned. On success SIGTERMs (escalating) and returns the reaped
   *  snapshot. */
  killOwned(idOrPrefix: string, ownerId: string): Promise<OwnedKillResult>
  /** Evict + kill every registered shell. Called on session shutdown to avoid
   *  orphan processes outliving the agent. Idempotent. */
  killAll(): Promise<void>
  /** Read-only count for tests / introspection. */
  size(): number
  /** Returns the id of the OLDEST entry, or `null` if empty. Test-only seam. */
  oldestId(): string | null
}

/** Configuration for {@link createBashBgRegistry}. Both fields default; the
 *  module-level singleton uses the defaults. */
export interface BashBgRegistryConfig {
  port?: BashProcessHandlePort
  maxEntries?: number
}

/** Composite deadline signal: aborts on `timeoutMs` elapse OR `external` abort.
 *  Extracted from `awaitHandle` to keep the polling loop within biome's
 *  cognitive-complexity cap. */
interface DeadlineSignal {
  readonly ctrl: AbortController
  readonly timedOut: () => boolean
  readonly externalAborted: () => boolean
  readonly dispose: () => void
}

const makeDeadlineSignal = (
  timeoutMs: number | undefined,
  external: AbortSignal | undefined,
): DeadlineSignal => {
  const ctrl = new AbortController()
  const cleanup: Array<() => void> = []
  let timedOut = false
  let externalAborted = false
  if (timeoutMs === 0) {
    timedOut = true
    ctrl.abort()
  } else if (timeoutMs !== undefined && timeoutMs > 0) {
    const t = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, timeoutMs)
    cleanup.push(() => clearTimeout(t))
  }
  if (external !== undefined) {
    if (external.aborted) {
      externalAborted = true
      ctrl.abort()
    } else {
      const onSig = (): void => {
        externalAborted = true
        ctrl.abort()
      }
      external.addEventListener("abort", onSig, { once: true })
      cleanup.push(() => external.removeEventListener("abort", onSig))
    }
  }
  return {
    ctrl,
    timedOut: () => timedOut,
    externalAborted: () => externalAborted,
    dispose: () => {
      for (const fn of cleanup) fn()
    },
  }
}

/** Sleep at most `ms` ms or until `abort` fires. Extracted so the await loop
 *  body remains within the cognitive-complexity cap. */
const sleepUntilDeadline = (ms: number, abort: AbortSignal): Promise<void> =>
  new Promise<void>((res) => {
    if (abort.aborted) {
      res()
      return
    }
    const t = setTimeout(res, ms)
    abort.addEventListener(
      "abort",
      () => {
        clearTimeout(t)
        res()
      },
      { once: true },
    )
  })

/** Drain a `ReadableStream<Uint8Array>` to a UTF-8 chunk callback. Module-scope
 *  helper (vs an inner IIFE) so each function stays within the biome
 *  cognitive-complexity cap. */
const drainReadableStream = async (
  stream: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
): Promise<void> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder("utf-8")
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (value && value.byteLength > 0) {
        onChunk(decoder.decode(value, { stream: true }))
      }
    }
  } finally {
    // Final flush from the streaming decoder so any trailing partial UTF-8
    // sequence is surfaced before lock-release.
    const tailFlush = decoder.decode()
    if (tailFlush.length > 0) onChunk(tailFlush)
    reader.releaseLock()
  }
}

/** Wire the optional host abort signal to a handle: pre-aborted ⇒ mark
 *  aborted + kill immediately; otherwise register the listener and return
 *  the unsubscribe-handle so the post-exit cleanup can remove it. Extracted
 *  from `register` to keep its cognitive complexity within the biome cap. */
const wireAbortSignal = (
  handle: BgShellHandle,
  signal: AbortSignal | undefined,
): { onAbort: (() => void) | undefined } => {
  if (signal === undefined) return { onAbort: undefined }
  const onAbort = (): void => {
    if (handle.status === "running") {
      handle.status = "aborted"
      handle.kill()
    }
  }
  if (signal.aborted) {
    onAbort()
  } else {
    signal.addEventListener("abort", onAbort, { once: true })
  }
  return { onAbort }
}

/** RFC02-0 — resolve `idOrPrefix` against the OWNER-FILTERED candidate ids to
 *  EXACTLY one id, or a typed refusal. Pure (no registry access) so the
 *  exact-vs-unique-prefix policy is one testable seam:
 *   - an EXACT id match wins outright (even if it is also a prefix of another);
 *   - otherwise a prefix that matches EXACTLY ONE candidate resolves;
 *   - zero matches ⇒ `not_found`; two-or-more prefix matches ⇒ `ambiguous`.
 *  The candidate set is already owner-scoped, so `not_found` also covers a
 *  known-but-foreign/unowned id (the caller maps that to `not_owned`). */
export const resolveOwnedShellId = (
  idOrPrefix: string,
  ownedIds: readonly string[],
):
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: "not_found" | "ambiguous" } => {
  if (ownedIds.includes(idOrPrefix)) return { ok: true, id: idOrPrefix }
  const matches = ownedIds.filter((id) => id.startsWith(idOrPrefix))
  if (matches.length === 0) return { ok: false, reason: "not_found" }
  if (matches.length > 1) return { ok: false, reason: "ambiguous" }
  // length === 1 — `matches[0]` is defined; the non-null assertion is safe.
  const only = matches[0]
  if (only === undefined) return { ok: false, reason: "not_found" }
  return { ok: true, id: only }
}

/** Build a fresh registry. The module-level singleton calls this with defaults;
 *  tests call it directly to get an isolated instance. */
export const createBashBgRegistry = (config: BashBgRegistryConfig = {}): BashBgRegistry => {
  const port = config.port ?? defaultBashProcessHandlePort
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_BG_SHELLS
  // Map iteration order = insertion order — gives us LRU-by-insertion for free.
  const entries = new Map<string, BgShellHandle>()

  const evictOldest = async (): Promise<void> => {
    const first = entries.keys().next()
    if (first.done === true) return
    const oldestId = first.value
    const handle = entries.get(oldestId)
    if (handle === undefined) return
    entries.delete(oldestId)
    // Only kill a STILL-RUNNING shell — matching the other kill sites (`onAbort`,
    // `kill`, `killAll`). A `completed` shell is already reaped; calling kill on
    // it used to re-arm a leaked SIGKILL grace timer (now also latched in
    // `escalatingKill`, but the guard keeps this site consistent + cheaper).
    if (handle.status === "running") handle.kill()
    await handle.exited.catch(() => {
      /* already terminal */
    })
  }

  const drainStream = (
    stream: ReadableStream<Uint8Array>,
    onChunk: (text: string) => void,
  ): Promise<void> => drainReadableStream(stream, onChunk)

  const register: BashBgRegistry["register"] = async ({ command, cwd, signal, ownerId }) => {
    if (entries.size >= maxEntries) {
      await evictOldest()
    }
    const proc = await port.spawn({ command, cwd })
    const id = crypto.randomUUID()
    const { kill, disarm } = escalatingKill(proc, BG_TREE_KILLER)
    let exitedResolve!: () => void
    const exited = new Promise<void>((res) => {
      exitedResolve = res
    })
    const handle: BgShellHandle = {
      id,
      ...(ownerId !== undefined ? { ownerId } : {}),
      command,
      cwd,
      startedAt: Date.now(),
      status: "running",
      stdout: createBoundedBuffer(MAX_BG_BUFFER_BYTES),
      stderr: createBoundedBuffer(MAX_BG_BUFFER_BYTES),
      exitCode: null,
      exited,
      kill,
    }
    entries.set(id, handle)

    // Optional host abort — caller (e.g. session shutdown) can pre-abort.
    const { onAbort } = wireAbortSignal(handle, signal)

    // Start draining IMMEDIATELY — the bash tool may yield its placeholder
    // result before the first await/poll, so we cannot wait for the consumer
    // to start the drain. The two drainers + the exit-resolver compose into a
    // single background "lifecycle" promise; we attach a `.then`/`.catch` for
    // bookkeeping but never await it inline.
    const stdoutDone = drainStream(proc.stdout, (chunk) => {
      handle.stdout.append(chunk)
    })
    const stderrDone = drainStream(proc.stderr, (chunk) => {
      handle.stderr.append(chunk)
    })
    void (async () => {
      try {
        await Promise.all([stdoutDone, stderrDone])
      } catch {
        /* reader error already surfaced in stderr/stdout */
      }
      const code = await proc.exited.catch(() => -1)
      handle.exitCode = code
      if (handle.status === "running") {
        handle.status = "completed"
      }
      disarm()
      if (signal !== undefined && onAbort !== undefined) {
        signal.removeEventListener("abort", onAbort)
      }
      exitedResolve()
    })()

    return handle
  }

  const snapshot = (h: BgShellHandle): BgShellSnapshot => ({
    id: h.id,
    ...(h.ownerId !== undefined ? { ownerId: h.ownerId } : {}),
    command: h.command,
    cwd: h.cwd,
    startedAt: h.startedAt,
    status: h.status,
    stdout: h.stdout.value(),
    stderr: h.stderr.value(),
    exitCode: h.exitCode,
  })

  const adopt: BashBgRegistry["adopt"] = async (args) => {
    // Cap-and-evict BEFORE inserting — identical posture to `register`. The
    // oldest still-running shell is killed + dropped so the adopted handle has
    // a slot. (An adopted handle that overflows the cap is itself subject to
    // eviction on the NEXT register/adopt — same LRU contract.)
    if (entries.size >= maxEntries) {
      await evictOldest()
    }
    // RFC02-0 — production callers omit `id` (random UUID); a test seam may
    // supply a deterministic id to exercise prefix resolution. Never derive an
    // owner from it.
    const id = args.id ?? crypto.randomUUID()
    let exitedResolve!: () => void
    const exited = new Promise<void>((res) => {
      exitedResolve = res
    })
    // The buffers are the SAME instances `runShell` is appending to via its
    // ongoing drain — the registry reads them through `snapshot()`/`get()`,
    // never writes. The child is already spawned + draining; we only own the
    // terminal lifecycle from here.
    const handle: BgShellHandle = {
      id,
      ...(args.ownerId !== undefined ? { ownerId: args.ownerId } : {}),
      command: args.command,
      cwd: args.cwd,
      startedAt: Date.now(),
      status: "running",
      stdout: args.stdout,
      stderr: args.stderr,
      exitCode: null,
      exited,
      kill: args.kill,
    }
    entries.set(id, handle)

    // Mirror `register`'s lifecycle tail, minus the spawn + drain start (the
    // caller owns those). When the caller's drain finishes AND the child is
    // reaped, latch the exit code, flip running→completed (a `kill()` from
    // eviction/`bash_kill`/`killAll` will have already set `killed`), and
    // disarm the escalating-kill grace timer the caller handed us.
    void (async () => {
      try {
        await args.drainsDone
      } catch {
        /* reader error already surfaced into the shared stdout/stderr buffer */
      }
      const code = await args.exited.catch(() => -1)
      handle.exitCode = code
      if (handle.status === "running") {
        handle.status = "completed"
      }
      args.disarm()
      exitedResolve()
    })()

    return { id, snapshot: snapshot(handle) }
  }

  const get: BashBgRegistry["get"] = (id) => {
    const h = entries.get(id)
    if (h === undefined) return null
    return snapshot(h)
  }

  /** Polling body of `awaitHandle`. Returns a "found" outcome (matched OR
   *  exited) by snapshotting the live handle. Extracted so `awaitHandle` stays
   *  inside the biome cognitive-complexity cap. */
  const pollUntilTerminal = async (
    h: BgShellHandle,
    matchesNow: () => boolean,
    deadline: DeadlineSignal,
  ): Promise<{ snapshot: BgShellSnapshot; matched: boolean; timedOut: boolean }> => {
    while (h.status === "running" && !deadline.ctrl.signal.aborted) {
      if (matchesNow()) {
        return { snapshot: snapshot(h), matched: true, timedOut: false }
      }
      await sleepUntilDeadline(AWAIT_POLL_INTERVAL_MS, deadline.ctrl.signal)
    }
    if (matchesNow()) {
      return { snapshot: snapshot(h), matched: true, timedOut: false }
    }
    return {
      snapshot: snapshot(h),
      matched: false,
      timedOut: deadline.timedOut() || deadline.externalAborted(),
    }
  }

  const awaitHandle: BashBgRegistry["awaitHandle"] = async (id, opts = {}) => {
    const h = entries.get(id)
    if (h === undefined) return null
    const { regex, timeoutMs, signal } = opts
    // D2 — match against the BOUNDED `.value()` (head+tail) rather than an
    // unbounded accumulator: a never-matching regex over an unbounded `tail -f`
    // stream can no longer grow without limit (also shrinks the ReDoS surface).
    const matchesNow = (): boolean =>
      regex?.test(`${h.stdout.value()}\n${h.stderr.value()}`) ?? false
    // Fast-paths (already terminal OR regex matches now) ⇒ no polling.
    if (h.status !== "running") {
      return { snapshot: snapshot(h), matched: matchesNow(), timedOut: false }
    }
    if (matchesNow()) {
      return { snapshot: snapshot(h), matched: true, timedOut: false }
    }
    const deadline = makeDeadlineSignal(timeoutMs, signal)
    try {
      return await pollUntilTerminal(h, matchesNow, deadline)
    } finally {
      deadline.dispose()
    }
  }

  const kill: BashBgRegistry["kill"] = async (id) => {
    const h = entries.get(id)
    if (h === undefined) return null
    if (h.status === "running") {
      h.status = "killed"
      h.kill()
    }
    await h.exited.catch(() => {
      /* already terminal */
    })
    return snapshot(h)
  }

  const listOwned: BashBgRegistry["listOwned"] = (ownerId) => {
    const out: BgShellSnapshot[] = []
    // Map iteration = insertion order ⇒ stable, deterministic list.
    for (const h of entries.values()) {
      if (h.ownerId === ownerId) out.push(snapshot(h))
    }
    return out
  }

  const killOwned: BashBgRegistry["killOwned"] = async (idOrPrefix, ownerId) => {
    // Candidate universe is OWNER-FILTERED first — a foreign or unowned id is
    // simply not a candidate, so it can never be resolved (and never killed).
    const ownedIds: string[] = []
    for (const h of entries.values()) {
      if (h.ownerId === ownerId) ownedIds.push(h.id)
    }
    const resolved = resolveOwnedShellId(idOrPrefix, ownedIds)
    if (!resolved.ok) {
      // `not_found` here means: not among THIS owner's shells. If the id exists
      // but belongs to another owner (or is unowned), report `not_owned` so the
      // refusal is precise (and does not confirm/deny a foreign id's content).
      if (resolved.reason === "not_found" && entries.has(idOrPrefix)) {
        return { ok: false, reason: "not_owned" }
      }
      return { ok: false, reason: resolved.reason }
    }
    const h = entries.get(resolved.id)
    if (h === undefined) return { ok: false, reason: "not_found" }
    if (h.status === "running") {
      h.status = "killed"
      h.kill()
    }
    await h.exited.catch(() => {
      /* already terminal */
    })
    return { ok: true, snapshot: snapshot(h) }
  }

  const killAll: BashBgRegistry["killAll"] = async () => {
    const ids = [...entries.keys()]
    for (const id of ids) {
      const h = entries.get(id)
      if (h === undefined) continue
      if (h.status === "running") {
        h.status = "killed"
        h.kill()
      }
    }
    await Promise.all(
      ids.map((id) =>
        entries.get(id)?.exited.catch(() => {
          /* already terminal */
        }),
      ),
    )
    entries.clear()
  }

  return {
    register,
    adopt,
    get,
    awaitHandle,
    kill,
    listOwned,
    killOwned,
    killAll,
    size: () => entries.size,
    oldestId: () => {
      const first = entries.keys().next()
      return first.done === true ? null : first.value
    },
  }
}

// ── Module-level singleton (the bash tool reads through this) ────────────

let singleton: BashBgRegistry | undefined

/** Read (or lazily create) the process-wide registry. The bash tool and the
 *  `bash_await`/`bash_kill` tools share one registry for the lifetime of the
 *  process; tests that need an isolated registry call {@link createBashBgRegistry}
 *  directly. */
export const getBashBgRegistry = (): BashBgRegistry => {
  if (singleton === undefined) singleton = createBashBgRegistry()
  return singleton
}

/** Install a specific registry (test seam, also lets a host pre-configure a
 *  capped registry at boot). Pass `undefined` to clear; the next
 *  {@link getBashBgRegistry} will lazy-init the default. */
export const installBashBgRegistry = (registry: BashBgRegistry | undefined): void => {
  singleton = registry
}

/** Test-only reset. Production code MUST NOT call this. */
export const __resetBashBgRegistry = (): void => {
  singleton = undefined
}
