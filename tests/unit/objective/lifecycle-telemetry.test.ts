import { describe, expect, test } from "bun:test"
import {
  emitObjectiveLifecycle,
  isObjectiveLifecycleEvent,
  OBJECTIVE_LIFECYCLE_CARDINALITY,
  OBJECTIVE_LIFECYCLE_OUTCOMES,
  type ObjectiveLifecycleEvent,
} from "@/objective"

const everyEvent = (): ObjectiveLifecycleEvent[] =>
  Object.entries(OBJECTIVE_LIFECYCLE_OUTCOMES).flatMap(([stage, outcomes]) =>
    outcomes.map((outcome) => ({ stage, outcome }) as ObjectiveLifecycleEvent),
  )

describe("R5 bounded Objective lifecycle event port", () => {
  test("the complete stage/outcome universe is closed at fourteen series", () => {
    const events = everyEvent()
    expect(OBJECTIVE_LIFECYCLE_CARDINALITY).toBe(14)
    expect(events).toHaveLength(14)
    expect(events.every(isObjectiveLifecycleEvent)).toBe(true)
  })

  test("identifiers, text, reasons and unknown pairs fail the runtime boundary", () => {
    expect(isObjectiveLifecycleEvent({ stage: "wake", outcome: "armed", threadId: "secret" })).toBe(
      false,
    )
    expect(isObjectiveLifecycleEvent({ stage: "wake", outcome: "free-form" })).toBe(false)
    expect(isObjectiveLifecycleEvent({ stage: "other", outcome: "armed" })).toBe(false)
  })

  test("absent and throwing sinks never escape", () => {
    const event = { stage: "attempt", outcome: "started" } as const
    expect(() => emitObjectiveLifecycle(undefined, event)).not.toThrow()
    expect(() =>
      emitObjectiveLifecycle(
        {
          record: () => {
            throw new Error("collector down")
          },
        },
        event,
      ),
    ).not.toThrow()
  })
})
