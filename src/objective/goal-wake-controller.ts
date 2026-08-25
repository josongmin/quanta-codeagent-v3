/**
 * GOAL-06 — bounded, EVENT-DRIVEN goal wake controller (no interval polling).
 *
 * One owned timer per thread/objective. `arm`/`reset` capture an attempt from
 * the READ-PORT snapshot (eligibility fences from `goal-wake-policy`), derive
 * the typed delay from the attributed receipts (quiet / backoff / cooldown /
 * usage-limit) and schedule exactly one timer. When it fires the controller
 *   1. awaits the optional `reconcile` (source freshness) — a reconcile that
 *      moved the objective re-arms from the fresh state, an unavailable one
 *      re-arms in cooldown; neither leaves a stale reservation;
 *   2. rereads the objective and re-checks: same objective + revision, same
 *      activity epoch (raw user input since the arm drops the fire and never
 *      touches the user's draft), live quiescence (typed busy reason);
 *   3. reserves the attempt in the bounded claim registry (one entry per
 *      thread+objective, ≤1 reservation, committed only by an accepted
 *      enqueue) and hands it to `enqueue`.
 * Every decision is typed (`onDecision`) and the current state is readable
 * through `status()` so the renderer can say "wake: armed in 15s (quiet)".
 *
 * Slice fence: sibling modules only.
 */

import { errMessage, logger } from "@/shared"
import type { ReconcileOutcome } from "./criteria/ports"
import {
  clampGoalQuietMs,
  computeGoalWakeDelay,
  deriveWakeSignal,
  evaluateWakeEligibility,
  type GoalWakeDelayReason,
  type GoalWakeIneligibleReason,
} from "./goal-wake-policy"
import type { ObjectiveDomainSnapshot } from "./model"

// ── types ────────────────────────────────────────────────────────────────────

/** Why the surface is not quiescent (projected from LIVE stores by the host). */
export type GoalBusyReason =
  | "not-idle"
  | "turn-active"
  | "plan-mode"
  | "approval-pending"
  | "queued-input"
  | "mailbox-input"
  | "draft-pending"
  | "background-turn"
  | "session-switching"
  | "closing"
  | "ephemeral"

export type GoalQuiescence =
  | { readonly quiescent: true }
  | { readonly quiescent: false; readonly reason: GoalBusyReason }

export type GoalWakeSkipReason =
  | "disabled"
  | "stopped"
  | "invalid-thread"
  | GoalWakeIneligibleReason
  | "attempt-slot-blocked"
  | "authority-unavailable"
  | "revision-changed"
  | "objective-changed"
  | "activity-epoch-changed"
  | "no-longer-quiescent"
  | "reconcile-unavailable"
  | "attempt-already-claimed"

export interface GoalWakeAttempt {
  readonly threadId: string
  readonly objectiveId: string
  readonly objectiveRevision: number
  readonly checkpointOrdinal: number
  /** The controller-local activity epoch captured at arm time. */
  readonly activityEpoch: number
  readonly attemptKey: string
}

export interface GoalWakeAttemptReservation {
  commit(): void
  release(): void
}

/** Bounded claim registry: one entry per thread+objective holding the highest
 *  committed ordinal and at most one live reservation. */
export interface GoalWakeAttemptRegistry {
  tryClaim(attempt: GoalWakeAttempt): GoalWakeAttemptReservation | null
  /** Drop the thread's entry (clear / replace / attach / dispose). */
  forget(threadId: string): void
  size(): number
}

export interface GoalWakeTimer {
  set(fn: () => void, delayMs: number): GoalWakeTimerHandle
  clear(handle: GoalWakeTimerHandle): void
}

export type GoalWakeTimerHandle = { readonly unref?: () => void } | number

export interface GoalWakeArm {
  readonly threadId: string
  readonly checkpointOrdinal: number
}

export interface GoalWakeDecision {
  readonly arm: boolean
  readonly skipReason?: GoalWakeSkipReason
  readonly busyReason?: GoalBusyReason
}

