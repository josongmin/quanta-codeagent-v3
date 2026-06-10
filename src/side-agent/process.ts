/**
 * §4.3 — side-agent OS-PROCESS daemon V1 (RFC §4.3, jun-4 Phase-1 non-goal).
 *
 * The in-process {@link createSideAgentDaemonRegistry} runs every side-agent on
 * the MAIN thread (an injected `runner` pass per wake). The audit (§4.3) and the
 * Codex side-agent fleet want a daemon SPAWNED AS A SEPARATE OS PROCESS — a
 * forked child with socket/pipe IPC + supervised crash-respawn (exponential
 * backoff). That is a HIGH OS-integration item; this is the DEFAULT-OFF V1
 * CORE:
 *
 *   - {@link ProcessForkPort} — the OS layer abstraction (`fork(spec) → handle`).
 *     The real adapter (`node:child_process.fork`) lives at the composition
 *     root; this slice depends only on the PORT so the supervisor is fully
 *     testable over a fake fork.
 *   - {@link ChildProcessHandle} — IPC + lifecycle on one forked child
 *     (`send` / `onMessage` / `onExit` / `kill`).
 *   - {@link createSupervisedProcessDaemon} — the supervisor: fork → run →
 *     on UNEXPECTED exit, respawn with EXPONENTIAL BACKOFF (injected clock +
 *     scheduler — no `Date.now`/`setTimeout` of its own), bounded by a max
 *     restart count + a backoff ceiling. A clean `stop()` is NOT a crash.
 *
 * EXPLICITLY DEFERRED (V1 ⇒ depth follow-up): launchctl/systemd unit
 * generation + an OS daemon MANAGER (multi-daemon registry over processes) +
 * real socket transport selection. V1 ships the fork/supervise/respawn CORE,
 * mockable end-to-end, behind `QUANTA_SIDE_AGENT_PROCESS`.
 *
 * PURE LEAF: no concrete imports, no IO/clock/timer of its own — every effect
 * is an injected port (slice isolation: `@/side-agent` reaches nothing).
 */

/** A message crossing the IPC boundary, in EITHER direction. The parent sends a
 *  control message (`start`/`stop`/`charter`); the child posts findings + a
 *  ready beacon. A closed union keeps the wire format auditable. */
export type SideAgentIpcMessage =
  /** Parent → child: the charter the child should run on each wake. */
  | { readonly kind: "charter"; readonly task: string; readonly maxTurnsPerWake: number }
  /** Parent → child: request a graceful drain + exit. */
  | { readonly kind: "shutdown" }
  /** Child → parent: the child booted and is ready to receive a charter. */
  | { readonly kind: "ready" }
  /** Child → parent: a finding from a wake (mirrors the in-process finding). */
  | { readonly kind: "finding"; readonly summary: string; readonly detail?: string }

/** Spec handed to {@link ProcessForkPort.fork}. */
export interface ProcessForkSpec {
  /** Absolute path to the worker module the child runs (the entrypoint that
   *  boots a child agent loop + an IPC message handler). */
  readonly modulePath: string
  /** Argv passed to the child (after the module). */
  readonly args?: readonly string[]
  /** Extra env merged onto the child's environment. */
  readonly env?: Readonly<Record<string, string>>
  /** Working directory for the child. */
  readonly cwd?: string
}

/** Lifecycle + IPC on ONE forked child. The real adapter wraps a
 *  `node:child_process.ChildProcess`; the fake (tests) drives the callbacks
 *  directly. NO-THROW — `send`/`kill` on a dead child are no-ops. */
export interface ChildProcessHandle {
  /** OS pid (or a synthetic id from the fake). */
  readonly pid: number
  /** Post a message to the child. No-op once the child has exited. */
  send(msg: SideAgentIpcMessage): void
  /** Subscribe to child → parent messages. Returns an unsubscribe fn. */
  onMessage(handler: (msg: SideAgentIpcMessage) => void): () => void
  /** Subscribe to the child's exit (code, signal). Fires AT MOST once. Returns
   *  an unsubscribe fn. */
  onExit(
    handler: (info: { readonly code: number | null; readonly signal: string | null }) => void,
  ): () => void
  /** Terminate the child (SIGTERM). Idempotent / NO-THROW. */
  kill(): void
}

