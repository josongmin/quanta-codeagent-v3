/**
 * Goal-continuation wake controller — the LIVE host binding that activates the
 * previously-DEAD `@/objective` continuation machine (H17, absorbed from
 * Codex `core/src/goals.rs`).
 *
 * Codex's "Pursuing goal" behaviour: once an `active` goal is set, the agent
 * keeps resuming work on it turn after turn — whenever the thread goes idle and
 * no other work is pending — until the goal is `completed`, `blocked`, or a
 * budget/usage limit trips. The pure decision + semaphore already live in
 * `@/objective` (`runIdleContinuation`); they were just never driven by a
 * real host lifecycle. This module is that edge-triggered driver.
 *
 * The composition roots enable this by default; `QUANTA_GOAL=0` is the public
 * opt-out. `enabled: false`, a missing thread id, or a thread without an active
 * objective makes {@link startGoalWakeController} inert, so default-on does not
 * create autonomous work before the operator creates a goal.
 *
 * SLICE FENCE: imports ONLY the closed `@/objective` barrel
 * (`runIdleContinuation`, `ContinuationSemaphore`, and the `ContinuationDeps`
 * probe/`resume` shape). No `@/agent` core, no reactor internals.
 */

import { logger } from "@/shared"
import type { ObjectiveAttemptSlotStatus } from "./attempt"
import type { SystemObjectiveCommands } from "./capabilities"
import { type ContinuationDeps, ContinuationSemaphore, runIdleContinuation } from "./continuation"
import { createGoalWakeController, type GoalWakeAttempt } from "./goal-wake-controller"
import {
  computeGoalWakeDelay,
  DEFAULT_GOAL_WAKE_POLICY,
  type GoalWakeDelaySkip,
  type GoalWakePolicy,
  type GoalWakeSettlementHint,
  safePolicy,
} from "./goal-wake-policy"
import type { ObjectiveDomainSnapshot } from "./model"

/** The host-bound probes + resume sink (everything in `ContinuationDeps` except
 *  the pieces this driver owns: `enabled`, `semaphore`, `now`). */
export type GoalContinuationProbes = Omit<ContinuationDeps, "enabled" | "semaphore" | "now">

/**
 * Event-facing lifecycle for the edge-triggered controller. The interactive
 * host relays only real events (goal mutation, local activity, turn
 * settlement); this object owns neither objective state nor queue state.
 */
export interface GoalWakeLifecycle {
  onGoalMutation(): void
  onInfrastructureUnavailable(objectiveRevision: number, observedAt: number): void
  onAttach(threadId: string): void
  onActivity(): void
  onLocalInputSettled(): void
  onTurnSettled(): void
  stop(): void
  /** GOAL-06 rail 11 — the controller's raw-input epoch (carried on every attempt). */
  activityEpoch(): number
  /** GOAL-06 — the typed scheduling decision the `/goal` report renders. */
  status(): GoalWakeStatus
}

/** The wake decision as the surface renders it: never a predicted status —
 *  an armed timer with its delay, or WHY nothing is armed, or stopped. */
export type GoalWakeStatus =
  | { readonly kind: "armed"; readonly delayMs: number }
  /** No timer right now (raw input cancelled it) but the policy and the host
   *  are ready: the next settled edge arms `delayMs`. */
  | { readonly kind: "pending"; readonly delayMs: number }
  | {
      readonly kind: "idle"
      readonly skipReason: GoalWakeDelaySkip | "not-quiescent" | "attempt-slot-fail-stopped"
      /** Operator-facing detail (the fail-stop reason). */
      readonly detail?: string | undefined
    }
  | { readonly kind: "stopped" }