export type GoalWakeDecisionEvent =
  | {
      readonly kind: "armed"
      readonly attemptKey: string
      readonly delayMs: number
      readonly reason: GoalWakeDelayReason
    }
  | {
      readonly kind: "skipped"
      readonly reason: GoalWakeSkipReason
      readonly busyReason?: GoalBusyReason
      readonly attemptKey?: string
    }
  | { readonly kind: "fired"; readonly attemptKey: string }
  | { readonly kind: "quiet-clamped"; readonly requestedMs: number; readonly quietMs: number }

export type GoalWakeStatus =
  | {
      readonly kind: "armed"
      readonly delayMs: number
      readonly reason: GoalWakeDelayReason
      readonly fireAt: number
    }
  | {
      readonly kind: "idle"
      readonly skipReason?: GoalWakeSkipReason
      readonly busyReason?: GoalBusyReason
    }
  | { readonly kind: "stopped" }

export interface GoalWakeFireInput {
  readonly enabled: boolean
  readonly stopped: boolean
  readonly expected: GoalWakeAttempt
  readonly current: ObjectiveDomainSnapshot | null
  readonly activityEpoch: number
  readonly quiescence: GoalQuiescence
}

export interface GoalWakeControllerDeps {
  readonly enabled: boolean
  /** Configured quiet window; clamped to the public minimum (one clamp event). */
  readonly baseQuietMs: number
  readonly timer: GoalWakeTimer
  readonly now?: (() => number) | undefined
  readonly readDomain: (threadId: string) => ObjectiveDomainSnapshot
  readonly quiescence: (threadId: string) => GoalQuiescence
  /** GOAL-04 — a fail-stopped attempt slot refuses further attributed turns. */
  readonly attemptSlotBlocked?: (() => boolean) | undefined
  /** A LOWER product cap (tests); never raises the product value. */
  readonly productCap?: number | undefined
  readonly attempts?: GoalWakeAttemptRegistry | undefined
  /** GOAL-03 — source-freshness reconcile awaited BEFORE the fire-time reread. */
  readonly reconcile?: ((threadId: string) => Promise<ReconcileOutcome>) | undefined
  readonly enqueue: (attempt: GoalWakeAttempt) => void | Promise<void>
  readonly onDecision?: ((event: GoalWakeDecisionEvent) => void) | undefined
}

export interface GoalWakeController {
  arm(input: GoalWakeArm): GoalWakeAttempt | undefined
  reset(input: GoalWakeArm): GoalWakeAttempt | undefined
  /** Raw user activity: bumps the epoch and drops any pending wake. */
  onActivity(): void
  cancel(): void
  stop(): void
  /** The last recorded decision (armed / idle+reason / stopped). */
  status(): GoalWakeStatus
  /** The LIVE decision: an armed timer as is, else the fences evaluated NOW
   *  (eligibility, attempt slot, quiescence) without scheduling anything. */
  explain(threadId: string): GoalWakeStatus
  activityEpoch(): number
}

// ── pure fences ──────────────────────────────────────────────────────────────

const skip = (reason: GoalWakeSkipReason, busyReason?: GoalBusyReason): GoalWakeDecision => ({
  arm: false,
  skipReason: reason,
  ...(busyReason !== undefined ? { busyReason } : {}),
})

const isValidThreadId = (threadId: string): boolean => threadId.length > 0
const isValidCheckpointOrdinal = (ordinal: number): boolean =>
  Number.isSafeInteger(ordinal) && ordinal >= 0

export const evaluateGoalWakeArm = (input: {
  readonly enabled: boolean
  readonly stopped: boolean
  readonly threadId: string
  readonly checkpointOrdinal: number
  readonly current: ObjectiveDomainSnapshot | null
  readonly productCap?: number | undefined
}): GoalWakeDecision => {
  if (!input.enabled) return skip("disabled")
  if (input.stopped) return skip("stopped")
  if (!isValidThreadId(input.threadId) || !isValidCheckpointOrdinal(input.checkpointOrdinal)) {
    return skip("invalid-thread")
  }
  const eligibility = evaluateWakeEligibility(input.current, input.productCap)
  if (!eligibility.eligible) return skip(eligibility.reason)
  return { arm: true }
}

