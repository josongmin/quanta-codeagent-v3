/**
 * GOAL-04 wiring proof — the CLI surface claims the host attempt slot for a
 * goal-continuation prompt with HOST-minted provenance; plain chat, a missing
 * objective, or a missing slot never claims (⇒ the turn stays unattributed).
 */

import { describe, expect, test } from "bun:test"
import { normalizeCliPromptInput } from "@/apps/cli/repl/prompt-types"
import { claimGoalAttempt } from "@/apps/cli/repl/session-loop/interactive-loop"
import { createObjectiveAttemptSlot, createObjectiveAuthority } from "@/objective"

const continuation = (threadId = "t") =>
  normalizeCliPromptInput({
    text: "continue",
    goalContinuation: { threadId, objectiveRevision: 1, attemptKey: "wake-7" },
  })

describe("GOAL-04 — CLI goal attempt claim", () => {
  test("a goal-continuation prompt claims the slot with autonomous provenance bound to the live generation", () => {
    const authority = createObjectiveAuthority({ now: () => 1 })
    authority.create("t", { goal: "g", successCriteria: ["c"] })
    const slot = createObjectiveAttemptSlot()
    expect(claimGoalAttempt(slot, authority, continuation())).toBe(true)
    const status = slot.status()
    expect(status.kind).toBe("claimed")
    if (status.kind === "claimed") {
      expect(status.attempt).toEqual({
        threadId: "t",
        objectiveId: authority.get("t")?.objectiveId ?? "",
        startedRevision: authority.readDomain("t").revision,
        attemptId: "wake-7",
        provenance: "autonomous-continuation",
        executionMode: "foreground",
      })
    }
  })

  test("plain chat, no objective, no store, or no slot never claims", () => {
    const authority = createObjectiveAuthority({ now: () => 1 })
    const slot = createObjectiveAttemptSlot()
    expect(claimGoalAttempt(slot, authority, normalizeCliPromptInput("hello"))).toBe(false)
    expect(claimGoalAttempt(slot, authority, continuation())).toBe(false) // no objective on t
    expect(claimGoalAttempt(slot, undefined, continuation())).toBe(false)
    authority.create("t", { goal: "g", successCriteria: ["c"] })
    expect(claimGoalAttempt(undefined, authority, continuation())).toBe(false)
    expect(slot.status().kind).toBe("empty")
  })

  test("user-requested goal work (/goal work) claims with USER provenance; plain continuation stays autonomous", () => {
    const authority = createObjectiveAuthority({ now: () => 1 })
    authority.create("t", { goal: "g", successCriteria: ["c"] })
    const slot = createObjectiveAttemptSlot()
    const work = normalizeCliPromptInput({
      text: "do the thing",
      goalContinuation: {
        threadId: "t",
        objectiveRevision: 1,
        attemptKey: "user-work:1",
        provenance: "user-requested-goal-work",
      },
    })
    expect(claimGoalAttempt(slot, authority, work)).toBe(true)
    const status = slot.status()
    expect(status.kind).toBe("claimed")
    if (status.kind === "claimed") {
      expect(status.attempt.provenance).toBe("user-requested-goal-work")
      expect(status.attempt.attemptId).toBe("user-work:1")
    }
  })

  test("a second continuation while a claim is outstanding is refused (single occupancy)", () => {
    const authority = createObjectiveAuthority({ now: () => 1 })
    authority.create("t", { goal: "g", successCriteria: ["c"] })
    const slot = createObjectiveAttemptSlot()
    expect(claimGoalAttempt(slot, authority, continuation())).toBe(true)
    expect(claimGoalAttempt(slot, authority, continuation())).toBe(false)
  })
})
