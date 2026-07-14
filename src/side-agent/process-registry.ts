/**
 * §4.3 — the PROCESS-backed side-agent daemon REGISTRY (the "OS daemon MANAGER"
 * that was the slice's explicitly-deferred V1 non-goal, now built).
 *
 * The in-process {@link createSideAgentDaemonRegistry} runs every side-agent on
 * the MAIN thread (an injected `runner` pass per wake). This adapter is the
 * MULTI-DAEMON registry over OS PROCESSES: it satisfies the SAME
 * `SideAgentDaemonRegistry` shape the tools/host consume, but backs EACH daemon
 * with a {@link createSupervisedProcessDaemon} — a forked child with IPC +
 * supervised crash-respawn. The composition root selects this backer over the
 * in-process one under `QUANTA_SIDE_AGENT_PROCESS`.
 *
 * Semantics mirrored from the in-process registry so the swap is transparent to
 * the `side_agent_*` tools:
 *   - `spawn(spec)` enforces the SAME `maxConcurrent` cap (counting RUNNING
 *     daemons only) and throws the SAME `SideAgentError("cap-exceeded")` shape;
 *     it mints a `sa-<n>` id, then forks+starts a supervisor for that child.
 *   - findings the child posts over IPC are collected into a per-registry log,
 *     tagged with the daemon id + an incrementing per-daemon wake counter (the
 *     in-process registry's `wake` field), ring-buffer-capped like the in-process
 *     `findingsLog`.
 *   - `list()` maps each supervisor's lifecycle status into the `SideAgentStatus`
 *     vocab the snapshot/tools expect (running / stopped / failed) and reports
 *     spec, wakesDone, startedAt/stoppedAt.
 *   - `stop(id)` stops the supervisor, marks the daemon terminal, idempotent.
 *
 * Trigger note: the process model differs from the in-process interval/event
 * trigger — a forked child runs its OWN wake loop and PUSHES findings; the
 * registry does not drive a `setInterval` per daemon. The `spec.trigger` is
 * retained verbatim on the snapshot (so `list()` renders it) but the registry
 * does not arm an in-process timer for a process-backed daemon — the child's
 * cadence lives in the worker. (`teamIdle`/`idleSince` are host-only/in-process
 * coordination signals and are reported as not-idle here — opt-in only on the
 * in-process backer.)
 *
 * PLANE-CLEAN: `@/side-agent` reaches nothing — this imports only `./process`
 * (the supervisor + ports) and `./types` (the shared registry/spec/finding
 * types). The real `ProcessForkPort`/clock/scheduler are injected by the host.
 * NO-THROW except the deliberate `cap-exceeded` (mirrors the in-process registry).
 */

import {
  createSupervisedProcessDaemon,
  type DelayScheduler,
  type ProcessForkPort,
  type SupervisedDaemonStatus,
  type SupervisedProcessDaemon,
} from "./process"
import {
  type SideAgentDaemonRegistry,
  SideAgentError,
  type SideAgentFinding,
  type SideAgentSnapshot,
  type SideAgentSpec,
  type SideAgentStatus,
} from "./types"

const DEFAULT_MAX_CONCURRENT = 2
const DEFAULT_MAX_FINDINGS = 1000
const DEFAULT_MAX_RETAINED = 100

/**
 * LINEAGE ENV SEAM — the env key by which the SPAWNING agent's real depth is
 * threaded across the OS-process fork boundary onto the forked worker. It is
 * merged into the fork spec's `env` here; the real `nodeProcessForkPort` forks
 * with `{ ...process.env, ...spec.env }`, so the worker inherits it and
 * `worker-charter-runner.resolveDaemonDepth(process.env)` derives the daemon's
 * own depth from it (absent ⇒ the fail-closed floor).
 *
 * MIRRORED (not imported) from `worker-charter-runner.WORKER_PARENT_DEPTH_ENV`
 * on purpose: `worker-charter-runner.ts` is the CHILD composition root (it
 * value-imports `@/agent`/`@/llm`/`@/tool`), so importing it here would drag
 * those heavy deps into this PURE-LEAF registry and defeat its
 * fakes-only testability. The two are kept in lock-step by a drift guard in the
 * depth-containment hellgate test (asserts this === the exported const). Same
 * duck-typed-mirror convention as `SideAgentIdleBarrierPort` in `./types`. */
export const WORKER_PARENT_DEPTH_ENV_KEY = "QUANTA_SIDE_AGENT_PARENT_DEPTH" as const

