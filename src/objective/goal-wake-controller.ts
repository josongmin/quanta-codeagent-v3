/**
 * Edge-triggered, per-session controller for a goal continuation wake.
 *
 * This is deliberately NOT another objective store or continuation policy.
 * The ObjectiveAuthority remains the source of truth for a goal and its
 * revision. A host calls `arm` when a qualifying edge occurs (goal change,
 * turn settlement, or a quiet transition), calls `reset` for fresh activity,
 * and calls `cancel`/`stop` on lifecycle changes. At most one quiet-window
 * timer exists for a controller at a time.
 *
 * At timer fire, the controller re-reads the authority snapshot, checks the
 * exact revision captured at arm time, re-checks the host's quiescence probe,
 * then atomically claims the attempt before asking the host to enqueue. This
 * makes a queued callback after cancel harmless and prevents stale or duplicate
 * continuation enqueue without making this module an owner of objective state.
 *
 * SLICE FENCE: imports only an objective sibling type. Session activity,
 * queues, clocks and the actual enqueue path are injected by the host.
 */

import { errMessage, logger } from "@/shared"
import type { ObjectiveDomainSnapshot } from "./model"

export type GoalWakeSkipReason =
  | "disabled"
  | "stopped"
  | "invalid-thread"
  | "no-goal"
  | "goal-not-active"
  | "authority-unavailable"
  | "revision-changed"
  | "no-longer-quiescent"
  | "attempt-already-claimed"

export interface GoalWakeAttempt {
  readonly threadId: string
  readonly objectiveRevision: number
  /** A host-owned checkpoint counter; it changes whenever a new pursuit step
   * is eligible under the same objective revision. */
  readonly checkpointOrdinal: number
  /** Collision-free stable encoding of the three fields above. */
  readonly attemptKey: string
}

/** A reservation prevents two controllers from enqueueing the same attempt.
 * `commit` makes the reservation durable for the registry lifetime; `release`
 * permits a retry when the enqueue sink reports failure. Both are idempotent. */
export interface GoalWakeAttemptReservation {
  commit(): void
  release(): void
}

export interface GoalWakeAttemptRegistry {
  tryClaim(attempt: GoalWakeAttempt): GoalWakeAttemptReservation | null
}

export interface GoalWakeTimer {
  set(fn: () => void, delayMs: number): GoalWakeTimerHandle
  clear(handle: GoalWakeTimerHandle): void
}

/** Kept opaque so browser, Bun, Node and deterministic tests can bind it. */
export type GoalWakeTimerHandle = { readonly unref?: () => void } | number

export interface GoalWakeArm {
  readonly threadId: string
  readonly checkpointOrdinal: number
}

export interface GoalWakeDecision {
  readonly arm: boolean
  readonly skipReason?: GoalWakeSkipReason
}

export interface GoalWakeFireInput {
  readonly enabled: boolean
  readonly stopped: boolean
  readonly expected: GoalWakeAttempt
  readonly current: ObjectiveDomainSnapshot | null
  readonly stillQuiescent: boolean
}

export interface GoalWakeControllerDeps {
  /** Default-OFF gate. When false, `arm` reads no authority state and arms no timer. */
  readonly enabled: boolean
  /** Positive finite duration of a quiet period before a wake is considered. */
  readonly quietWindowMs: number
  readonly timer: GoalWakeTimer
  /** Read-only authority projection. It must be the same owner used by /goal. */
  readonly readDomain: (threadId: string) => ObjectiveDomainSnapshot
  /** Re-read at fire time to close input/turn/queue races. Throwing blocks wake. */
  readonly stillQuiescent: (threadId: string) => boolean
  /** Usually session-local; a shared implementation also deduplicates surfaces. */
  readonly attempts?: GoalWakeAttemptRegistry | undefined
  /** The real host enqueue/wake sink. A resolved result means enqueue accepted. */
  readonly enqueue: (attempt: GoalWakeAttempt) => void | Promise<void>
  /** Optional observability seam. It must not throw out of the controller. */
  readonly onSkip?: ((attempt: GoalWakeAttempt, reason: GoalWakeSkipReason) => void) | undefined
}

