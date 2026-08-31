/** MetricsRegistry adapter for the bounded Objective lifecycle vocabulary. */

import { errMessage, logger } from "@/shared"
import { QUANTA_ATTRS } from "../vocabulary"
import type { MetricsRegistry } from "./port"

export const OBJECTIVE_LIFECYCLE_COUNTER = QUANTA_ATTRS.objective.lifecycleTotal

/** Structural mirror of the domain port: the composition root performs the
 * binding so the two library slices never cross-import. */
export interface ObjectiveLifecycleMetricSink {
  record(event: { readonly stage: string; readonly outcome: string }): void
}

export const createObjectiveLifecycleMetricsSink = (
  metrics: MetricsRegistry,
): ObjectiveLifecycleMetricSink => ({
  record: (event) => {
    try {
      metrics.increment(OBJECTIVE_LIFECYCLE_COUNTER, 1, {
        stage: event.stage,
        outcome: event.outcome,
      })
    } catch (error) {
      logger.warn(`observability.objective-lifecycle.record: ${errMessage(error)}`)
    }
  },
})