/** The OS layer — the single seam the supervisor depends on. The real impl
 *  (`node:child_process.fork`) lives at the composition root. */
export interface ProcessForkPort {
  fork(spec: ProcessForkSpec): ChildProcessHandle
}

/** Injected scheduler — a one-shot delayed callback (the respawn backoff timer).
 *  Returns a cancel handle so a `stop()` mid-backoff cancels the pending
 *  respawn. The host passes `setTimeout`/`clearTimeout`; tests pass a manual
 *  scheduler. NO `setTimeout` of the slice's own. */
export interface DelayScheduler {
  schedule(fn: () => void, ms: number): unknown
  cancel(handle: unknown): void
}

/** Supervisor lifecycle state (observability). */
export type SupervisedDaemonStatus =
  | "starting"
  | "running"
  | "backing-off"
  | "stopped"
  | "crashed-permanently"

export interface SupervisedProcessDaemonOpts {
  /** Charter the child runs. */
  readonly task: string
  readonly maxTurnsPerWake: number
  /** The worker module the child boots. */
  readonly fork: ProcessForkPort
  readonly forkSpec: ProcessForkSpec
  /** Injected clock + scheduler (no `Date.now`/`setTimeout` here). */
  readonly now: () => number
  readonly scheduler: DelayScheduler
  /** Finding sink — a child `finding` message is forwarded here. */
  readonly onFinding: (finding: { readonly summary: string; readonly detail?: string }) => void
  /** Max UNEXPECTED restarts before giving up (`crashed-permanently`). A clean
   *  `stop()` is NOT counted. Default 5. */
  readonly maxRestarts?: number
  /** Base backoff (ms) — restart N waits `baseBackoffMs * 2^(N-1)`, capped at
   *  {@link backoffCapMs}. Default 200. */
  readonly baseBackoffMs?: number
  /** Backoff ceiling (ms). Default 30_000. */
  readonly backoffCapMs?: number
  /** Optional status change observer (telemetry). */
  readonly onStatus?: (status: SupervisedDaemonStatus) => void
}

export interface SupervisedProcessDaemon {
  /** Fork the child + wire IPC. Idempotent (a second `start` is a no-op while
   *  already live). */
  start(): void
  /** Graceful stop — sends `shutdown`, kills the child, cancels any pending
   *  respawn. A subsequent child exit is treated as EXPECTED (no respawn).
   *  Idempotent / NO-THROW. */
  stop(): void
  /** Current lifecycle status. */
  status(): SupervisedDaemonStatus
  /** Count of UNEXPECTED restarts so far. */
  restarts(): number
  /** The current child's pid, or undefined when not running. */
  pid(): number | undefined
}

const DEFAULT_MAX_RESTARTS = 5
const DEFAULT_BASE_BACKOFF_MS = 200
const DEFAULT_BACKOFF_CAP_MS = 30_000

/**
 * Compute the backoff (ms) before restart attempt `n` (1-based): an exponential
 * `base * 2^(n-1)` clamped to `cap`. PURE — the supervisor's respawn schedule
 * is fully deterministic given the injected clock/scheduler (testable). Guards
 * a huge `n` from overflowing `2^(n-1)` to Infinity by clamping the exponent.
 */
export const backoffForAttempt = (n: number, baseMs: number, capMs: number): number => {
  if (n <= 1) return Math.min(baseMs, capMs)
  // 2^30 already dwarfs any realistic cap; clamp the exponent so a large n can
  // never produce Infinity (which Math.min would then return as the cap anyway,
  // but we avoid the intermediate Infinity entirely).
  const exp = Math.min(n - 1, 30)
  return Math.min(baseMs * 2 ** exp, capMs)
}

/**
 * Build a supervisor over ONE forked side-agent process (V1 core). The
 * supervisor is the ONLY stateful piece; the OS layer (fork) + timers (clock /
 * scheduler) are injected, so the fork → run → crash → backoff → respawn →
 * give-up cycle is driven deterministically in tests over a fake fork.
 *
 * Crash semantics: an exit AFTER `stop()` is EXPECTED (no respawn). An exit
 * BEFORE `stop()` is a CRASH ⇒ schedule a respawn with exponential backoff,
 * up to `maxRestarts`; past that the daemon is `crashed-permanently` and stays
 * down (no infinite respawn loop — the runaway guard).
 */