export const evaluateGoalWakeFire = (input: GoalWakeFireInput): GoalWakeDecision => {
  if (!input.enabled) return skip("disabled")
  if (input.stopped) return skip("stopped")
  if (input.current === null || input.current.state === null) return skip("no-goal")
  const o = input.current.state.objective
  if (o.objectiveId !== input.expected.objectiveId) return skip("objective-changed")
  if (input.current.revision !== input.expected.objectiveRevision) return skip("revision-changed")
  if (o.status !== "active") return skip("goal-not-active")
  if (input.activityEpoch !== input.expected.activityEpoch) return skip("activity-epoch-changed")
  if (!input.quiescence.quiescent) return skip("no-longer-quiescent", input.quiescence.reason)
  return { arm: true }
}

// ── claim registry ───────────────────────────────────────────────────────────

const keyFor = (attempt: GoalWakeAttempt): string =>
  JSON.stringify([
    attempt.threadId,
    attempt.objectiveId,
    attempt.objectiveRevision,
    attempt.checkpointOrdinal,
  ])

interface RegistryEntry {
  objectiveId: string
  highestCommittedOrdinal: number
  reserved: { readonly attemptKey: string } | undefined
}

export const createInMemoryGoalWakeAttemptRegistry = (): GoalWakeAttemptRegistry => {
  const entries = new Map<string, RegistryEntry>()
  return {
    tryClaim: (attempt): GoalWakeAttemptReservation | null => {
      let entry = entries.get(attempt.threadId)
      if (entry === undefined || entry.objectiveId !== attempt.objectiveId) {
        entry = {
          objectiveId: attempt.objectiveId,
          highestCommittedOrdinal: -1,
          reserved: undefined,
        }
        entries.set(attempt.threadId, entry)
      }
      if (attempt.checkpointOrdinal <= entry.highestCommittedOrdinal) return null
      if (entry.reserved !== undefined) return null
      const claim = { attemptKey: attempt.attemptKey }
      entry.reserved = claim
      const live = entry
      let settled = false
      return {
        commit: (): void => {
          if (settled) return
          settled = true
          if (live.reserved === claim) live.reserved = undefined
          live.highestCommittedOrdinal = Math.max(
            live.highestCommittedOrdinal,
            attempt.checkpointOrdinal,
          )
        },
        release: (): void => {
          if (settled) return
          settled = true
          if (live.reserved === claim) live.reserved = undefined
        },
      }
    },
    forget: (threadId): void => {
      entries.delete(threadId)
    },
    size: (): number => entries.size,
  }
}

// ── controller ───────────────────────────────────────────────────────────────

interface WakeState {
  clampReported: boolean
  stopped: boolean
  generation: number
  epoch: number
  pending: GoalWakeTimerHandle | undefined
  status: GoalWakeStatus
}

interface WakeCtx {
  readonly deps: GoalWakeControllerDeps
  readonly attempts: GoalWakeAttemptRegistry
  readonly now: () => number
  readonly quiet: ReturnType<typeof clampGoalQuietMs>
  readonly s: WakeState
}

type Captured = {
  readonly attempt: GoalWakeAttempt
  readonly delayMs: number
  readonly reason: GoalWakeDelayReason
}
type DelayOverride = { readonly delayMs: number; readonly reason: GoalWakeDelayReason }

