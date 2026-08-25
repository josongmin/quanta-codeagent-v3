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
 * DEFAULT-OFF (byte-identical): `enabled: false` (or a missing `threadId`) makes
 * {@link startGoalWakeController} a no-op returning `undefined` — no timer
 * is armed, so a session that has not opted into `QUANTA_GOAL_ENFORCE` behaves
 * exactly as before.
 *
 * SLICE FENCE: imports ONLY the closed `@/objective` barrel
 * (`runIdleContinuation`, `ContinuationSemaphore`, and the `ContinuationDeps`
 * probe/`resume` shape). No `@/agent` core, no reactor internals.
 */

import { type ContinuationDeps, ContinuationSemaphore, runIdleContinuation } from "./continuation"
import { createGoalWakeController, type GoalWakeAttempt } from "./goal-wake-controller"
import {
  computeGoalWakeDelay,
  DEFAULT_GOAL_WAKE_POLICY,
  type GoalWakePolicy,
  type GoalWakeSettlementHint,
} from "./goal-wake-policy"
import type { ObjectiveDomainSnapshot } from "./model"
import type { ObjectiveAuthority } from "./ports"

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
}

export interface StartGoalWakeOpts {
  readonly enabled: boolean
  readonly threadId: string | undefined
  readonly probes: GoalContinuationProbes
  /** Revisioned projection from the same authority `/goal` mutates. */
  readonly readDomain: (threadId: string) => ObjectiveDomainSnapshot
  /** Same authority as readDomain, used only to install the product default turn cap. */
  readonly authority?: ObjectiveAuthority | undefined
  /** Goal-specific quiescence duration, independent of UI presence handling. */
  readonly quietWindowMs: number
  readonly policy?: GoalWakePolicy | undefined
  readonly now?: (() => number) | undefined
  /** Full host projection, checked before arm. Fire-time checks are repeated
   * through `probes`, closing races after the timer is scheduled. */
  readonly isQuiescent?: (() => boolean) | undefined
  /** Optional typed queue hand-off. The CLI uses this to retain the captured
   * revision through dequeue; legacy hosts may keep the plain resume sink. */
  readonly resumeAttempt?: (threadId: string, attempt: GoalWakeAttempt) => Promise<void>
  readonly setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void
}

/** Goal pursuit's own quiet period. It is intentionally independent of the
 * UI idle-suppression window (`QUANTA_IDLE_MS`). */
export const DEFAULT_GOAL_QUIET_MS = 15_000

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
  const policy: GoalWakePolicy = opts.policy ?? {
    ...DEFAULT_GOAL_WAKE_POLICY,
    minQuietMs: opts.quietWindowMs,
  }
  const authority = opts.authority
  const ensureDefaultTurnCap = (): void => {
    if (authority === undefined) return
    const domain = authority.readDomain(threadId)
    const objective = domain.state?.objective
    if (objective === undefined || objective.budget.maxTurns !== undefined) return
    authority.commit(
      authority.prepare({
        threadId,
        actor: "system",
        mutation: {
          kind: "amendBudget",
          budget: {
            maxTurns: policy.maxAutonomousTurns,
            ...(objective.budget.maxTokens !== undefined
              ? { maxTokens: objective.budget.maxTokens }
              : {}),
          },
        },
      }),
      { admitted: true },
    )
  }
  ensureDefaultTurnCap()
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
    quietWindowMs: opts.quietWindowMs,
    resolveDelayMs: (domain) => {
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
    ensureDefaultTurnCap()
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
  }
}
