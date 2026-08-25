/**
 * Session-local bridge from surface events to the goal wake controller.
 *
 * The composition root owns this mutable slot because slash commands are
 * composed before the interactive queue/controller exists. It holds no goal
 * state and never decides eligibility; it merely relays real lifecycle edges
 * to the controller installed by the session loop.
 */
import type { GoalWakeStatus, ReconcileOutcome } from "@/objective"
import type { CliPromptInput } from "./prompt-types"

export interface GoalWakeSignal {
  onGoalMutation(): void
  onActivity(): void
  /** A local line was handled without starting an agent turn (slash or blank).
   * It starts a fresh quiet window after the user-visible command completed. */
  onLocalInputSettled(): void
  onTurnSettled(): void
  /** GOAL-06 — typed scheduling decision the `/goal` report renders. */
  status(): GoalWakeStatus
  /** GOAL-06 — raw-input epoch; a queued continuation is dropped at dequeue
   *  when it no longer matches (the user's draft is never touched). */
  activityEpoch(): number
}

export interface GoalWakeSignalSlot {
  current: GoalWakeSignal | undefined
  /** GOAL-05A — late-bound by the session loop once the external prompt queue
   *  exists: `/goal work` pushes ONE foreground prompt carrying host-minted
   *  `user-requested-goal-work` provenance through it. Absent ⇒ not wired. */
  enqueueWork?: ((input: CliPromptInput) => void) | undefined
  /** GOAL-06 — late-bound by the surface composer: the verifier's source
   *  reconcile the controller awaits BEFORE every fire-time reread. */
  reconcile?: ((threadId: string) => Promise<ReconcileOutcome>) | undefined
}

export const createGoalWakeSignalSlot = (): GoalWakeSignalSlot => ({ current: undefined })
