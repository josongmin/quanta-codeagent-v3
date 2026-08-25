/**
 * HELLGATE E2E — feature H17 (FULL): a goal with a tiny token budget drives
 * through the store → enforcement fires → idle continuation is gated correctly.
 *
 * This exercises the orchestrator seam (`runIdleContinuation`) end-to-end with
 * an injected clock + an injected `AgentLoopPort`-shaped resume sink. No real
 * loop, no real clock, no env reads — the orchestrator is a pure-port seam.
 *
 *   1. create a goal with maxTokens=10 and settle usage under the cap →
 *      idle scan launches the continuation (resume sink called once).
 *   2. settle past the cap → status flips to budget_limited → idle scan is
 *      GATED (resume sink NOT called again).
 *   3. raising the cap un-limits → idle scan resumes.
 *   4. semaphore: a concurrent scan while one continuation is in-flight is a
 *      no-op (single resume).
 *
 * GOAL-01: usage is HOST-settled (`settleUsage`, the `settleAttempt` mutation)
 * — the retired `recordUsage` self-report is gone. Raising the cap is the
 * same-generation `amendBudget` (no ledger reset, same objectiveId).
 */
import { describe, expect, test } from "bun:test"
import type { ObjectivePort } from "@/objective"
import { createObjectiveStore } from "@/objective"
import {
  type ContinuationDeps,
  ContinuationSemaphore,
  runIdleContinuation,
} from "@/objective/continuation"
import { objectiveIdOf, settleUsage } from "./objective/v2-helpers"

const TID = "thread-e2e"

interface Harness {
  readonly store: ObjectivePort
  readonly deps: ContinuationDeps
  resumes: string[]
  setClock(t: number): void
}

const harness = (): Harness => {
  let t = 1_000
  const store = createObjectiveStore({ now: () => t, enforceBudget: true })
  const resumes: string[] = []
  const sem = new ContinuationSemaphore()
  const h: Harness = {
    store,
    resumes,
    setClock(next) {
      t = next
    },
    deps: {
      enabled: true,
      objective: store,
      semaphore: sem,
      now: () => t,
      threadIdle: () => true,
      planModeActive: () => false,
      turnActive: () => false,
      queuedInputPending: () => false,
      mailboxInputPending: () => false,
      isEphemeral: () => false,
      resume: async (threadId: string) => {
        resumes.push(threadId)
      },
    },
  }
  return h
}

describe("HELLGATE E2E [H17] — tiny budget drives enforcement + gated continuation", () => {
  test("under cap ⇒ continuation launches; over cap ⇒ gated; un-limit ⇒ resumes", async () => {
    const h = harness()
    h.store.create(TID, { goal: "ship feature", budget: { maxTokens: 10 } })
    const id = objectiveIdOf(h.store, TID)
    settleUsage(h.store, TID, { tokens: 5 })

    // (1) under cap — idle scan launches the continuation
    const r1 = await runIdleContinuation(TID, h.deps)
    expect(r1.launched).toBe(true)
    expect(h.resumes).toEqual([TID])

    // (2) over cap — status flips, continuation is GATED
    settleUsage(h.store, TID, { tokens: 100 })
    expect(h.store.get(TID)?.status).toBe("budget_limited")
    const r2 = await runIdleContinuation(TID, h.deps)
    expect(r2.launched).toBe(false)
    expect(r2.skipReason).toBe("goal-not-active")
    expect(h.resumes).toEqual([TID]) // unchanged — no second resume

    // (3) raising the cap un-limits, scan resumes
    // GOAL-01: same-generation cap amendment (the legacy re-`set` is now an
    // explicit `replace` that mints a new generation; here the goal is unchanged).
    h.store.amendBudget(TID, { maxTokens: 10_000 })
    settleUsage(h.store, TID, { tokens: 5 })
    expect(h.store.get(TID)?.objectiveId).toBe(id)
    expect(h.store.get(TID)?.budget.tokensUsed).toBe(110)
    expect(h.store.get(TID)?.status).toBe("active")
    const r3 = await runIdleContinuation(TID, h.deps)
    expect(r3.launched).toBe(true)
    expect(h.resumes).toEqual([TID, TID])
  })

  test("concurrent scans share one permit — at most one resume in flight", async () => {
    const h = harness()
    h.store.create(TID, { goal: "g" })
    // launch two scans concurrently; the semaphore allows only one to proceed
    const [a, b] = await Promise.all([
      runIdleContinuation(TID, h.deps),
      runIdleContinuation(TID, h.deps),
    ])
    const launched = [a, b].filter((r) => r.launched).length
    expect(launched).toBe(1)
    const refused = [a, b].find((r) => !r.launched)
    expect(refused?.skipReason).toBe("semaphore-busy")
    expect(h.resumes.length).toBe(1)
  })

  test("DEFAULT-OFF — disabled deps never launch (byte-identical informational)", async () => {
    const h = harness()
    h.store.create(TID, { goal: "g" })
    const offDeps: ContinuationDeps = { ...h.deps, enabled: false }
    const r = await runIdleContinuation(TID, offDeps)
    expect(r.launched).toBe(false)
    expect(r.skipReason).toBe("disabled")
    expect(h.resumes).toEqual([])
  })
})
