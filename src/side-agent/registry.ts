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
const DEFAULT_MAX_FINDINGS = 1000
const DEFAULT_MAX_RETAINED = 100

const isPositiveInt = (n: unknown): boolean =>
  typeof n === "number" && Number.isInteger(n) && n >= 1

/**
 * Reject a malformed spec BEFORE it is spawned. Without this, three real
 * footguns slip through (found in self-audit): an `interval` with `everyMs<=0`
 * spins the CPU; an `event` trigger with NO injected event source spawns a
 * zombie that holds a concurrency slot forever; and a non-positive
 * `maxWakes`/`maxTurnsPerWake` either no-ops or runs unbounded. NO-THROW
 * elsewhere — this is a programming-error throw (`invalid-spec`), distinct from
 * the runtime `cap-exceeded`.
 */
const bad = (msg: string): never => {
  throw new SideAgentError("invalid-spec", msg)
}

const validateTrigger = (trig: SideAgentSpec["trigger"], hasEventSource: boolean): void => {
  if (trig.kind === "interval") {
    if (!(typeof trig.everyMs === "number" && trig.everyMs > 0)) {
      bad("interval trigger requires everyMs > 0")
    }
    return
  }
  if (typeof trig.topic !== "string" || trig.topic.length === 0) {
    bad("event trigger requires a non-empty topic")
  }
  // No event source ⇒ the daemon could never wake → refuse rather than leak a
  // concurrency slot on a permanently-asleep zombie.
  if (!hasEventSource) bad("event trigger requires an injected event source (opts.events)")
}

const validateSpec = (spec: SideAgentSpec, hasEventSource: boolean): void => {
  if (typeof spec.task !== "string" || spec.task.trim().length === 0) {
    bad("spec.task must be a non-empty string")
  }
  if (!isPositiveInt(spec.maxWakes)) bad("spec.maxWakes must be an integer ≥ 1")
  if (!isPositiveInt(spec.maxTurnsPerWake)) bad("spec.maxTurnsPerWake must be an integer ≥ 1")
  if (
    spec.idleReapMs !== undefined &&
    !(typeof spec.idleReapMs === "number" && spec.idleReapMs > 0)
  ) {
    bad("spec.idleReapMs, when set, must be > 0")
  }
  validateTrigger(spec.trigger, hasEventSource)
}

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
  const maxFindings = opts.maxFindings ?? DEFAULT_MAX_FINDINGS
  const maxRetained = opts.maxRetained ?? DEFAULT_MAX_RETAINED
  const daemons = new Map<string, DaemonState>()
  const findingsLog: SideAgentFinding[] = []
  let idCounter = 0
  const mintId = (): string => opts.idGen?.() ?? `sa-${++idCounter}`

  const runningCount = (): number => {
    let n = 0
    for (const d of daemons.values()) if (d.status === "running") n++
    return n
  }

  /** Capability C — the ids of currently-running daemons (the barrier's
   *  "members": the team a leader fans IN over). */
  const runningIds = (): string[] => {
    const ids: string[] = []
    for (const d of daemons.values()) if (d.status === "running") ids.push(d.id)
    return ids
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
    // Capability C — a terminal daemon leaves the team; drop its beacon so it
    // does not linger in the barrier (the query filters by running members, but
    // clearing bounds the barrier's beacon set over a long session).
    opts.idleBarrier?.reactivate(id)
    return true
  }

  /** Bound the daemon map: prune the OLDEST terminal daemons past `maxRetained`.
   *  Called at the END of public methods (never mid-iteration of `daemons`, so
   *  it can never invalidate `stopAll`'s loop).
   *  Running daemons are never pruned (their slot is live). Insertion order in
   *  the Map is oldest-first, so we evict the earliest terminal entries. */
  const pruneTerminal = (): void => {
    const terminal: string[] = []
    for (const d of daemons.values()) if (d.status !== "running") terminal.push(d.id)
    let over = terminal.length - maxRetained
    for (let i = 0; over > 0 && i < terminal.length; i++, over--) {
      daemons.delete(terminal[i] as string)
    }
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
    if (findingsLog.length > maxFindings) findingsLog.shift() // ring-buffer cap
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
    // Capability C — a pass is in flight ⇒ this daemon is NO LONGER idle.
    opts.idleBarrier?.reactivate(id)
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
    // Capability C — pass complete ⇒ idle again as of now (beacon the release ts).
    // Skipped once `finish` made it terminal (a stopped daemon is not a team
    // member; `applyPostPassBounds` may have just reaped it).
    applyPostPassBounds(d)
    if (d.status === "running") opts.idleBarrier?.beacon(id)
    pruneTerminal()
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
      validateSpec(spec, opts.events !== undefined)
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
      // Capability C — beacon the fresh-idle daemon BEFORE arming its trigger.
      // Ordering is load-bearing: an EVENT trigger whose source fires
      // SYNCHRONOUSLY during `subscribe` would otherwise run `wake` (which
      // `reactivate`s = clears the beacon) BEFORE this beacon line, leaving the
      // beacon set AFTER the daemon is already in flight — falsely reporting a
      // busy daemon as idle. Beacon-then-arm makes a synchronous first wake's
      // `reactivate` correctly clear the just-set beacon.
      opts.idleBarrier?.beacon(id)
      armTrigger(d)
      pruneTerminal()
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

    teamIdle(): boolean {
      // The members are the RUNNING daemons. No barrier wired ⇒ false (team-idle
      // is opt-in). Empty team ⇒ the barrier's own `teamIdle` returns false
      // (never report a vacuous team as done).
      return opts.idleBarrier?.teamIdle(runningIds()) ?? false
    },

    idleSince(): number | undefined {
      return opts.idleBarrier?.idleSince(runningIds())
    },
  }
}
