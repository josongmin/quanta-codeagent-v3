/**
 * §4.3 — PROCESS-backed side-agent daemon registry. Same `SideAgentDaemonRegistry`
 * shape as the in-process backer; each daemon is a supervised OS child. Cadence,
 * spec validation, and wake accounting are the shared `./control` engine — this
 * file is the runPass adapter (send charter + await a wake terminal).
 */

import {
  createDaemonEngine,
  type DaemonEngine,
  type PassFinding,
  type PassOutcome,
  validateSideAgentSpec,
} from "./control"
import {
  createSupervisedProcessDaemon,
  type DelayScheduler,
  type ProcessForkPort,
  SIDE_AGENT_IPC_VERSION,
  type SideAgentIpcMessage,
  type SupervisedDaemonStatus,
  type SupervisedProcessDaemon,
} from "./process"
import {
  type SideAgentDaemonRegistry,
  SideAgentError,
  type SideAgentEventSourcePort,
  type SideAgentFinding,
  type SideAgentSnapshot,
  type SideAgentSpec,
  type SideAgentStatus,
} from "./types"

const DEFAULT_MAX_CONCURRENT = 2
const DEFAULT_MAX_FINDINGS = 1000
const DEFAULT_MAX_RETAINED = 100

export const WORKER_PARENT_DEPTH_ENV_KEY = "QUANTA_SIDE_AGENT_PARENT_DEPTH" as const

