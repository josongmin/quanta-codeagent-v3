/**
 * GOAL-06 rail 11 — a queued autonomous continuation is dropped at DEQUEUE
 * when raw user input moved the wake controller's activity epoch after the
 * arm; only the continuation is dropped (plain user input never is), and a
 * legacy meta without an epoch keeps the revision/status rule.
 */

import { describe, expect, test } from "bun:test"
import { createGoalWakeSignalSlot } from "@/apps/cli/repl/goal-wake-signal"
import { normalizeCliPromptInput } from "@/apps/cli/repl/prompt-types"
import {
  claimGoalAttempt,
  isStaleGoalContinuation,
} from "@/apps/cli/repl/session-loop/interactive-loop"
import { createObjectiveAttemptSlot, createObjectiveAuthority } from "@/objective"

describe("GOAL-06 rail 11 — dequeue epoch guard", () => {
  test("epoch moved ⇒ stale; equal ⇒ fresh; plain input never stale; legacy meta falls back", () => {
    const authority = createObjectiveAuthority({ now: () => 1 })
    authority.create("t", { goal: "g", successCriteria: ["c"] })
    const slot = createGoalWakeSignalSlot()
    let epoch = 3
    slot.current = {
      onGoalMutation: () => {},
      onActivity: () => {},
      onLocalInputSettled: () => {},
      onTurnSettled: () => {},
      activityEpoch: () => epoch,
    }
    const revision = authority.readDomain("t").revision
    const queued = normalizeCliPromptInput({
      text: "continue",
      goalContinuation: {
        threadId: "t",
        objectiveRevision: revision,
        attemptKey: "k",
        activityEpoch: 3,
      },
    })
    expect(isStaleGoalContinuation(queued, authority, "t", slot)).toBe(false)
    epoch = 4 // the user typed after the arm
    expect(isStaleGoalContinuation(queued, authority, "t", slot)).toBe(true)
    expect(isStaleGoalContinuation(normalizeCliPromptInput("hello"), authority, "t", slot)).toBe(
      false,
    )
    const legacy = normalizeCliPromptInput({
      text: "continue",
      goalContinuation: { threadId: "t", objectiveRevision: revision, attemptKey: "k2" },
    })
    expect(isStaleGoalContinuation(legacy, authority, "t", slot)).toBe(false)
    // no controller in the slot ⇒ the epoch cannot be judged ⇒ revision rule only
    slot.current = undefined
    expect(isStaleGoalContinuation(queued, authority, "t", slot)).toBe(false)
  })

  test("GOAL-08 rail 15 — a queued /goal work prompt claims the slot with USER provenance; a plain continuation stays autonomous", () => {
    const authority = createObjectiveAuthority({ now: () => 1 })
    authority.create("t", { goal: "g", successCriteria: ["c"] })
    const slot = createObjectiveAttemptSlot()
    const work = normalizeCliPromptInput({
      text: "do the thing",
      goalContinuation: {
        threadId: "t",
        objectiveRevision: authority.readDomain("t").revision,
        attemptKey: "user-work:1",
        provenance: "user-requested-goal-work",
      },
    })
    expect(claimGoalAttempt(slot, authority, work)).toBe(true)
    const status = slot.status()
    expect(status.kind).toBe("claimed")
    if (status.kind === "claimed")
      expect(status.attempt.provenance).toBe("user-requested-goal-work")
    slot.release()
    const plain = normalizeCliPromptInput({
      text: "continue",
      goalContinuation: {
        threadId: "t",
        objectiveRevision: authority.readDomain("t").revision,
        attemptKey: "k",
      },
    })
    expect(claimGoalAttempt(slot, authority, plain)).toBe(true)
    const again = slot.status()
    if (again.kind === "claimed") expect(again.attempt.provenance).toBe("autonomous-continuation")
  })

  test("GOAL-08 round 3 — a fail-stopped or occupied slot refuses the claim (the loop must then DROP the continuation)", () => {
    const authority = createObjectiveAuthority({ now: () => 1 })
    authority.create("t", { goal: "g", successCriteria: ["c"] })
    const prompt = normalizeCliPromptInput({
      text: "continue",
      goalContinuation: {
        threadId: "t",
        objectiveRevision: authority.readDomain("t").revision,
        attemptKey: "k",
      },
    })
    const stopped = createObjectiveAttemptSlot()
    stopped.failStop("disk full")
    expect(claimGoalAttempt(stopped, authority, prompt)).toBe(false)
    const occupied = createObjectiveAttemptSlot()
    expect(claimGoalAttempt(occupied, authority, prompt)).toBe(true)
    expect(claimGoalAttempt(occupied, authority, prompt)).toBe(false)
  })
})
