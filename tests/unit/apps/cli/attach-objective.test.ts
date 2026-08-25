import { describe, expect, test } from "bun:test"
import { normalizeCliPromptInput } from "@/apps/cli/repl/prompt-types"
import { isStaleGoalContinuation } from "@/apps/cli/repl/session-loop/interactive-loop"
import { asObjectiveAuthority, createObjectiveStore } from "@/objective"

describe("CLI attached objective dequeue fence", () => {
  test("a queued continuation from the detached thread is stale before any body starts", () => {
    const store = createObjectiveStore()
    store.create("A", { goal: "old" })
    const a = asObjectiveAuthority(store).readDomain("A")
    const queued = normalizeCliPromptInput({
      text: "continue old",
      goalContinuation: {
        threadId: "A",
        objectiveRevision: a.revision,
        attemptKey: "attempt-A",
      },
    })
    store.create("B", { goal: "new" })
    expect(isStaleGoalContinuation(queued, store, "B")).toBe(true)
  })
})