/** No-throw guards over the injected ports + the typed decision sink. */
const makeGuards = (ctx: WakeCtx) => {
  const { deps, s } = ctx
  const emit = (event: GoalWakeDecisionEvent): void => {
    try {
      deps.onDecision?.(event)
    } catch (e) {
      logger.warn(`goal-wake-controller.onDecision: ${errMessage(e)}`)
    }
  }
  const reportSkip = (decision: GoalWakeDecision, attemptKey?: string): void => {
    const reason = decision.skipReason ?? "authority-unavailable"
    const busy = decision.busyReason !== undefined ? { busyReason: decision.busyReason } : {}
    s.status = { kind: "idle", skipReason: reason, ...busy }
    emit({ kind: "skipped", reason, ...busy, ...(attemptKey !== undefined ? { attemptKey } : {}) })
  }
  const clearPending = (): void => {
    if (s.pending === undefined) return
    const handle = s.pending
    s.pending = undefined
    try {
      deps.timer.clear(handle)
    } catch (e) {
      logger.warn(`goal-wake-controller.clear: ${errMessage(e)}`)
    }
  }
  const readCurrent = (threadId: string): ObjectiveDomainSnapshot | null => {
    try {
      return deps.readDomain(threadId)
    } catch (e) {
      logger.warn(`goal-wake-controller.readDomain(${threadId}): ${errMessage(e)}`)
      return null
    }
  }
  const quiescenceOf = (threadId: string): GoalQuiescence => {
    try {
      return deps.quiescence(threadId)
    } catch (e) {
      logger.warn(`goal-wake-controller.quiescence(${threadId}): ${errMessage(e)}`)
      return { quiescent: false, reason: "not-idle" }
    }
  }
  const slotBlocked = (): boolean => {
    try {
      return deps.attemptSlotBlocked?.() === true
    } catch {
      return true
    }
  }
  return { emit, reportSkip, clearPending, readCurrent, quiescenceOf, slotBlocked }
}
type Guards = ReturnType<typeof makeGuards>

/** Arm-time fences (eligibility → attempt slot → quiescence) as a typed status. */
const explainNow = (ctx: WakeCtx, g: Guards, threadId: string): GoalWakeStatus => {
  const { deps, s } = ctx
  const decision = evaluateGoalWakeArm({
    enabled: deps.enabled,
    stopped: s.stopped,
    threadId,
    checkpointOrdinal: 0,
    current: g.readCurrent(threadId),
    productCap: deps.productCap,
  })
  if (!decision.arm) {
    return { kind: "idle", skipReason: decision.skipReason ?? "authority-unavailable" }
  }
  if (g.slotBlocked()) return { kind: "idle", skipReason: "attempt-slot-blocked" }
  const quiescence = g.quiescenceOf(threadId)
  if (!quiescence.quiescent) {
    return { kind: "idle", skipReason: "no-longer-quiescent", busyReason: quiescence.reason }
  }
  return { kind: "idle" }
}

