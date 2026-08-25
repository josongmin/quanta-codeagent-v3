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
  onActivity(): void
  onTurnSettled(): void
}

export interface GoalWakeSignalSlot {
  current: GoalWakeSignal | undefined
}

export const createGoalWakeSignalSlot = (): GoalWakeSignalSlot => ({ current: undefined })