export const createSupervisedProcessDaemon = (
  opts: SupervisedProcessDaemonOpts,
): SupervisedProcessDaemon => {
  const maxRestarts = opts.maxRestarts ?? DEFAULT_MAX_RESTARTS
  const baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS
  const backoffCapMs = opts.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS

  let status: SupervisedDaemonStatus = "stopped"
  let child: ChildProcessHandle | undefined
  let unsubMessage: (() => void) | undefined
  let unsubExit: (() => void) | undefined
  let backoffHandle: unknown
  let restartCount = 0
  /** Set true by `stop()` so an in-flight child exit is treated as expected. */
  let stopping = false

  const setStatus = (s: SupervisedDaemonStatus): void => {
    if (status === s) return
    status = s
    opts.onStatus?.(s)
  }

  const detach = (): void => {
    unsubMessage?.()
    unsubExit?.()
    unsubMessage = undefined
    unsubExit = undefined
    child = undefined
  }

  const handleChildMessage = (msg: SideAgentIpcMessage): void => {
    if (msg.kind === "finding") {
      // Trust boundary: a child killed mid-result-write (SIGKILL) can deliver a
      // COMPLETE IPC frame whose `finding` payload is half-built — `summary`
      // absent, or a non-string slot left from a partially-serialized object.
      // (Node's `serialization:"advanced"` channel never delivers a TRUNCATED
      // frame — it's whole-frame-or-nothing — but it does NOT validate our
      // payload shape.) Drop a malformed finding rather than forwarding ill-typed
      // junk into the findings log (which is typed `summary: string`); the wake's
      // crash is still observed via `onExit`. This keeps the read loop NO-THROW
      // and the log shape-clean even against an adversarial / dying child.
      if (typeof msg.summary !== "string" || msg.summary.length === 0) return
      opts.onFinding(
        typeof msg.detail === "string"
          ? { summary: msg.summary, detail: msg.detail }
          : { summary: msg.summary },
      )
      return
    }
    if (msg.kind === "ready" && child !== undefined) {
      // Hand the child its charter once it beacons ready.
      child.send({ kind: "charter", task: opts.task, maxTurnsPerWake: opts.maxTurnsPerWake })
      setStatus("running")
    }
  }

  // Forward-declared so `handleChildExit` can re-enter the spawn path.
  let spawnChild: () => void

  const scheduleRespawn = (): void => {
    if (restartCount >= maxRestarts) {
      setStatus("crashed-permanently")
      return
    }
    restartCount += 1
    setStatus("backing-off")
    const delay = backoffForAttempt(restartCount, baseBackoffMs, backoffCapMs)
    backoffHandle = opts.scheduler.schedule(() => {
      backoffHandle = undefined
      // A `stop()` during the backoff window cancels the respawn (the handle is
      // cancelled in `stop`), but guard re-entrancy: only respawn if not stopping.
      if (!stopping) spawnChild()
    }, delay)
  }

  const handleChildExit = (): void => {
    detach()
    if (stopping) {
      // Expected exit after stop() — terminal.
      setStatus("stopped")
      return
    }
    // Unexpected crash ⇒ respawn with backoff (bounded).
    scheduleRespawn()
  }

  spawnChild = (): void => {
    setStatus("starting")
    const handle = opts.fork.fork(opts.forkSpec)
    child = handle
    unsubMessage = handle.onMessage(handleChildMessage)
    unsubExit = handle.onExit(handleChildExit)
  }

  return {
    start(): void {
      if (child !== undefined || status === "backing-off") return // already live
      stopping = false
      restartCount = 0
      spawnChild()
    },

    stop(): void {
      stopping = true
      if (backoffHandle !== undefined) {
        opts.scheduler.cancel(backoffHandle)
        backoffHandle = undefined
      }
      const live = child
      if (live !== undefined) {
        live.send({ kind: "shutdown" })
        live.kill()
        detach()
      }
      setStatus("stopped")
    },

    status: () => status,
    restarts: () => restartCount,
    pid: () => child?.pid,
  }
}