/** Arm path: capture (fences + typed delay) and schedule the one owned timer. */
const makeArmPath = (
  ctx: WakeCtx,
  g: Guards,
  fireRef: { current: (attempt: GoalWakeAttempt, generation: number) => Promise<void> },
) => {
  const { deps, s, now, quiet } = ctx
  const captureAttempt = (input: GoalWakeArm, override?: DelayOverride): Captured | undefined => {
    const current = g.readCurrent(input.threadId)
    const decision = evaluateGoalWakeArm({
      enabled: deps.enabled,
      stopped: s.stopped,
      threadId: input.threadId,
      checkpointOrdinal: input.checkpointOrdinal,
      current,
      productCap: deps.productCap,
    })
    if (!decision.arm || current === null || current.state === null) {
      g.reportSkip(decision)
      return undefined
    }
    if (g.slotBlocked()) {
      g.reportSkip(skip("attempt-slot-blocked"))
      return undefined
    }
    const quiescence = g.quiescenceOf(input.threadId)
    if (!quiescence.quiescent) {
      g.reportSkip(skip("no-longer-quiescent", quiescence.reason))
      return undefined
    }
    const bare: GoalWakeAttempt = {
      threadId: input.threadId,
      objectiveId: current.state.objective.objectiveId,
      objectiveRevision: current.revision,
      checkpointOrdinal: input.checkpointOrdinal,
      activityEpoch: s.epoch,
      attemptKey: "",
    }
    const derived =
      override ??
      computeGoalWakeDelay({
        baseQuietMs: quiet.quietMs,
        ...deriveWakeSignal(current.progressReceipts),
        usageLimitedUntil: current.state.usageLimitedUntil,
        now: now(),
      })
    return { attempt: { ...bare, attemptKey: keyFor(bare) }, ...derived }
  }
  const scheduleAttempt = (captured: Captured): GoalWakeAttempt | undefined => {
    const callbackGeneration = ++s.generation
    try {
      const handle = deps.timer.set(
        () => void fireRef.current(captured.attempt, callbackGeneration),
        captured.delayMs,
      )
      s.pending = handle
      if (typeof handle === "object" && handle !== null) handle.unref?.()
    } catch (e) {
      logger.warn(`goal-wake-controller.timer.set: ${errMessage(e)}`)
      return undefined
    }
    s.status = {
      kind: "armed",
      delayMs: captured.delayMs,
      reason: captured.reason,
      fireAt: now() + captured.delayMs,
    }
    g.emit({
      kind: "armed",
      attemptKey: captured.attempt.attemptKey,
      delayMs: captured.delayMs,
      reason: captured.reason,
    })
    return captured.attempt
  }
  /** Re-arm from the FRESH state after a fire-time skip (never a hot loop:
   *  a cooldown override applies when the source could not be reconciled). */
  const rearm = (attempt: GoalWakeAttempt, override?: DelayOverride): void => {
    if (s.stopped) return
    const captured = captureAttempt(
      { threadId: attempt.threadId, checkpointOrdinal: attempt.checkpointOrdinal + 1 },
      override,
    )
    if (captured !== undefined) scheduleAttempt(captured)
  }
  const armInternal = (input: GoalWakeArm, replace: boolean): GoalWakeAttempt | undefined => {
    if (!deps.enabled) {
      s.status = { kind: "idle", skipReason: "disabled" }
      return undefined // default-OFF never reads a port
    }
    if (s.stopped) return undefined
    if (s.pending !== undefined && !replace) return undefined
    if (quiet.clamped && !s.clampReported) {
      s.clampReported = true
      g.emit({ kind: "quiet-clamped", requestedMs: deps.baseQuietMs, quietMs: quiet.quietMs })
    }
    if (replace) {
      s.generation += 1
      g.clearPending()
    }
    const captured = captureAttempt(input)
    return captured === undefined ? undefined : scheduleAttempt(captured)
  }
  return { rearm, armInternal }
}

