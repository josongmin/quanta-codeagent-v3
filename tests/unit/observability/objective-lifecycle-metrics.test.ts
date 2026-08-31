import { describe, expect, test } from "bun:test"
import {
  OBJECTIVE_LIFECYCLE_CARDINALITY,
  OBJECTIVE_LIFECYCLE_OUTCOMES,
  type ObjectiveLifecycleEvent,
} from "@/objective"
import {
  createObjectiveLifecycleMetricsSink,
  defaultMetricsRegistry,
  OBJECTIVE_LIFECYCLE_COUNTER,
} from "@/observability/metrics/index"

describe("R5 Objective lifecycle metrics adapter", () => {
  test("uses one counter and only closed stage/outcome labels", () => {
    const metrics = defaultMetricsRegistry({ now: () => 1 })
    const sink = createObjectiveLifecycleMetricsSink(metrics)
    for (const [stage, outcomes] of Object.entries(OBJECTIVE_LIFECYCLE_OUTCOMES)) {
      for (const outcome of outcomes) sink.record({ stage, outcome } as ObjectiveLifecycleEvent)
    }

    const rows = metrics.snapshot()
    expect(rows).toHaveLength(OBJECTIVE_LIFECYCLE_CARDINALITY)
    expect(rows.every((row) => row.name === OBJECTIVE_LIFECYCLE_COUNTER)).toBe(true)
    expect(rows.every((row) => Object.keys(row.labels).sort().join(",") === "outcome,stage")).toBe(
      true,
    )
    expect(rows.every((row) => row.value === 1)).toBe(true)
  })

  test("a throwing registry is isolated by the adapter", () => {
    const sink = createObjectiveLifecycleMetricsSink({
      increment: () => {
        throw new Error("registry down")
      },
      observe: () => undefined,
      gauge: () => undefined,
      snapshot: () => [],
      reset: () => undefined,
      flush: async () => undefined,
    })
    expect(() => sink.record({ stage: "wake", outcome: "armed" })).not.toThrow()
  })
})