export interface ProcessSideAgentRegistryOpts {
  readonly fork: ProcessForkPort
  readonly scheduler: DelayScheduler
  readonly now: () => number
  readonly workerModulePath: string
  readonly childEnv?: Readonly<Record<string, string>>
  readonly parentDepth?: number
  readonly cwd?: string
  readonly maxConcurrent?: number
  readonly maxFindings?: number
  readonly maxRetained?: number
  readonly idGen?: () => string
  readonly maxRestarts?: number
  readonly baseBackoffMs?: number
  readonly backoffCapMs?: number
  /** Injected timers (tests). Host/I-stage should pass these; default is global. */
  readonly setInterval?: (handler: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
  readonly events?: SideAgentEventSourcePort
}

interface WakeWaiter {
  readonly wakeId: number
  readonly generation: number
  readonly findings: PassFinding[]
  settle(outcome: PassOutcome): void
}

interface ProcessDaemonState {
  readonly id: string
  readonly spec: SideAgentSpec
  supervisor: SupervisedProcessDaemon
  readonly startedAt: number
  stoppedAt: number | undefined
  stoppedByRequest: boolean
  statusOverride: SideAgentStatus | undefined
  engine: DaemonEngine
  waiter: WakeWaiter | undefined
}

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

const statusOf = (d: ProcessDaemonState): SideAgentStatus => {
  if (d.statusOverride !== undefined) return d.statusOverride
  if (d.stoppedByRequest) return "stopped"
  return mapStatus(d.supervisor.status())
}

const ipcWakeId = (msg: SideAgentIpcMessage): number | undefined => {
  if ("wakeId" in msg && typeof msg.wakeId === "number") return msg.wakeId
  return undefined
}

const ipcVersionOk = (msg: SideAgentIpcMessage): boolean =>
  "version" in msg && msg.version === SIDE_AGENT_IPC_VERSION

const asFinding = (msg: SideAgentIpcMessage): PassFinding | undefined => {
  if (msg.kind !== "finding") return undefined
  if (typeof msg.summary !== "string" || msg.summary.length === 0) return undefined
  return typeof msg.detail === "string"
    ? { summary: msg.summary, detail: msg.detail }
    : { summary: msg.summary }
}

const applyWaiterMessage = (state: ProcessDaemonState, msg: SideAgentIpcMessage): void => {
  const w = state.waiter
  if (w === undefined) return
  if (!ipcVersionOk(msg)) return
  const wakeId = ipcWakeId(msg)
  if (wakeId !== w.wakeId) return
  if (w.generation !== state.engine.generation) return
  const finding = asFinding(msg)
  if (finding !== undefined) {
    w.findings.push(finding)
    return
  }
  if (msg.kind === "no_finding") {
    w.settle({ kind: "no_finding" })
    return
  }
  if (msg.kind === "failed") {
    const reason = msg.reason
    w.settle(reason === undefined ? { kind: "failed" } : { kind: "failed", reason })
    return
  }
  if (msg.kind === "cancelled") {
    w.settle({ kind: "cancelled" })
    return
  }
  if (msg.kind === "completed") {
    w.settle(
      w.findings.length === 0
        ? { kind: "no_finding" }
        : { kind: "findings", findings: [...w.findings] },
    )
  }
}

const settleWaiterOnDeath = (state: ProcessDaemonState): void => {
  const w = state.waiter
  if (w === undefined) return
  w.settle(
    w.findings.length === 0
      ? { kind: "cancelled" }
      : { kind: "cancelled", findings: [...w.findings] },
  )
}

const lineageForkEnv = (
  opts: ProcessSideAgentRegistryOpts,
): Readonly<Record<string, string>> | undefined => {
  const lineageEnv: Record<string, string> =
    typeof opts.parentDepth === "number" &&
    Number.isInteger(opts.parentDepth) &&
    opts.parentDepth >= 0
      ? { [WORKER_PARENT_DEPTH_ENV_KEY]: String(opts.parentDepth) }
      : {}
  if (opts.childEnv === undefined && Object.keys(lineageEnv).length === 0) return undefined
  return { ...(opts.childEnv ?? {}), ...lineageEnv }
}

const beginWakePass = (
  state: ProcessDaemonState,
  signal: AbortSignal,
  wakeId: number,
): Promise<PassOutcome> =>
  new Promise<PassOutcome>((resolve) => {
    let settled = false
    const settle = (outcome: PassOutcome): void => {
      if (settled) return
      settled = true
      state.waiter = undefined
      resolve(outcome)
    }
    state.waiter = { wakeId, generation: state.engine.generation, findings: [], settle }
    signal.addEventListener("abort", () => settle({ kind: "cancelled" }), { once: true })
    state.supervisor.send({
      kind: "charter",
      version: SIDE_AGENT_IPC_VERSION,
      wakeId,
      task: state.spec.task,
      maxTurnsPerWake: state.spec.maxTurnsPerWake,
    })
  })

interface ProcessTables {
  readonly opts: ProcessSideAgentRegistryOpts
  readonly maxConcurrent: number
  readonly daemons: Map<string, ProcessDaemonState>
  readonly findingsLog: SideAgentFinding[]
  readonly forkEnv: Readonly<Record<string, string>> | undefined
  readonly setIntervalFn: (handler: () => void, ms: number) => unknown
  readonly clearIntervalFn: (handle: unknown) => void
  mintId(): string
  pruneTerminal(): void
  finish(d: ProcessDaemonState, status: SideAgentStatus): void
  attachEngine(state: ProcessDaemonState): void
}

const processTables = (opts: ProcessSideAgentRegistryOpts): ProcessTables => {
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  const maxFindings = opts.maxFindings ?? DEFAULT_MAX_FINDINGS
  const maxRetained = opts.maxRetained ?? DEFAULT_MAX_RETAINED
  const setIntervalFn = opts.setInterval ?? ((h, ms) => setInterval(h, ms))
  const clearIntervalFn =
    opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>))
  const daemons = new Map<string, ProcessDaemonState>()
  const findingsLog: SideAgentFinding[] = []
  let idCounter = 0
  const mintId = (): string => opts.idGen?.() ?? `sa-${++idCounter}`

  const pruneTerminal = (): void => {
    const terminal: string[] = []
    for (const d of daemons.values()) if (statusOf(d) !== "running") terminal.push(d.id)
    let over = terminal.length - maxRetained
    for (let i = 0; over > 0 && i < terminal.length; i++, over--) {
      daemons.delete(terminal[i] as string)
    }
  }

  const publish = (d: ProcessDaemonState, wakeIndex: number, finding: PassFinding): void => {
    const at = opts.now()
    findingsLog.push({
      daemonId: d.id,
      wake: wakeIndex,
      summary: finding.summary,
      at,
      ...(finding.detail !== undefined ? { detail: finding.detail } : {}),
    })
    if (findingsLog.length > maxFindings) findingsLog.shift()
  }

  const finish = (d: ProcessDaemonState, status: SideAgentStatus): void => {
    if (statusOf(d) !== "running" && d.statusOverride !== undefined) return
    d.statusOverride = status
    d.stoppedAt = opts.now()
    d.engine.disarm()
    if (status === "stopped") d.stoppedByRequest = true
    d.supervisor.stop()
  }

  const attachEngine = (state: ProcessDaemonState): void => {
    state.engine = createDaemonEngine({
      id: state.id,
      spec: state.spec,
      now: opts.now,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
      ...(opts.events !== undefined ? { events: opts.events } : {}),
      isRunning: () => statusOf(state) === "running",
      finish: (status) => finish(state, status),
      prune: pruneTerminal,
      publish: (wakeIndex, finding) => publish(state, wakeIndex, finding),
      runPass: ({ wakeId, signal }) => beginWakePass(state, signal, wakeId),
    })
  }

  return {
    opts,
    maxConcurrent,
    daemons,
    findingsLog,
    forkEnv: lineageForkEnv(opts),
    setIntervalFn,
    clearIntervalFn,
    mintId,
    pruneTerminal,
    finish,
    attachEngine,
  }
}