export interface StartGoalWakeOpts {
  readonly enabled: boolean
  readonly threadId: string | undefined
  /** GOAL-04/08 — the surface's attributed-attempt slot status. A FAIL-STOPPED
   *  slot (terminal persistence failure after a paid call) is terminal until a
   *  new objective generation: the controller must not arm (a fire would only
   *  be refused at claim time, forever, every quiet window) and `/goal` shows
   *  the reason. Absent ⇒ the surface has no slot ⇒ no gate. */
  readonly attemptSlotStatus?: (() => ObjectiveAttemptSlotStatus) | undefined
  readonly probes: GoalContinuationProbes
  /** Revisioned projection from the same authority `/goal` mutates. */
  readonly readDomain: (threadId: string) => ObjectiveDomainSnapshot
  /** GOAL-06 — retained for callers; the product cap is POLICY (never written
   *  into the user budget), so the host issues no system mutation any more. */
  readonly system?: SystemObjectiveCommands | undefined
  /** Goal-specific quiescence duration, independent of UI presence handling. */
  readonly quietWindowMs: number
  readonly policy?: GoalWakePolicy | undefined
  readonly now?: (() => number) | undefined
  /** Full host projection, checked before arm. Fire-time checks are repeated
   * through `probes`, closing races after the timer is scheduled. */
  readonly isQuiescent?: (() => boolean) | undefined
  /** GOAL-06 rail 7 — receives ONE bounded warning when the configured quiet
   *  window is below the public 15 s minimum (default: `logger.warn`). */
  readonly onClampWarning?: ((message: string) => void) | undefined
  /** Optional typed queue hand-off. The CLI uses this to retain the captured
   * revision through dequeue; legacy hosts may keep the plain resume sink. */
  readonly resumeAttempt?: (threadId: string, attempt: GoalWakeAttempt) => Promise<void>
  readonly setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void
}

/** Goal pursuit's own quiet period. It is intentionally independent of the
 * UI idle-suppression window (`QUANTA_IDLE_MS`). */
export const DEFAULT_GOAL_QUIET_MS = 15_000

/** GOAL-08 round 3 — a FAIL-STOPPED attempt slot (terminal persistence
 *  failure after a paid call) is terminal until a new objective generation:
 *  the wake must not arm (a fire would only be refused at claim time, every
 *  quiet window, forever) and the status line carries the reason. */
const readFailStoppedSlot = (
  read: (() => ObjectiveAttemptSlotStatus) | undefined,
): { readonly reason: string } | undefined => {
  try {
    const status = read?.()
    return status?.kind === "fail-stopped" ? { reason: status.reason } : undefined
  } catch (_error) {
    return undefined
  }
}

const failStoppedStatus = (
  read: (() => ObjectiveAttemptSlotStatus) | undefined,
): GoalWakeStatus | undefined => {
  const stopped = readFailStoppedSlot(read)
  return stopped === undefined
    ? undefined
    : { kind: "idle", skipReason: "attempt-slot-fail-stopped", detail: stopped.reason }
}

/**
 * Build the event-driven goal wake controller. One timer is
 * armed from concrete goal/turn edges, then revision + quiescence are checked
 * again immediately before the existing continuation orchestrator enqueues.
 */
