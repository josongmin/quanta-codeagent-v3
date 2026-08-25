/**
 * GOAL-06 — the CLI host binding of the goal wake controller.
 *
 * No interval polling remains: `startGoalWakeController` composes ONE
 * event-driven controller per session thread over the shared objective
 * authority (read port), the typed quiescence projection, the GOAL-04
 * attempt slot (a fail-stopped slot refuses further attributed turns), the
 * GOAL-03 verifier reconcile (awaited before every fire-time reread) and the
 * `runIdleContinuation` engine as the enqueue guard. Every controller decision
 * is observable through `status()` (the `/goal` report renders it) and an
 * optional decision sink; a sub-clamp quiet window is clamped with ONE
 * bounded warning.
 */

import {
  type ContinuationDeps,
  ContinuationSemaphore,
  clampGoalQuietMs,
  createGoalWakeController,
  type GoalQuiescence,
  type GoalWakeAttempt,
  type GoalWakeDecisionEvent,
  type GoalWakeStatus,
  type ObjectiveDomainSnapshot,
  type ObjectiveVerificationPort,
  runIdleContinuation,
} from "@/objective"
import { logger } from "@/shared"
import { type GoalQuiescenceProbes, projectGoalQuiescence } from "./repl/goal-quiescence"

/** The engine probes the host supplies (idle/plan/turn/queue/mailbox/ephemeral + resume). */
export type GoalContinuationProbes = Omit<ContinuationDeps, "enabled" | "semaphore" | "now">

export interface GoalWakeLifecycle {
  onGoalMutation(): void
  onActivity(): void
  onLocalInputSettled(): void
  onTurnSettled(): void
  stop(): void
  /** Typed scheduling decision (armed delay / skip reason / stopped). */
  status(): GoalWakeStatus
  /** Controller-local raw-input epoch (captured on every enqueued attempt). */
  activityEpoch(): number
}

export interface StartGoalWakeOpts {
  readonly enabled: boolean
  readonly threadId: string | undefined
  readonly probes: GoalContinuationProbes
  readonly readDomain: (threadId: string) => ObjectiveDomainSnapshot
  /** Configured quiet window; clamped to the public 15 s minimum. */
  readonly quietWindowMs: number
  /** Extra live-store probes with typed busy reasons (draft, approval, background, switch, close). */
  readonly quiescence?: Partial<GoalQuiescenceProbes> | undefined
  readonly attemptSlotBlocked?: (() => boolean) | undefined
  readonly verifier?: Pick<ObjectiveVerificationPort, "reconcile"> | undefined
  readonly onDecision?: ((event: GoalWakeDecisionEvent) => void) | undefined
  readonly resumeAttempt?: (threadId: string, attempt: GoalWakeAttempt) => Promise<void>
  readonly setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void
  readonly now?: (() => number) | undefined
}

export const startGoalWakeController = (opts: StartGoalWakeOpts): GoalWakeLifecycle | undefined => {
  const threadId = opts.threadId
  if (!opts.enabled || threadId === undefined || threadId.length === 0) return undefined
  const continuationDeps: ContinuationDeps = {
    ...opts.probes,
    enabled: true,
    semaphore: new ContinuationSemaphore(),
    now: opts.now ?? (() => Date.now()),
  }
  const setFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
  const clearFn = opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle))
  const quiet = clampGoalQuietMs(opts.quietWindowMs)
  if (quiet.clamped) {
    logger.warn(
      `goal-wake: QUANTA_GOAL_QUIET_MS=${opts.quietWindowMs} is below the public minimum; using ${quiet.quietMs}ms`,
    )
  }
  const quiescence = (id: string): GoalQuiescence =>
    projectGoalQuiescence({
      notIdle: () => !continuationDeps.threadIdle(id),
      turnActive: () => continuationDeps.turnActive(id),
      planModeActive: () => continuationDeps.planModeActive(id),
      queuedInputPending: () => continuationDeps.queuedInputPending(id),
      mailboxInputPending: () => continuationDeps.mailboxInputPending(id),
      isEphemeral: () => continuationDeps.isEphemeral(id),
      ...(opts.quiescence ?? {}),
    })
  let checkpointOrdinal = 0
  const controller = createGoalWakeController({
    enabled: true,
    baseQuietMs: opts.quietWindowMs,
    timer: {
      set: (fn, ms) => setFn(fn, ms),
      clear: (handle) => clearFn(handle as ReturnType<typeof setTimeout>),
    },
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    readDomain: opts.readDomain,
    quiescence,
    ...(opts.attemptSlotBlocked !== undefined
      ? { attemptSlotBlocked: opts.attemptSlotBlocked }
      : {}),
    ...(opts.verifier !== undefined
      ? {
          reconcile: (id) =>
            opts.verifier?.reconcile(id) ?? Promise.resolve({ kind: "no-objective" as const }),
        }
      : {}),
    ...(opts.onDecision !== undefined ? { onDecision: opts.onDecision } : {}),
    enqueue: async (attempt) => {
      const guardedDeps: ContinuationDeps = {
        ...continuationDeps,
        resume: async (id) => {
          const current = opts.readDomain(id)
          if (
            current.state === null ||
            current.state.objective.objectiveId !== attempt.objectiveId ||
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
      const outcome = await runIdleContinuation(threadId, guardedDeps)
      if (!outcome.launched) throw new Error(`goal wake not launched: ${outcome.skipReason}`)
    },
  })
  const resetForNextCheckpoint = (): void => {
    const ordinal = checkpointOrdinal
    checkpointOrdinal += 1
    controller.reset({ threadId, checkpointOrdinal: ordinal })
  }
  resetForNextCheckpoint()
  return {
    onGoalMutation: resetForNextCheckpoint,
    onActivity: () => controller.onActivity(),
    onLocalInputSettled: resetForNextCheckpoint,
    onTurnSettled: resetForNextCheckpoint,
    stop: () => controller.stop(),
    status: () => controller.explain(threadId),
    activityEpoch: () => controller.activityEpoch(),
  }
}
