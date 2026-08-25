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
  readonly objectiveId: string
  readonly objectiveRevision: number
  readonly attachGeneration: number
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
  clearThread(threadId: string): void
  size(): number
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
  /** Optional dynamic delay derived from durable objective evidence. Undefined skips arming. */
  readonly resolveDelayMs?: ((current: ObjectiveDomainSnapshot) => number | undefined) | undefined
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
  /** Drop attempt claims for a detached live key before another thread replaces it. */
  clearAttempts(threadId: string): void
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

const wakeableRevision = (snapshot: ObjectiveDomainSnapshot | null): number | null => {
  const status = snapshot?.state?.objective.status
  if (
    snapshot === null ||
    snapshot.state === null ||
    (status !== "active" && status !== "usage_limited") ||
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
  if (wakeableRevision(input.current) === null) return skip("goal-not-active")
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
  if ((input.current.attachGeneration ?? 0) !== input.expected.attachGeneration) {
    return skip("revision-changed")
  }
  if (!input.stillQuiescent) return skip("no-longer-quiescent")
  return { arm: true }
}

const keyFor = (
  threadId: string,
  objectiveId: string,
  objectiveRevision: number,
  attachGeneration: number,
  checkpointOrdinal: number,
): string =>
  JSON.stringify([threadId, objectiveId, objectiveRevision, attachGeneration, checkpointOrdinal])

const makeAttempt = (
  input: GoalWakeArm,
  objectiveId: string,
  objectiveRevision: number,
  attachGeneration: number,
): GoalWakeAttempt => ({
  threadId: input.threadId,
  objectiveId,
  objectiveRevision,
  attachGeneration,
  checkpointOrdinal: input.checkpointOrdinal,
  attemptKey: keyFor(
    input.threadId,
    objectiveId,
    objectiveRevision,
    attachGeneration,
    input.checkpointOrdinal,
  ),
})

/**
 * A small, ephemeral registry for one host/session. It is not objective state
 * and deliberately has no persistence: a restart re-evaluates the authority
 * revision before it may enqueue. Hosts with multiple wake surfaces may inject
 * one shared registry instead.
 */
export const createInMemoryGoalWakeAttemptRegistry = (): GoalWakeAttemptRegistry => {
  const claims = new Map<
    string,
    { highestCommittedOrdinal: number; reservedOrdinals: Set<number> }
  >()
  const prefixFor = (threadId: string): string => `${threadId}\0`
  const clearThread = (threadId: string): void => {
    const prefix = prefixFor(threadId)
    for (const key of claims.keys()) if (key.startsWith(prefix)) claims.delete(key)
  }
  return {
    tryClaim: (attempt): GoalWakeAttemptReservation | null => {
      const key = `${attempt.threadId}\0${attempt.objectiveId}`
      for (const existing of claims.keys()) {
        if (existing.startsWith(prefixFor(attempt.threadId)) && existing !== key) {
          claims.delete(existing)
        }
      }
      const claim = claims.get(key) ?? {
        highestCommittedOrdinal: -1,
        reservedOrdinals: new Set<number>(),
      }
      claims.set(key, claim)
      if (
        attempt.checkpointOrdinal <= claim.highestCommittedOrdinal ||
        claim.reservedOrdinals.has(attempt.checkpointOrdinal)
      ) {
        return null
      }
      claim.reservedOrdinals.add(attempt.checkpointOrdinal)
      let settled = false
      return {
        commit: (): void => {
          if (settled) return
          settled = true
          claim.reservedOrdinals.delete(attempt.checkpointOrdinal)
          claim.highestCommittedOrdinal = Math.max(
            claim.highestCommittedOrdinal,
            attempt.checkpointOrdinal,
          )
        },
        release: (): void => {
          if (settled) return
          settled = true
          claim.reservedOrdinals.delete(attempt.checkpointOrdinal)
          if (claim.highestCommittedOrdinal < 0 && claim.reservedOrdinals.size === 0) {
            claims.delete(key)
          }
        },
      }
    },
    clearThread,
    size: () => claims.size,
  }
}

const readHostQuiescence = (deps: GoalWakeControllerDeps, threadId: string): boolean => {
  try {
    return deps.stillQuiescent(threadId) === true
  } catch (_error) {
    return false
  }
}

const dispatchClaimedAttempt = (
  deps: GoalWakeControllerDeps,
  attempt: GoalWakeAttempt,
  reservation: GoalWakeAttemptReservation,
): void => {
  try {
    Promise.resolve(deps.enqueue(attempt)).then(
      () => reservation.commit(),
      () => reservation.release(),
    )
  } catch (_error) {
    reservation.release()
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
    } catch (_error) {
      // Observability is not an authority and cannot destabilize scheduling.
    }
  }

  const clearPending = (): void => {
    if (pending === undefined) return
    const handle = pending
    pending = undefined
    try {
      deps.timer.clear(handle)
    } catch (_error) {
      // Generation fencing below still makes an uncleared callback inert.
    }
  }

  const readCurrent = (threadId: string): ObjectiveDomainSnapshot | null => {
    try {
      return deps.readDomain(threadId)
    } catch (_error) {
      return null
    }
  }

  const captureAttempt = (
    input: GoalWakeArm,
  ): { readonly attempt: GoalWakeAttempt; readonly delayMs: number } | undefined => {
    const current = readCurrent(input.threadId)
    const decision = evaluateGoalWakeArm({
      enabled: deps.enabled,
      stopped,
      threadId: input.threadId,
      checkpointOrdinal: input.checkpointOrdinal,
      current,
    })
    if (!decision.arm || current?.state === null || current === null) {
      if (current?.state === null || current === null) attempts.clearThread(input.threadId)
      return undefined
    }
    const revision = wakeableRevision(current)
    // `evaluateGoalWakeArm` proved this. Retaining this branch makes a future
    // change to that pure function fail safe rather than minting an invalid key.
    if (revision === null) return undefined
    const resolvedDelay = deps.resolveDelayMs?.(current) ?? delayMs
    if (!Number.isFinite(resolvedDelay) || resolvedDelay <= 0) return undefined
    return {
      attempt: makeAttempt(
        input,
        current.state.objective.objectiveId,
        revision,
        current.attachGeneration ?? 0,
      ),
      delayMs: resolvedDelay,
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
      stillQuiescent: readHostQuiescence(deps, attempt.threadId),
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
    dispatchClaimedAttempt(deps, attempt, reservation)
  }

  const scheduleAttempt = (
    attempt: GoalWakeAttempt,
    scheduleDelayMs: number,
  ): GoalWakeAttempt | undefined => {
    const callbackGeneration = ++generation
    try {
      const handle = deps.timer.set(() => fireAttempt(attempt, callbackGeneration), scheduleDelayMs)
      pending = handle
      if (typeof handle === "object" && handle !== null) handle.unref?.()
      return attempt
    } catch (_error) {
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
    const captured = captureAttempt(input)
    return captured === undefined ? undefined : scheduleAttempt(captured.attempt, captured.delayMs)
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
    clearAttempts: (threadId): void => attempts.clearThread(threadId),
    stop: (): void => {
      if (stopped) return
      stopped = true
      generation += 1
      clearPending()
    },
  }
}
