/**
 * Bounded Objective lifecycle telemetry port.
 *
 * The domain owns the closed event vocabulary; observability owns adapters.
 * Events intentionally carry no thread/objective/attempt/check identity, goal
 * text, or free-form reason. An absent or throwing sink never changes domain
 * behavior.
 */

import { errMessage, logger } from "@/shared"

export const OBJECTIVE_LIFECYCLE_OUTCOMES = {
  wake: ["armed", "canceled", "skipped"],
  enqueue: ["admitted", "rejected", "stale"],
  attempt: ["started"],
  completion: ["satisfied", "refused"],
  verifier: [
    "verified",
    "stale-source",
    "sandbox-unavailable",
    "source-unavailable",
    "runner-unavailable",
  ],
} as const

type LifecycleOutcomes = typeof OBJECTIVE_LIFECYCLE_OUTCOMES
export type ObjectiveLifecycleStage = keyof LifecycleOutcomes
export type ObjectiveLifecycleEvent = {
  readonly [Stage in ObjectiveLifecycleStage]: {
    readonly stage: Stage
    readonly outcome: LifecycleOutcomes[Stage][number]
  }
}[ObjectiveLifecycleStage]

export interface ObjectiveLifecycleSink {
  record(event: ObjectiveLifecycleEvent): void
}

export const OBJECTIVE_LIFECYCLE_CARDINALITY = Object.values(OBJECTIVE_LIFECYCLE_OUTCOMES).reduce(
  (total, outcomes) => total + outcomes.length,
  0,
)

export const isObjectiveLifecycleEvent = (value: unknown): value is ObjectiveLifecycleEvent => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.stage !== "string" || typeof record.outcome !== "string") return false
  if (Object.keys(record).some((key) => key !== "stage" && key !== "outcome")) return false
  const outcomes = OBJECTIVE_LIFECYCLE_OUTCOMES[record.stage as ObjectiveLifecycleStage]
  return outcomes !== undefined && (outcomes as readonly string[]).includes(record.outcome)
}

export const emitObjectiveLifecycle = (
  sink: ObjectiveLifecycleSink | undefined,
  event: ObjectiveLifecycleEvent,
): void => {
  if (sink === undefined) return
  try {
    sink.record(event)
  } catch (error) {
    logger.warn(`objective.lifecycle-telemetry.emit: ${errMessage(error)}`)
  }
}
