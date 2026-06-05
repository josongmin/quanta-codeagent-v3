/**
 * N1 — the side-agent daemon registry: the supervise loop + runaway guards
 * (RFC §4). Pure orchestration over injected ports (runner/mailbox/sink/events/
 * timers/clock) — no concrete imports, no `Date.now()`/`setInterval` of its own.
 */

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

interface DaemonState {
  readonly id: string
  readonly spec: SideAgentSpec
  status: SideAgentStatus
  wakesDone: number
  readonly startedAt: number
  lastFindingAt: number | undefined
  stoppedAt: number | undefined
  readonly abort: AbortController
  /** `setInterval` handle (interval trigger) — cleared on stop. */
  timerHandle: unknown
  /** Unsubscribe fn (event trigger) — called on stop. */
  unsubscribe: (() => void) | undefined
  /** A pass is in flight — drop overlapping wakes. */
  inFlight: boolean
}

export const createSideAgentDaemonRegistry = (
  opts: SideAgentDaemonOpts,
): SideAgentDaemonRegistry => {
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  const daemons = new Map<string, DaemonState>()
  const findingsLog: SideAgentFinding[] = []
  let idCounter = 0
  const mintId = (): string => opts.idGen?.() ?? `sa-${++idCounter}`

  const runningCount = (): number => {
    let n = 0
    for (const d of daemons.values()) if (d.status === "running") n++
    return n
  }

  /** Tear a daemon down to a terminal status. Idempotent. */
  const finish = (id: string, status: SideAgentStatus): boolean => {
    const d = daemons.get(id)
    if (d === undefined) return false
    if (d.status !== "running") return true // already terminal — no-op
    d.status = status
    d.stoppedAt = opts.now()
    d.abort.abort()
    if (d.timerHandle !== undefined) opts.clearInterval(d.timerHandle)
    if (d.unsubscribe !== undefined) d.unsubscribe()
    d.timerHandle = undefined
    d.unsubscribe = undefined
    return true
  }

  /** Publish a non-null pass result to the mailbox + log + optional sink. */
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
    opts.mailbox.send({
      from: d.id,
      to: opts.mainRecipient,
      kind: "finding",
      summary: finding.summary,
      ...(finding.detail !== undefined ? { detail: finding.detail } : {}),
    })
    opts.sink?.emit(finding)
    d.lastFindingAt = finding.at
  }

  /** Hard wake ceiling, then idle reaper — applied AFTER a completed pass. */
  const applyPostPassBounds = (d: DaemonState): void => {
    if (d.status !== "running") return
    if (d.wakesDone >= d.spec.maxWakes) {
      finish(d.id, "stopped")
      return
    }
    if (d.spec.idleReapMs !== undefined) {
      const lastSignal = d.lastFindingAt ?? d.startedAt
      if (opts.now() - lastSignal >= d.spec.idleReapMs) finish(d.id, "idle-reaped")
    }
  }

  /** Run ONE bounded pass for daemon `id` (drops overlapping wakes). */
  const wake = async (id: string): Promise<void> => {
    const d = daemons.get(id)
    if (d === undefined || d.status !== "running" || d.inFlight) return
    if (d.wakesDone >= d.spec.maxWakes) {
      finish(id, "stopped")
      return
    }
    d.inFlight = true
    d.wakesDone += 1
    const wakeIndex = d.wakesDone
    try {
      const result = await opts.runner.run({
        task: d.spec.task,
        wake: wakeIndex,
        maxTurns: d.spec.maxTurnsPerWake,
        signal: d.abort.signal,
      })
      if (!d.abort.signal.aborted && result !== null) publish(d, wakeIndex, result)
    } catch {
      d.inFlight = false
      finish(id, "failed") // a thrown pass fails the daemon (not propagated)
      return
    }
    d.inFlight = false
    applyPostPassBounds(d)
  }

  const armTrigger = (d: DaemonState): void => {
    const trig = d.spec.trigger
    if (trig.kind === "interval") {
      d.timerHandle = opts.setInterval(() => {
        void wake(d.id)
      }, trig.everyMs)
    } else if (opts.events !== undefined) {
      d.unsubscribe = opts.events.subscribe(trig.topic, () => {
        void wake(d.id)
      })
    }
  }

  return {
    spawn(spec: SideAgentSpec): string {
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
        wakesDone: 0,
        startedAt: opts.now(),
        lastFindingAt: undefined,
        stoppedAt: undefined,
        abort: new AbortController(),
        timerHandle: undefined,
        unsubscribe: undefined,
        inFlight: false,
      }
      daemons.set(id, d)
      armTrigger(d)
      return id
    },

    findings(o?: { since?: number }): ReadonlyArray<SideAgentFinding> {
      const since = o?.since
      return findingsLog.filter((f) => since === undefined || f.at > since)
    },

    list(): ReadonlyArray<SideAgentSnapshot> {
      const snaps: SideAgentSnapshot[] = [...daemons.values()].map((d) => ({
        id: d.id,
        status: d.status,
        spec: d.spec,
        wakesDone: d.wakesDone,
        startedAt: d.startedAt,
        ...(d.lastFindingAt !== undefined ? { lastFindingAt: d.lastFindingAt } : {}),
        ...(d.stoppedAt !== undefined ? { stoppedAt: d.stoppedAt } : {}),
      }))
      // Newest-first by startedAt.
      snaps.sort((a, b) => b.startedAt - a.startedAt)
      return snaps
    },

    stop(id: string): boolean {
      if (!daemons.has(id)) return false
      finish(id, "stopped")
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
      return n
    },
  }
}
