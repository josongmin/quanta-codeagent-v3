import { describe, expect, test } from "bun:test"
import { beginObjectiveProgress, finishObjectiveProgress } from "@/apps/cli/repl/objective-progress"
import { asObjectiveAuthority, createObjectiveAuthority } from "@/objective"

describe("objective turn progress receipt", () => {
  test("records only bounded objective evidence after an active turn", () => {
    const objective = createObjectiveAuthority()
    const created = objective.set("thread", { goal: "ship", successCriteria: ["test"] })
    const criterionId = created.successCriteria[0]?.id
    if (criterionId === undefined) throw new Error("criterion missing")
    const started = beginObjectiveProgress(objective, "thread", "work")
    objective.markCriterion("thread", criterionId, true)
    finishObjectiveProgress({ objective, prompt: "work", started, outcomeReason: "completed" })
    const receipt = asObjectiveAuthority(objective).readDomain("thread").progressReceipts?.[0]
    expect(receipt?.turnOutcome).toBe("completed")
    expect(receipt?.criterionTransitions).toEqual([criterionId])
    expect(receipt?.remainingCriterionIds).toEqual([])
  })

  test("never guesses another thread and rejects mismatched continuation metadata", () => {
    const objective = createObjectiveAuthority()
    objective.set("other", { goal: "do not attribute here", successCriteria: ["x"] })
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
