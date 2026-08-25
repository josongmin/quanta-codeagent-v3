/**
 * Session-local bridge from surface events to the goal wake controller.
 *
 * The composition root owns this mutable slot because slash commands are
 * composed before the interactive queue/controller exists. It holds no goal
 * state and never decides eligibility; it merely relays real lifecycle edges
 * to the controller installed by the session loop.
 */
import type { CliPromptInput } from "./prompt-types"

export interface GoalWakeSignal {
  onGoalMutation(): void
  onActivity(): void
  /** A local line was handled without starting an agent turn (slash or blank).
   * It starts a fresh quiet window after the user-visible command completed. */
  onLocalInputSettled(): void
  onTurnSettled(): void
}

export interface GoalWakeSignalSlot {
  current: GoalWakeSignal | undefined
  /** GOAL-05A — late-bound by the session loop once the external prompt queue
   *  exists: `/goal work` pushes ONE foreground prompt carrying host-minted
   *  `user-requested-goal-work` provenance through it. Absent ⇒ not wired. */
  enqueueWork?: ((input: CliPromptInput) => void) | undefined
}

export const createGoalWakeSignalSlot = (): GoalWakeSignalSlot => ({ current: undefined })
