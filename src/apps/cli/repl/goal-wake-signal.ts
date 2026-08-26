import type { GoalWakeStatus } from "@/objective"
import type { CliPromptInput } from "./prompt-types"

/**
 * Session-local bridge from surface events to the goal wake controller.
 *
 * The composition root owns this mutable slot because slash commands are
 * composed before the interactive queue/controller exists. It holds no goal
 * state and never decides eligibility; it merely relays real lifecycle edges
 * to the controller installed by the session loop.
 */
export interface GoalWakeSignal {
  onGoalMutation(): void
  onInfrastructureUnavailable?(objectiveRevision: number, observedAt: number): void
  onAttach?(threadId: string): void
  onActivity(): void
  /** A local line was handled without starting an agent turn (slash or blank).
   * It starts a fresh quiet window after the user-visible command completed. */
  onLocalInputSettled(): void
  onTurnSettled(): void
  /** GOAL-06 rail 11 — raw-input epoch; a queued continuation whose captured
   *  epoch no longer matches is dropped at dequeue (the draft is untouched). */
  activityEpoch?(): number
  /** GOAL-06 — typed scheduling decision for the `/goal` report. */
  status?(): GoalWakeStatus
}

export interface GoalWakeSignalSlot {
  current: GoalWakeSignal | undefined
  /** GOAL-05/08 rail 15 — late-bound by the session loop once the external
   *  prompt queue exists: `/goal work` pushes ONE foreground prompt carrying
   *  host-minted `user-requested-goal-work` provenance through it. */
  enqueueWork?: ((input: CliPromptInput) => void) | undefined
}

export const createGoalWakeSignalSlot = (): GoalWakeSignalSlot => ({ current: undefined })