/** Fire path: reconcile → reread fences → bounded claim → enqueue. */
const makeFirePath = (ctx: WakeCtx, g: Guards, arm: ReturnType<typeof makeArmPath>) => {
  const { deps, s, now, quiet, attempts } = ctx
  const dispatchClaimed = (
    attempt: GoalWakeAttempt,
    reservation: GoalWakeAttemptReservation,
  ): void => {
    try {
      Promise.resolve(deps.enqueue(attempt)).then(
        () => reservation.commit(),
        () => reservation.release(),
      )
    } catch {
      reservation.release()
    }
  }
  const reconcileFirst = async (attempt: GoalWakeAttempt): Promise<"proceed" | "cooldown"> => {
    if (deps.reconcile === undefined) return "proceed"
    try {
      const outcome = await deps.reconcile(attempt.threadId)
      return outcome.kind === "fresh" ||
        outcome.kind === "invalidated" ||
        outcome.kind === "no-objective"
        ? "proceed"
        : "cooldown"
    } catch (e) {
      logger.warn(`goal-wake-controller.reconcile(${attempt.threadId}): ${errMessage(e)}`)
      return "cooldown"
    }
  }
  /** A stale callback (generation moved on) is dropped; when raw input moved
   *  the epoch since the arm, say so (typed) instead of vanishing. */
  const staleCallback = (attempt: GoalWakeAttempt, callbackGeneration: number): boolean => {
    if (s.stopped) return true
    if (callbackGeneration === s.generation) return false
    if (attempt.activityEpoch !== s.epoch) {
      g.reportSkip(skip("activity-epoch-changed"), attempt.attemptKey)
    }
    return true
  }
  const cooldownAfterReconcile = (attempt: GoalWakeAttempt): void => {
    g.reportSkip(skip("reconcile-unavailable"), attempt.attemptKey)
    const cooldown = computeGoalWakeDelay({
      baseQuietMs: quiet.quietMs,
      signal: "failure",
      streak: Math.max(
        1,
        deriveWakeSignal(g.readCurrent(attempt.threadId)?.progressReceipts).streak,
      ),
      now: now(),
    })
    arm.rearm(attempt, { delayMs: cooldown.delayMs, reason: "cooldown" })
  }
  const fireAfterReconcile = (attempt: GoalWakeAttempt): void => {
    const fire = evaluateGoalWakeFire({
      enabled: deps.enabled,
      stopped: s.stopped,
      expected: attempt,
      current: g.readCurrent(attempt.threadId),
      activityEpoch: s.epoch,
      quiescence: g.quiescenceOf(attempt.threadId),
    })
    if (!fire.arm) {
      g.reportSkip(fire, attempt.attemptKey)
      // A reconcile that moved the objective (revision changed) re-arms from
      // the fresh state; raw input or a busy surface waits for its own edge.
      if (fire.skipReason === "revision-changed" && deps.reconcile !== undefined) arm.rearm(attempt)
      return
    }
    const reservation = attempts.tryClaim(attempt)
    if (reservation === null) {
      g.reportSkip(skip("attempt-already-claimed"), attempt.attemptKey)
      return
    }
    s.status = { kind: "idle" }
    g.emit({ kind: "fired", attemptKey: attempt.attemptKey })
    dispatchClaimed(attempt, reservation)
  }
  const fireAttempt = async (
    attempt: GoalWakeAttempt,
    callbackGeneration: number,
  ): Promise<void> => {
    if (staleCallback(attempt, callbackGeneration)) return
    s.pending = undefined
    const reconciled = await reconcileFirst(attempt)
    if (staleCallback(attempt, callbackGeneration)) return
    if (reconciled === "cooldown") {
      cooldownAfterReconcile(attempt)
      return
    }
    fireAfterReconcile(attempt)
  }
  return { fireAttempt }
}

export const createGoalWakeController = (deps: GoalWakeControllerDeps): GoalWakeController => {
  const ctx: WakeCtx = {
    deps,
    attempts: deps.attempts ?? createInMemoryGoalWakeAttemptRegistry(),
    now: deps.now ?? Date.now,
    quiet: clampGoalQuietMs(deps.baseQuietMs),
    s: {
      clampReported: false,
      stopped: false,
      generation: 0,
      epoch: 0,
      pending: undefined,
      status: { kind: "idle" },
    },
  }
  const { s } = ctx
  const g = makeGuards(ctx)
  const fireRef = { current: async (_a: GoalWakeAttempt, _g: number): Promise<void> => {} }
  const arm = makeArmPath(ctx, g, fireRef)
  fireRef.current = makeFirePath(ctx, g, arm).fireAttempt
  const dropPending = (): void => {
    s.generation += 1
    g.clearPending()
    if (s.status.kind === "armed") s.status = { kind: "idle" }
  }
  return {
    arm: (input): GoalWakeAttempt | undefined => arm.armInternal(input, false),
    reset: (input): GoalWakeAttempt | undefined => arm.armInternal(input, true),
    onActivity: (): void => {
      s.epoch += 1
      dropPending()
    },
    cancel: dropPending,
    stop: (): void => {
      if (s.stopped) return
      s.stopped = true
      s.generation += 1
      g.clearPending()
      s.status = { kind: "stopped" }
    },
    status: (): GoalWakeStatus => s.status,
    explain: (threadId): GoalWakeStatus => {
      if (s.stopped) return { kind: "stopped" }
      if (s.status.kind === "armed" && s.pending !== undefined) return s.status
      if (!deps.enabled) return { kind: "idle", skipReason: "disabled" }
      return explainNow(ctx, g, threadId)
    },
    activityEpoch: (): number => s.epoch,
  }
}