export interface ProcessSideAgentRegistryOpts {
  /** The OS layer — the real adapter is `nodeProcessForkPort`; tests pass a fake. */
  readonly fork: ProcessForkPort
  /** Injected one-shot scheduler for the supervisor's respawn backoff timer. */
  readonly scheduler: DelayScheduler
  /** Injected clock (no `Date.now` of this slice's own). */
  readonly now: () => number
  /** Absolute path to the production worker module each child boots. */
  readonly workerModulePath: string
  /** Extra env merged onto each forked child (the child also inherits the
   *  parent's env via the fork adapter — model/provider/credentials). */
  readonly childEnv?: Readonly<Record<string, string>>
  /** The SPAWNING agent's own lineage depth at daemon-creation time (the host
   *  passes `cfg.depth`). Threaded across the fork boundary via
   *  {@link WORKER_PARENT_DEPTH_ENV_KEY} so the forked worker's daemon config runs
   *  at its TRUE lineage depth (its investigating pass is bounded one level
   *  deeper) instead of the always-floor. FAIL-CLOSED: only a valid non-negative
   *  integer is threaded; absent / malformed ⇒ the key is NOT set and the worker
   *  falls back to `resolveDaemonDepth`'s floor (never a fabricated shallow depth,
   *  which would WIDEN the daemon's descendant budget). */
  readonly parentDepth?: number
  /** Working directory for the forked children. */
  readonly cwd?: string
  /** Runaway guard — max concurrent RUNNING daemons (default 2, matches the
   *  in-process registry). */
  readonly maxConcurrent?: number
  /** Ring-buffer cap on the collected findings log (default 1000, matches the
   *  in-process registry). */
  readonly maxFindings?: number
  /** Cap on retained TERMINAL daemons (default 100, matches the in-process
   *  registry); past this the oldest terminal daemons are pruned from `list()`. */
  readonly maxRetained?: number
  /** Optional id generator (default: a deterministic monotonic `sa-<n>`, the
   *  SAME scheme the in-process registry uses). */
  readonly idGen?: () => string
  /** Per-supervisor max UNEXPECTED restarts before `crashed-permanently`
   *  (forwarded to {@link createSupervisedProcessDaemon}; default = supervisor's). */
  readonly maxRestarts?: number
  /** Per-supervisor base backoff (ms) — forwarded to the supervisor. */
  readonly baseBackoffMs?: number
  /** Per-supervisor backoff ceiling (ms) — forwarded to the supervisor. */
  readonly backoffCapMs?: number
}

/** Per-daemon book-keeping the registry tracks alongside its supervisor. */
interface ProcessDaemonState {
  readonly id: string
  readonly spec: SideAgentSpec
  readonly supervisor: SupervisedProcessDaemon
  readonly startedAt: number
  /** Per-daemon wake counter — one per finding pushed (the in-process `wake`). */
  wakes: number
  lastFindingAt: number | undefined
  stoppedAt: number | undefined
  /** Set true once the registry has `stop()`ed this daemon (terminal-by-request),
   *  so `list()` reports `stopped` rather than deriving from the supervisor. */
  stoppedByRequest: boolean
}

/** Map a supervisor lifecycle status → the registry's `SideAgentStatus` vocab.
 *  `starting`/`running`/`backing-off` are all "alive" from the registry's view
 *  (the supervisor is keeping the daemon up); a clean `stopped` is `stopped`; a
 *  `crashed-permanently` (gave up respawning) is `failed`. */
const mapStatus = (s: SupervisedDaemonStatus): SideAgentStatus => {
  switch (s) {
    case "stopped":
      return "stopped"
    case "crashed-permanently":
      return "failed"
    default:
      return "running"
  }
}

/** Record an IPC finding with the same wake accounting and ring cap as the
 * in-process registry. Kept outside the registry factory to keep construction
 * focused on lifecycle wiring. */
const recordProcessFinding = (
  opts: Pick<ProcessSideAgentRegistryOpts, "now">,
  daemonId: string,
  state: ProcessDaemonState,
  finding: { readonly summary: string; readonly detail?: string },
  findingsLog: SideAgentFinding[],
  maxFindings: number,
): void => {
  state.wakes += 1
  const at = opts.now()
  findingsLog.push({
    daemonId,
    wake: state.wakes,
    summary: finding.summary,
    at,
    ...(finding.detail !== undefined ? { detail: finding.detail } : {}),
  })
  if (findingsLog.length > maxFindings) findingsLog.shift()
  state.lastFindingAt = at
}