const spawnProcessDaemon = (ctx: ProcessTables, spec: SideAgentSpec): string => {
  validateSideAgentSpec(spec, ctx.opts.events !== undefined)
  let running = 0
  for (const d of ctx.daemons.values()) if (statusOf(d) === "running") running++
  if (running >= ctx.maxConcurrent) {
    throw new SideAgentError(
      "cap-exceeded",
      `side-agent cap reached (maxConcurrent=${ctx.maxConcurrent})`,
    )
  }
  const id = ctx.mintId()
  const state: ProcessDaemonState = {
    id,
    spec,
    supervisor: undefined as unknown as SupervisedProcessDaemon,
    startedAt: ctx.opts.now(),
    stoppedAt: undefined,
    stoppedByRequest: false,
    statusOverride: undefined,
    engine: undefined as unknown as DaemonEngine,
    waiter: undefined,
  }
  const supervisor = createSupervisedProcessDaemon({
    task: spec.task,
    maxTurnsPerWake: spec.maxTurnsPerWake,
    fork: ctx.opts.fork,
    forkSpec: {
      modulePath: ctx.opts.workerModulePath,
      ...(ctx.forkEnv !== undefined ? { env: ctx.forkEnv } : {}),
      ...(ctx.opts.cwd !== undefined ? { cwd: ctx.opts.cwd } : {}),
    },
    now: ctx.opts.now,
    scheduler: ctx.opts.scheduler,
    autoCharterOnReady: false,
    onFinding: () => undefined,
    onIpc: (msg) => {
      if (msg.kind === "ready") {
        state.engine.requestWake()
        return
      }
      applyWaiterMessage(state, msg)
    },
    onChildExit: () => {
      settleWaiterOnDeath(state)
      state.engine.onChildDeath()
    },
    onStatus: (s) => {
      if (s !== "crashed-permanently" || state.statusOverride !== undefined) return
      state.statusOverride = "failed"
      state.stoppedAt = ctx.opts.now()
      state.engine.disarm()
    },
    ...(ctx.opts.maxRestarts !== undefined ? { maxRestarts: ctx.opts.maxRestarts } : {}),
    ...(ctx.opts.baseBackoffMs !== undefined ? { baseBackoffMs: ctx.opts.baseBackoffMs } : {}),
    ...(ctx.opts.backoffCapMs !== undefined ? { backoffCapMs: ctx.opts.backoffCapMs } : {}),
  })
  state.supervisor = supervisor
  ctx.attachEngine(state)
  ctx.daemons.set(id, state)
  supervisor.start()
  state.engine.arm()
  ctx.pruneTerminal()
  return id
}

export const createProcessSideAgentDaemonRegistry = (
  opts: ProcessSideAgentRegistryOpts,
): SideAgentDaemonRegistry => {
  const ctx = processTables(opts)
  return {
    spawn: (spec) => spawnProcessDaemon(ctx, spec),
    findings(o?: { readonly since?: number }): ReadonlyArray<SideAgentFinding> {
      const since = o?.since
      return ctx.findingsLog.filter((f) => since === undefined || f.at > since)
    },
    list(): ReadonlyArray<SideAgentSnapshot> {
      const snaps: SideAgentSnapshot[] = [...ctx.daemons.values()].map((d) => ({
        id: d.id,
        status: statusOf(d),
        spec: d.spec,
        wakesDone: d.engine.wakesDone,
        startedAt: d.startedAt,
        ...(d.engine.lastFindingAt !== undefined ? { lastFindingAt: d.engine.lastFindingAt } : {}),
        ...(d.stoppedAt !== undefined ? { stoppedAt: d.stoppedAt } : {}),
      }))
      snaps.sort((a, b) => b.startedAt - a.startedAt)
      return snaps
    },
    stop(id: string): boolean {
      const d = ctx.daemons.get(id)
      if (d === undefined) return false
      if (statusOf(d) === "running") ctx.finish(d, "stopped")
      ctx.pruneTerminal()
      return true
    },
    stopAll(): number {
      let n = 0
      for (const d of ctx.daemons.values()) {
        if (statusOf(d) === "running") {
          ctx.finish(d, "stopped")
          n++
        }
      }
      ctx.pruneTerminal()
      return n
    },
    teamIdle: () => false,
    idleSince: () => undefined,
  }
}
