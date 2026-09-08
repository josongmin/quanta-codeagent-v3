/**
 * Parent-owned side-agent control plane: spec validation, trigger admission,
 * wake pump, and lifetime bounds. Both backers (in-process runner / OS-process
 * charter IPC) are `runPass` adapters — they do not own cadence or wake counts.
 */

import {
  SideAgentError,
  type SideAgentEventSourcePort,
  type SideAgentIdleBarrierPort,
  type SideAgentSpec,
  type SideAgentStatus,
} from "./types"

const isPositiveInt = (n: unknown): boolean =>
  typeof n === "number" && Number.isInteger(n) && n >= 1

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
  if (!hasEventSource) bad("event trigger requires an injected event source (opts.events)")
}

/** Reject a malformed spec BEFORE it is spawned. Shared by both backers. */
export const validateSideAgentSpec = (spec: SideAgentSpec, hasEventSource: boolean): void => {
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

export interface PassFinding {
  readonly summary: string
  readonly detail?: string
}

export type PassOutcome =
  | { readonly kind: "findings"; readonly findings: readonly PassFinding[] }
  | { readonly kind: "no_finding" }
  | { readonly kind: "failed"; readonly reason?: string }
  | { readonly kind: "cancelled"; readonly findings?: readonly PassFinding[] }

export type SideAgentRunPass = (args: {
  readonly wakeId: number
  readonly task: string
  readonly maxTurns: number
  readonly signal: AbortSignal
}) => Promise<PassOutcome>

/** Map a runner return (single finding, list, or null) onto a wake terminal. */
export const normalizeRunnerResult = (
  raw: PassFinding | readonly PassFinding[] | null,
): PassOutcome => {
  if (raw === null) return { kind: "no_finding" }
  if ("summary" in raw) return { kind: "findings", findings: [raw] }
  return raw.length === 0 ? { kind: "no_finding" } : { kind: "findings", findings: raw }
}

export interface DaemonEngineOpts {
  readonly id: string
  readonly spec: SideAgentSpec
  readonly now: () => number
  readonly setInterval: (handler: () => void, ms: number) => unknown
  readonly clearInterval: (handle: unknown) => void
  readonly events?: SideAgentEventSourcePort
  readonly idleBarrier?: SideAgentIdleBarrierPort
  readonly runPass: SideAgentRunPass
  readonly publish: (wakeIndex: number, finding: PassFinding) => void
  readonly finish: (status: SideAgentStatus) => void
  readonly prune?: () => void
  readonly isRunning: () => boolean
}

export interface DaemonEngine {
  readonly abort: AbortController
  readonly wakesDone: number
  readonly inFlight: boolean
  readonly lastFindingAt: number | undefined
  readonly generation: number
  arm(): void
  disarm(): void
  requestWake(): void
  onChildDeath(): void
}

interface EngineMut {
  wakesDone: number
  inFlight: boolean
  pending: boolean
  lastFindingAt: number | undefined
  generation: number
  startedAt: number
  timerHandle: unknown
  unsubscribe: (() => void) | undefined
}

const applyPostPassBounds = (opts: DaemonEngineOpts, mut: EngineMut): void => {
  if (!opts.isRunning()) return
  if (mut.wakesDone >= opts.spec.maxWakes) {
    opts.finish("stopped")
    return
  }
  if (opts.spec.idleReapMs === undefined) return
  const last = mut.lastFindingAt ?? mut.startedAt
  if (opts.now() - last >= opts.spec.idleReapMs) opts.finish("idle-reaped")
}

const publishOutcome = (
  opts: DaemonEngineOpts,
  mut: EngineMut,
  wakeId: number,
  o: PassOutcome,
): void => {
  if (o.kind !== "findings") return
  for (const f of o.findings) {
    opts.publish(wakeId, f)
    mut.lastFindingAt = opts.now()
  }
}

const continueAfterPass = (
  opts: DaemonEngineOpts,
  mut: EngineMut,
  abort: AbortController,
  wakeId: number,
  outcome: PassOutcome,
  enqueue: () => void,
): void => {
  if (outcome.kind === "cancelled") {
    publishOutcome(
      opts,
      mut,
      wakeId,
      outcome.findings !== undefined && outcome.findings.length > 0
        ? { kind: "findings", findings: outcome.findings }
        : { kind: "no_finding" },
    )
  }
  if (!opts.isRunning() || abort.signal.aborted) {
    opts.prune?.()
    return
  }
  if (outcome.kind === "cancelled") {
    opts.prune?.()
    if (opts.isRunning() && mut.pending) enqueue()
    return
  }
  mut.wakesDone += 1
  if (outcome.kind === "failed") {
    opts.finish("failed")
    return
  }
  publishOutcome(opts, mut, wakeId, outcome)
  applyPostPassBounds(opts, mut)
  if (opts.isRunning()) opts.idleBarrier?.beacon(opts.id)
  opts.prune?.()
  if (opts.isRunning() && mut.pending) enqueue()
}

export const createDaemonEngine = (opts: DaemonEngineOpts): DaemonEngine => {
  const abort = new AbortController()
  const mut: EngineMut = {
    wakesDone: 0,
    inFlight: false,
    pending: false,
    lastFindingAt: undefined,
    generation: 0,
    timerHandle: undefined,
    unsubscribe: undefined,
    startedAt: opts.now(),
  }

  const disarm = (): void => {
    abort.abort()
    if (mut.timerHandle !== undefined) opts.clearInterval(mut.timerHandle)
    mut.unsubscribe?.()
    mut.timerHandle = undefined
    mut.unsubscribe = undefined
    mut.inFlight = false
    mut.pending = false
    opts.idleBarrier?.reactivate(opts.id)
  }

  const runOne = async (): Promise<void> => {
    if (mut.inFlight || !opts.isRunning()) return
    if (mut.wakesDone >= opts.spec.maxWakes) {
      opts.finish("stopped")
      return
    }
    mut.inFlight = true
    mut.pending = false
    opts.idleBarrier?.reactivate(opts.id)
    const wakeId = mut.wakesDone + 1
    let outcome: PassOutcome
    try {
      outcome = await opts.runPass({
        wakeId,
        task: opts.spec.task,
        maxTurns: opts.spec.maxTurnsPerWake,
        signal: abort.signal,
      })
    } catch {
      mut.inFlight = false
      mut.wakesDone += 1
      opts.finish("failed")
      return
    }
    mut.inFlight = false
    continueAfterPass(opts, mut, abort, wakeId, outcome, () => {
      void runOne()
    })
  }

  const requestWake = (): void => {
    if (!opts.isRunning() || abort.signal.aborted) return
    if (mut.inFlight) {
      mut.pending = true
      return
    }
    void runOne()
  }

  return {
    abort,
    get wakesDone() {
      return mut.wakesDone
    },
    get inFlight() {
      return mut.inFlight
    },
    get lastFindingAt() {
      return mut.lastFindingAt
    },
    get generation() {
      return mut.generation
    },
    arm(): void {
      mut.startedAt = opts.now()
      opts.idleBarrier?.beacon(opts.id)
      const trig = opts.spec.trigger
      if (trig.kind === "interval") {
        mut.timerHandle = opts.setInterval(() => requestWake(), trig.everyMs)
        return
      }
      if (opts.events !== undefined) {
        mut.unsubscribe = opts.events.subscribe(trig.topic, () => requestWake())
      }
    },
    disarm,
    requestWake,
    onChildDeath(): void {
      mut.generation += 1
      mut.inFlight = false
      mut.pending = false
    },
  }
}
