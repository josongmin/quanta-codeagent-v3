/** MetricsRegistry adapter for the bounded Objective lifecycle vocabulary. */

import type { MetricsRegistry } from "./port"

export const OBJECTIVE_LIFECYCLE_COUNTER = "quanta.objective.lifecycle.total"

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
    } catch {
      // A broken registry/exporter is not execution authority.
    }
  },
})
