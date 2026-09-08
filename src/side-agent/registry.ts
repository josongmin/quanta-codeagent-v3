/**
 * N1 — the side-agent daemon registry: the supervise loop + runaway guards
 * (RFC §4). Pure orchestration over injected ports (runner/mailbox/sink/events/
 * timers/clock) — no concrete imports, no `Date.now()`/`setInterval` of its own.
 *
 * Cadence, spec validation, wake accounting, and lifetime bounds live in
 * `./control` so the process backer cannot drift.
 */

import {
  createDaemonEngine,
  type DaemonEngine,
  normalizeRunnerResult,
  validateSideAgentSpec,
} from "./control"
import {
  type SideAgentDaemonOpts,
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

interface DaemonState {
  readonly id: string
  readonly spec: SideAgentSpec
  status: SideAgentStatus
  readonly startedAt: number
  stoppedAt: number | undefined
  engine: DaemonEngine
}

const registryTables = (opts: SideAgentDaemonOpts) => {
  const mut = {
    idCounter: 0,
  }
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  const maxFindings = opts.maxFindings ?? DEFAULT_MAX_FINDINGS
  const maxRetained = opts.maxRetained ?? DEFAULT_MAX_RETAINED
  const daemons = new Map<string, DaemonState>()
  const findingsLog: SideAgentFinding[] = []
  const mintId = (): string => opts.idGen?.() ?? `sa-${++mut.idCounter}`

  const runningCount = (): number => {
    let n = 0
    for (const d of daemons.values()) if (d.status === "running") n++
    return n
  }

  const runningIds = (): string[] => {
    const ids: string[] = []
    for (const d of daemons.values()) if (d.status === "running") ids.push(d.id)
    return ids
  }
  return {
    opts,
    mut,
    maxConcurrent,
    maxFindings,
    maxRetained,
    daemons,
    findingsLog,
    mintId,
    runningCount,
    runningIds,
  }
}

type Tables = ReturnType<typeof registryTables>

const registryLifecycle = (ctx: Tables) => {
  const { opts, maxFindings, maxRetained, daemons, findingsLog } = ctx

  const finish = (id: string, status: SideAgentStatus): boolean => {
    const d = daemons.get(id)
    if (d === undefined) return false
    if (d.status !== "running") return true
    d.status = status
    d.stoppedAt = opts.now()
    d.engine.disarm()
    opts.idleBarrier?.reactivate(id)
    return true
  }

  const pruneTerminal = (): void => {
    const terminal: string[] = []
    for (const d of daemons.values()) if (d.status !== "running") terminal.push(d.id)
    let over = terminal.length - maxRetained
    for (let i = 0; over > 0 && i < terminal.length; i++, over--) {
      daemons.delete(terminal[i] as string)
    }
  }

  const publish = (
    d: DaemonState,
    wakeIndex: number,
    result: { summary: string; detail?: string },
  ): void => {
    const finding: SideAgentFinding = {
      daemonId: d.id,
      wake: wakeIndex,
      summary: result.summary,
      at: opts.now(),
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    }
    findingsLog.push(finding)
    if (findingsLog.length > maxFindings) findingsLog.shift()
    opts.mailbox.send({
      from: d.id,
      to: opts.mainRecipient,
      kind: "finding",
      summary: finding.summary,
      ...(finding.detail !== undefined ? { detail: finding.detail } : {}),
    })
    opts.sink?.emit(finding)
  }

  return { finish, pruneTerminal, publish }
}

const attachEngine = (ctx: Tables & ReturnType<typeof registryLifecycle>, d: DaemonState): void => {
  const { opts, finish, pruneTerminal, publish } = ctx
  d.engine = createDaemonEngine({
    id: d.id,
    spec: d.spec,
    now: opts.now,
    setInterval: opts.setInterval,
    clearInterval: opts.clearInterval,
    ...(opts.events !== undefined ? { events: opts.events } : {}),
    ...(opts.idleBarrier !== undefined ? { idleBarrier: opts.idleBarrier } : {}),
    isRunning: () => d.status === "running",
    finish: (status) => finish(d.id, status),
    prune: pruneTerminal,
    publish: (wakeIndex, finding) => publish(d, wakeIndex, finding),
    runPass: async ({ wakeId, task, maxTurns, signal }) => {
      try {
        const raw = await opts.runner.run({ task, wake: wakeId, maxTurns, signal })
        return normalizeRunnerResult(raw)
      } catch {
        return { kind: "failed" }
      }
    },
  })
}

const spawnOps = (
  ctx: Tables & ReturnType<typeof registryLifecycle>,
): Pick<SideAgentDaemonRegistry, "spawn"> => {
  const { opts, maxConcurrent, daemons, mintId, runningCount, pruneTerminal } = ctx
  return {
    spawn(spec: SideAgentSpec): string {
      validateSideAgentSpec(spec, opts.events !== undefined)
      if (runningCount() >= maxConcurrent) {
        throw new SideAgentError(
          "cap-exceeded",
          `side-agent cap reached (maxConcurrent=${maxConcurrent})`,
        )
      }
      const id = mintId()
      const d: DaemonState = {
        id,
        spec,
        status: "running",
        startedAt: opts.now(),
        stoppedAt: undefined,
        engine: undefined as unknown as DaemonEngine,
      }
      attachEngine(ctx, d)
      daemons.set(id, d)
      d.engine.arm()
      pruneTerminal()
      return id
    },
  }
}

const queryOps = (
  ctx: Tables,
): Pick<SideAgentDaemonRegistry, "findings" | "list" | "teamIdle" | "idleSince"> => {
  const { opts, daemons, findingsLog, runningIds } = ctx
  return {
    findings(o?: { since?: number }): ReadonlyArray<SideAgentFinding> {
      const since = o?.since
      return findingsLog.filter((f) => since === undefined || f.at > since)
    },

    list(): ReadonlyArray<SideAgentSnapshot> {
      const snaps: SideAgentSnapshot[] = [...daemons.values()].map((d) => ({
        id: d.id,
        status: d.status,
        spec: d.spec,
        wakesDone: d.engine.wakesDone,
        startedAt: d.startedAt,
        ...(d.engine.lastFindingAt !== undefined ? { lastFindingAt: d.engine.lastFindingAt } : {}),
        ...(d.stoppedAt !== undefined ? { stoppedAt: d.stoppedAt } : {}),
      }))
      snaps.sort((a, b) => b.startedAt - a.startedAt)
      return snaps
    },

    teamIdle(): boolean {
      return opts.idleBarrier?.teamIdle(runningIds()) ?? false
    },

    idleSince(): number | undefined {
      return opts.idleBarrier?.idleSince(runningIds())
    },
  }
}

const stopOps = (
  ctx: Tables & ReturnType<typeof registryLifecycle>,
): Pick<SideAgentDaemonRegistry, "stop" | "stopAll"> => {
  const { daemons, finish, pruneTerminal } = ctx
  return {
    stop(id: string): boolean {
      if (!daemons.has(id)) return false
      finish(id, "stopped")
      pruneTerminal()
      return true
    },

    stopAll(): number {
      let n = 0
      for (const d of daemons.values()) {
        if (d.status === "running") {
          finish(d.id, "stopped")
          n++
        }
      }
      pruneTerminal()
      return n
    },
  }
}

export const createSideAgentDaemonRegistry = (
  opts: SideAgentDaemonOpts,
): SideAgentDaemonRegistry => {
  const tables = registryTables(opts)
  const life = registryLifecycle(tables)
  const ctx = { ...tables, ...life }
  return {
    ...spawnOps(ctx),
    ...queryOps(ctx),
    ...stopOps(ctx),
  }
}