export interface GoalWakeController {
  /** Arm only when no timer is pending; returns the captured attempt if armed. */
  arm(input: GoalWakeArm): GoalWakeAttempt | undefined
  /** Cancel any pending timer and begin a fresh quiet window. */
  reset(input: GoalWakeArm): GoalWakeAttempt | undefined
  /** Record foreground/external activity. The host re-arms only after a later
   * settled/quiescent edge, so activity can never cause an autonomous wake. */
  onActivity(): void
  /** Cancel a pending timer; an already accepted enqueue is intentionally not revoked. */
  cancel(): void
  /** Permanent lifecycle stop. Idempotent; queued timer callbacks become no-ops. */
  stop(): void
}

const skip = (reason: GoalWakeSkipReason): GoalWakeDecision => ({ arm: false, skipReason: reason })

const isValidThreadId = (threadId: string): boolean => threadId.length > 0

const isValidCheckpointOrdinal = (ordinal: number): boolean =>
  Number.isSafeInteger(ordinal) && ordinal >= 0

const activeRevision = (snapshot: ObjectiveDomainSnapshot | null): number | null => {
  if (
    snapshot === null ||
    snapshot.state === null ||
    snapshot.state.objective.status !== "active" ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0
  ) {
    return null
  }
  return snapshot.revision
}

/** Pure arm decision. It deliberately has no timer, authority or host probes. */
export const evaluateGoalWakeArm = (input: {
  readonly enabled: boolean
  readonly stopped: boolean
  readonly threadId: string
  readonly checkpointOrdinal: number
  readonly current: ObjectiveDomainSnapshot | null
}): GoalWakeDecision => {
  if (!input.enabled) return skip("disabled")
  if (input.stopped) return skip("stopped")
  if (!isValidThreadId(input.threadId) || !isValidCheckpointOrdinal(input.checkpointOrdinal)) {
    return skip("invalid-thread")
  }
  if (input.current === null || input.current.state === null) return skip("no-goal")
  if (activeRevision(input.current) === null) return skip("goal-not-active")
  return { arm: true }
}

/** Pure fire-time fence. The controller claims only after this returns `arm:true`. */
export const evaluateGoalWakeFire = (input: GoalWakeFireInput): GoalWakeDecision => {
  if (!input.enabled) return skip("disabled")
  if (input.stopped) return skip("stopped")
  if (input.current === null || input.current.state === null) return skip("no-goal")
  const revision = activeRevision(input.current)
  if (revision === null) return skip("goal-not-active")
  if (revision !== input.expected.objectiveRevision) return skip("revision-changed")
  if (!input.stillQuiescent) return skip("no-longer-quiescent")
  return { arm: true }
}

const keyFor = (threadId: string, objectiveRevision: number, checkpointOrdinal: number): string =>
  JSON.stringify([threadId, objectiveRevision, checkpointOrdinal])

const makeAttempt = (input: GoalWakeArm, objectiveRevision: number): GoalWakeAttempt => ({
  threadId: input.threadId,
  objectiveRevision,
  checkpointOrdinal: input.checkpointOrdinal,
  attemptKey: keyFor(input.threadId, objectiveRevision, input.checkpointOrdinal),
})

/**
 * A small, ephemeral registry for one host/session. It is not objective state
 * and deliberately has no persistence: a restart re-evaluates the authority
 * revision before it may enqueue. Hosts with multiple wake surfaces may inject
 * one shared registry instead.
 */
export const createInMemoryGoalWakeAttemptRegistry = (): GoalWakeAttemptRegistry => {
  const claims = new Map<string, { committed: boolean }>()
  return {
    tryClaim: (attempt): GoalWakeAttemptReservation | null => {
      if (claims.has(attempt.attemptKey)) return null
      const claim = { committed: false }
      claims.set(attempt.attemptKey, claim)
      let settled = false
      return {
        commit: (): void => {
          if (settled) return
          settled = true
          claim.committed = true
        },
        release: (): void => {
          if (settled) return
          settled = true
          // A stale release must never erase a newer claimant for the same key.
          if (claims.get(attempt.attemptKey) === claim) claims.delete(attempt.attemptKey)
        },
      }
    },
  }
}

/**
 * Build a single-timer controller. The constructor is intentionally effect-free:
 * nothing is read or scheduled until `arm`/`reset` is called.
 */
