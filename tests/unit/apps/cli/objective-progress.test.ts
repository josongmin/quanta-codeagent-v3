import { describe, expect, test } from "bun:test"
import { beginObjectiveProgress, finishObjectiveProgress } from "@/apps/cli/repl/objective-progress"
import { asObjectiveAuthority, createObjectiveAuthority } from "@/objective"
import { seedObjective } from "../../objective/v2-helpers"

describe("objective turn progress receipt", () => {
  test("records only bounded objective evidence after an active turn", () => {
    const objective = createObjectiveAuthority()
    const created = seedObjective(objective, "thread", { goal: "ship", successCriteria: ["test"] })
    const criterionId = created.successCriteria[0]?.id
    if (criterionId === undefined) throw new Error("criterion missing")
    const started = beginObjectiveProgress(objective, "thread", "work")
    // GOAL-01: the capture binds the live GENERATION id, not just the thread.
    expect(started?.objectiveId).toBe(created.objectiveId)
    objective.markCriterion("thread", criterionId, true)
    const written = finishObjectiveProgress({
      objective,
      prompt: "work",
      started,
      outcomeReason: "completed",
    })
    const receipt = asObjectiveAuthority(objective).readDomain("thread").progressReceipts?.[0]
    expect(written).toBeDefined()
    // GOAL-01: the receipt carries the generation it was measured against.
    expect(receipt?.objectiveId).toBe(created.objectiveId)
    expect(receipt?.turnOutcome).toBe("completed")
    expect(receipt?.criterionTransitions).toEqual([criterionId])
    expect(receipt?.remainingCriterionIds).toEqual([])
  })

  test("GOAL-01: a receipt for a REPLACED objective is dropped (never crosses a generation)", () => {
    const objective = createObjectiveAuthority()
    const first = seedObjective(objective, "thread", { goal: "ship v1", successCriteria: ["a"] })
    const started = beginObjectiveProgress(objective, "thread", "work")
    expect(started?.objectiveId).toBe(first.objectiveId)
    // The objective is replaced mid-turn: a fresh generation with fresh evidence.
    const second = objective.replace("thread", { goal: "ship v2", successCriteria: ["b"] })
    if (second === null) throw new Error("replace refused")
    expect(second.objectiveId).not.toBe(first.objectiveId)
    const criterionId = second.successCriteria[0]?.id
    if (criterionId === undefined) throw new Error("criterion missing")
    objective.markCriterion("thread", criterionId, true)
    // Finishing the turn that started on generation 1 must NOT attribute the
    // generation-2 criterion flip to the stale capture.
    const written = finishObjectiveProgress({
      objective,
      prompt: "work",
      started,
      outcomeReason: "completed",
    })
    expect(written).toBeUndefined()
    expect(asObjectiveAuthority(objective).readDomain("thread").progressReceipts ?? []).toEqual([])
  })

  test("GOAL-01: a receipt for a CLEARED objective is dropped", () => {
    const objective = createObjectiveAuthority()
    seedObjective(objective, "thread", { goal: "ship", successCriteria: ["a"] })
    const started = beginObjectiveProgress(objective, "thread", "work")
    expect(started).toBeDefined()
    expect(objective.clear("thread")).toBe(true)
    const written = finishObjectiveProgress({ objective, prompt: "work", started })
    expect(written).toBeUndefined()
  })

  test("never guesses another thread and rejects mismatched continuation metadata", () => {
    const objective = createObjectiveAuthority()
    seedObjective(objective, "other", { goal: "do not attribute here", successCriteria: ["x"] })
    expect(beginObjectiveProgress(objective, undefined, "work")).toBeUndefined()
    expect(
      beginObjectiveProgress(objective, "current", {
        text: "continue",
        goalContinuation: {
          threadId: "other",
          objectiveRevision: 1,
          attemptKey: "attempt",
        },
      }),
    ).toBeUndefined()
  })
})
