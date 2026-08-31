import { describe, expect, test } from "bun:test"
import {
  createObjectiveAuthority,
  createObjectiveCapabilities,
  type ObjectiveLifecycleEvent,
} from "@/objective"

const capture = () => {
  const events: ObjectiveLifecycleEvent[] = []
  return { events, sink: { record: (event: ObjectiveLifecycleEvent) => events.push(event) } }
}

describe("R5 authority lifecycle producers", () => {
  test("accepted beginAttempt and derived completion emit their owner-local transitions", () => {
    const { events, sink } = capture()
    const authority = createObjectiveAuthority({ now: () => 1, lifecycleSink: sink })
    authority.create("t", { goal: "g", successCriteria: ["done"] })
    const caps = createObjectiveCapabilities(authority)
    const criterionId = authority.get("t")?.successCriteria[0]?.id ?? ""

    const started = caps.system.commit("t", {
      kind: "beginAttempt",
      attempt: {
        objectiveId: authority.get("t")?.objectiveId ?? "",
        attemptId: "private-attempt",
        provenance: "user-requested-goal-work",
        executionMode: "foreground",
        startedRevision: authority.readDomain("t").revision,
      },
    })
    expect(started.ok).toBe(true)
    expect(caps.user.commit("t", { kind: "markCriterion", criterionId, met: true }).ok).toBe(true)
    expect(events).toEqual([
      { stage: "attempt", outcome: "started" },
      { stage: "completion", outcome: "satisfied" },
    ])
    expect(JSON.stringify(events)).not.toContain("private-attempt")
  })

  test("a refused completion is counted once and a throwing sink changes no result", () => {
    const { events, sink } = capture()
    const authority = createObjectiveAuthority({ lifecycleSink: sink })
    authority.create("t", { goal: "g", successCriteria: ["done"] })
    const refused = createObjectiveCapabilities(authority).user.commit("t", {
      kind: "markCriterion",
      criterionId: "unknown",
      met: true,
    })
    expect(refused.ok).toBe(false)
    expect(events).toEqual([{ stage: "completion", outcome: "refused" }])

    const throwing = createObjectiveAuthority({
      lifecycleSink: {
        record: () => {
          throw new Error("collector down")
        },
      },
    })
    throwing.create("t", { goal: "g", successCriteria: ["done"] })
    const criterionId = throwing.get("t")?.successCriteria[0]?.id ?? ""
    expect(
      createObjectiveCapabilities(throwing).user.commit("t", {
        kind: "markCriterion",
        criterionId,
        met: true,
      }).ok,
    ).toBe(true)
    expect(throwing.get("t")?.status).toBe("completed")
  })
})