export const createGoalWakeController = (deps: GoalWakeControllerDeps): GoalWakeController => {
  const attempts = deps.attempts ?? createInMemoryGoalWakeAttemptRegistry()
  const delayMs =
    Number.isFinite(deps.quietWindowMs) && deps.quietWindowMs > 0 ? deps.quietWindowMs : 1
  let stopped = false
  let generation = 0
  let pending: GoalWakeTimerHandle | undefined

  const reportSkip = (attempt: GoalWakeAttempt, reason: GoalWakeSkipReason): void => {
    try {
      deps.onSkip?.(attempt, reason)
    } catch {
      // Observability is not an authority and cannot destabilize scheduling.
    }
  }

  const clearPending = (): void => {
    if (pending === undefined) return
    const handle = pending
    pending = undefined
    try {
      deps.timer.clear(handle)
    } catch {
      // Generation fencing below still makes an uncleared callback inert.
    }
  }

  const readCurrent = (threadId: string): ObjectiveDomainSnapshot | null => {
    try {
      return deps.readDomain(threadId)
    } catch {
      return null
    }
  }

  const captureAttempt = (input: GoalWakeArm): GoalWakeAttempt | undefined => {
    const current = readCurrent(input.threadId)
    const decision = evaluateGoalWakeArm({
      enabled: deps.enabled,
      stopped,
      threadId: input.threadId,
      checkpointOrdinal: input.checkpointOrdinal,
      current,
    })
    if (!decision.arm) return undefined
    const revision = activeRevision(current)
    // `evaluateGoalWakeArm` proved this. Retaining this branch makes a future
    // change to that pure function fail safe rather than minting an invalid key.
    if (revision === null) return undefined
    return makeAttempt(input, revision)
  }

  const quiescentAtFire = (threadId: string): boolean => {
    try {
      return deps.stillQuiescent(threadId) === true
    } catch (e) {
      // `false` (= not quiescent = do not fire) stays the fail-SAFE answer. But a
      // probe that throws every time silently means the wake never fires again,
      // which is indistinguishable from a thread that is simply always busy.
      logger.warn(`goal-wake-controller.quiescentAtFire(${threadId}): ${errMessage(e)}`)
      return false
    }
  }

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

  const fireAttempt = (attempt: GoalWakeAttempt, callbackGeneration: number): void => {
    if (callbackGeneration !== generation || stopped) return
    pending = undefined
    const fire = evaluateGoalWakeFire({
      enabled: deps.enabled,
      stopped,
      expected: attempt,
      current: readCurrent(attempt.threadId),
      stillQuiescent: quiescentAtFire(attempt.threadId),
    })
    if (!fire.arm) {
      if (fire.skipReason !== undefined) reportSkip(attempt, fire.skipReason)
      return
    }
    const reservation = attempts.tryClaim(attempt)
    if (reservation === null) {
      reportSkip(attempt, "attempt-already-claimed")
      return
    }
    dispatchClaimed(attempt, reservation)
  }

  const scheduleAttempt = (attempt: GoalWakeAttempt): GoalWakeAttempt | undefined => {
    const callbackGeneration = ++generation
    try {
      const handle = deps.timer.set(() => fireAttempt(attempt, callbackGeneration), delayMs)
      pending = handle
      if (typeof handle === "object" && handle !== null) handle.unref?.()
      return attempt
    } catch {
      return undefined
    }
  }

  const armInternal = (input: GoalWakeArm, replace: boolean): GoalWakeAttempt | undefined => {
    if (!deps.enabled || stopped) return undefined // default-OFF never reads a port
    if (pending !== undefined && !replace) return undefined
    if (replace) {
      generation += 1
      clearPending()
    }
    const attempt = captureAttempt(input)
    return attempt === undefined ? undefined : scheduleAttempt(attempt)
  }

  return {
    arm: (input): GoalWakeAttempt | undefined => armInternal(input, false),
    reset: (input): GoalWakeAttempt | undefined => armInternal(input, true),
    onActivity: (): void => {
      generation += 1
      clearPending()
    },
    cancel: (): void => {
      generation += 1
      clearPending()
    },
    stop: (): void => {
      if (stopped) return
      stopped = true
      generation += 1
      clearPending()
    },
  }
}