export const startGoalWakeController = (opts: StartGoalWakeOpts): GoalWakeLifecycle | undefined => {
  const initialThreadId = opts.threadId
  if (!opts.enabled || initialThreadId === undefined || initialThreadId.length === 0)
    return undefined
  let threadId = initialThreadId

  const now = opts.now ?? Date.now
  const requested: GoalWakePolicy = opts.policy ?? {
    ...DEFAULT_GOAL_WAKE_POLICY,
    minQuietMs: opts.quietWindowMs,
  }
  // GOAL-06 — the product cap is a POLICY value the controller and the
  // authority check against `autonomousTurnsStarted`; it is never written into
  // the user's `budget.maxTurns` (that would let a user budget override it).
  const policy = safePolicy(requested)
  if (policy.minQuietMs !== Math.floor(requested.minQuietMs)) {
    const warn = opts.onClampWarning ?? ((message: string) => logger.warn(message))
    warn(
      `goal-wake: QUANTA_GOAL_QUIET_MS=${requested.minQuietMs} is below the public minimum; using ${policy.minQuietMs}ms`,
    )
  }
  const continuationDeps: ContinuationDeps = {
    ...opts.probes,
    enabled: true,
    semaphore: new ContinuationSemaphore(),
    now,
  }
  const setFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
  const clearFn = opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle))
  let checkpointOrdinal = 0
  let settlementHint: GoalWakeSettlementHint = {}

  const controller = createGoalWakeController({
    enabled: true,
    quietWindowMs: policy.minQuietMs,
    resolveDelayMs: (domain) => {
      if (readFailStoppedSlot(opts.attemptSlotStatus) !== undefined) return undefined // binding
      const decision = computeGoalWakeDelay(domain, policy, settlementHint, now())
      if ("delayMs" in decision) return decision.delayMs
      return decision.retryAt === undefined ? undefined : Math.max(1, decision.retryAt - now())
    },
    timer: {
      set: (fn, ms) => setFn(fn, ms),
      clear: (handle) => clearFn(handle as ReturnType<typeof setTimeout>),
    },
    readDomain: opts.readDomain,
    // The controller rechecks the SAME host guards before claiming an attempt;
    // runIdleContinuation repeats them at enqueue time to close the last race.
    stillQuiescent: (id) =>
      continuationDeps.threadIdle(id) &&
      !continuationDeps.planModeActive(id) &&
      !continuationDeps.turnActive(id) &&
      !continuationDeps.queuedInputPending(id) &&
      !continuationDeps.mailboxInputPending(id) &&
      !continuationDeps.isEphemeral(id),
    enqueue: async (attempt) => {
      const guardedDeps: ContinuationDeps = {
        ...continuationDeps,
        resume: async (id) => {
          // `runIdleContinuation` rechecks goal status. This additional exact
          // revision fence closes active→active edits between timer fire and
          // queue hand-off; the CLI keeps the same metadata to recheck at
          // dequeue immediately before the agent body starts.
          const current = opts.readDomain(id)
          if (
            current.state === null ||
            current.state.objective.status !== "active" ||
            current.revision !== attempt.objectiveRevision
          ) {
            throw new Error("goal wake became stale before queue hand-off")
          }
          if (opts.resumeAttempt !== undefined) {
            await opts.resumeAttempt(id, attempt)
            return
          }
          await opts.probes.resume(id)
        },
      }
      const outcome = await runIdleContinuation(attempt.threadId, guardedDeps)
      // A second guard can reject after the controller's fire-time decision.
      // Treat that as a rejected enqueue so the attempt reservation releases
      // rather than silently consuming a retry opportunity.
      if (!outcome.launched) throw new Error(`goal wake not launched: ${outcome.skipReason}`)
    },
  })

  const resetForNextCheckpoint = (): void => {
    try {
      if (opts.isQuiescent?.() === false) {
        controller.cancel()
        return
      }
    } catch (_error) {
      controller.cancel()
      return
    }
    const ordinal = checkpointOrdinal
    checkpointOrdinal += 1
    controller.reset({ threadId, checkpointOrdinal: ordinal })
  }

  // A resumed session may already carry an active goal before the first user
  // action, so it needs one initial quiet-window arm.
  resetForNextCheckpoint()
  return {
    onGoalMutation: resetForNextCheckpoint,
    onInfrastructureUnavailable: (objectiveRevision, observedAt) => {
      settlementHint = { infraUnavailableAtRevision: objectiveRevision, observedAt }
      resetForNextCheckpoint()
    },
    onAttach: (nextThreadId) => {
      if (nextThreadId.length === 0) return
      const priorThreadId = threadId
      controller.cancel()
      controller.clearAttempts(priorThreadId)
      threadId = nextThreadId
      settlementHint = {}
      resetForNextCheckpoint()
    },
    onActivity: () => controller.onActivity(),
    onLocalInputSettled: resetForNextCheckpoint,
    onTurnSettled: resetForNextCheckpoint,
    stop: () => controller.stop(),
    activityEpoch: () => controller.activityEpoch(),
    status: (): GoalWakeStatus => {
      const armed = controller.status()
      if (armed.kind !== "idle") return armed
      const stoppedSlot = failStoppedStatus(opts.attemptSlotStatus)
      if (stoppedSlot !== undefined) return stoppedSlot
      let quiet = true
      try {
        quiet = opts.isQuiescent?.() !== false
      } catch (_error) {
        quiet = false
      }
      if (!quiet) return { kind: "idle", skipReason: "not-quiescent" }
      const decision = computeGoalWakeDelay(
        opts.readDomain(threadId),
        policy,
        settlementHint,
        now(),
      )
      return "skip" in decision
        ? { kind: "idle", skipReason: decision.skip }
        : { kind: "pending", delayMs: decision.delayMs }
    },
  }
}