export const createProcessSideAgentDaemonRegistry = (
  opts: ProcessSideAgentRegistryOpts,
): SideAgentDaemonRegistry => {
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  const maxFindings = opts.maxFindings ?? DEFAULT_MAX_FINDINGS
  const maxRetained = opts.maxRetained ?? DEFAULT_MAX_RETAINED
  const daemons = new Map<string, ProcessDaemonState>()
  const findingsLog: SideAgentFinding[] = []
  let idCounter = 0
  const mintId = (): string => opts.idGen?.() ?? `sa-${++idCounter}`

  // Lineage env threaded onto EVERY forked child: the spawning agent's real depth
  // (so the worker daemon config runs at its true lineage, not the floor). Merged
  // AFTER any operator `childEnv` so lineage cannot be shadowed. FAIL-CLOSED: only
  // a valid non-negative integer is threaded — an absent/malformed depth leaves
  // the key unset and the worker floors (never a fabricated shallow budget).
  const lineageEnv: Record<string, string> =
    typeof opts.parentDepth === "number" &&
    Number.isInteger(opts.parentDepth) &&
    opts.parentDepth >= 0
      ? { [WORKER_PARENT_DEPTH_ENV_KEY]: String(opts.parentDepth) }
      : {}
  // The env handed to the fork spec: operator childEnv (if any) THEN lineage
  // (lineage wins). Undefined only when BOTH are empty (byte-identical legacy).
  const forkEnv: Readonly<Record<string, string>> | undefined =
    opts.childEnv !== undefined || Object.keys(lineageEnv).length > 0
      ? { ...(opts.childEnv ?? {}), ...lineageEnv }
      : undefined

  /** Effective registry-facing status of a daemon. */
  const statusOf = (d: ProcessDaemonState): SideAgentStatus =>
    d.stoppedByRequest ? "stopped" : mapStatus(d.supervisor.status())

  const runningCount = (): number => {
    let n = 0
    for (const d of daemons.values()) if (statusOf(d) === "running") n++
    return n
  }

  /** Bound the daemon map: prune the OLDEST terminal daemons past `maxRetained`
   *  (running daemons are never pruned). Insertion order is oldest-first. */
  const pruneTerminal = (): void => {
    const terminal: string[] = []
    for (const d of daemons.values()) if (statusOf(d) !== "running") terminal.push(d.id)
    let over = terminal.length - maxRetained
    for (let i = 0; over > 0 && i < terminal.length; i++, over--) {
      daemons.delete(terminal[i] as string)
    }
  }

  return {
    spawn(spec: SideAgentSpec): string {
      // Cap — counts RUNNING daemons only (a stopped/failed daemon frees its
      // slot), throwing the SAME error shape as the in-process registry.
      if (runningCount() >= maxConcurrent) {
        throw new SideAgentError(
          "cap-exceeded",
          `side-agent cap reached (maxConcurrent=${maxConcurrent})`,
        )
      }
      const id = mintId()
      const state: ProcessDaemonState = {
        id,
        spec,
        // supervisor assigned just below (forward ref for the onFinding closure).
        supervisor: undefined as unknown as SupervisedProcessDaemon,
        startedAt: opts.now(),
        wakes: 0,
        lastFindingAt: undefined,
        stoppedAt: undefined,
        stoppedByRequest: false,
      }
      const supervisor = createSupervisedProcessDaemon({
        task: spec.task,
        maxTurnsPerWake: spec.maxTurnsPerWake,
        fork: opts.fork,
        forkSpec: {
          modulePath: opts.workerModulePath,
          ...(forkEnv !== undefined ? { env: forkEnv } : {}),
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        },
        now: opts.now,
        scheduler: opts.scheduler,
        onFinding: (finding) =>
          recordProcessFinding(opts, id, state, finding, findingsLog, maxFindings),
        ...(opts.maxRestarts !== undefined ? { maxRestarts: opts.maxRestarts } : {}),
        ...(opts.baseBackoffMs !== undefined ? { baseBackoffMs: opts.baseBackoffMs } : {}),
        ...(opts.backoffCapMs !== undefined ? { backoffCapMs: opts.backoffCapMs } : {}),
      })
      ;(state as { supervisor: SupervisedProcessDaemon }).supervisor = supervisor
      daemons.set(id, state)
      // START the supervisor — fork the child + wire IPC (the load-bearing line:
      // without it the daemon never runs).
      supervisor.start()
      pruneTerminal()
      return id
    },

    findings(o?: { readonly since?: number }): ReadonlyArray<SideAgentFinding> {
      const since = o?.since
      return findingsLog.filter((f) => since === undefined || f.at > since)
    },

    list(): ReadonlyArray<SideAgentSnapshot> {
      const snaps: SideAgentSnapshot[] = [...daemons.values()].map((d) => ({
        id: d.id,
        status: statusOf(d),
        spec: d.spec,
        wakesDone: d.wakes,
        startedAt: d.startedAt,
        ...(d.lastFindingAt !== undefined ? { lastFindingAt: d.lastFindingAt } : {}),
        ...(d.stoppedAt !== undefined ? { stoppedAt: d.stoppedAt } : {}),
      }))
      snaps.sort((a, b) => b.startedAt - a.startedAt) // newest-first
      return snaps
    },

    stop(id: string): boolean {
      const d = daemons.get(id)
      if (d === undefined) return false
      // Idempotent: stopping an already-terminal daemon is a no-op that still
      // returns true (the id exists).
      if (!d.stoppedByRequest) {
        d.supervisor.stop()
        d.stoppedByRequest = true
        d.stoppedAt = opts.now()
      }
      pruneTerminal()
      return true
    },

    stopAll(): number {
      let n = 0
      for (const d of daemons.values()) {
        if (statusOf(d) === "running") {
          d.supervisor.stop()
          d.stoppedByRequest = true
          d.stoppedAt = opts.now()
          n++
        }
      }
      pruneTerminal()
      return n
    },

    // Team-idle coordination is an in-process-only opt-in signal (it needs the
    // shared idle barrier); a process-backed daemon does not participate.
    teamIdle: () => false,
    idleSince: () => undefined,
  }
}
