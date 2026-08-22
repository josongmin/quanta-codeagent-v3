/**
 * HELLGATE E2E — feature H17 (FULL): a goal with a tiny token budget drives
 * through the store → enforcement fires → idle continuation is gated correctly.
 *
 * This exercises the orchestrator seam (`runIdleContinuation`) end-to-end with
 * an injected clock + an injected `AgentLoopPort`-shaped resume sink. No real
 * loop, no real clock, no env reads — the orchestrator is a pure-port seam.
 *
 *   1. set a goal with maxTokens=10 and accumulate usage under the cap →
 *      idle scan launches the continuation (resume sink called once).
 *   2. accumulate past the cap → status flips to budget_limited → idle scan is
 *      GATED (resume sink NOT called again).
 *   3. raising the cap un-limits → idle scan resumes.
 *   4. semaphore: a concurrent scan while one continuation is in-flight is a
 *      no-op (single resume).
 */
import { describe, expect, test } from "bun:test"
import type { ObjectivePort } from "@/objective"
import { createObjectiveStore } from "@/objective"
import {
  type ContinuationDeps,
  ContinuationSemaphore,
  runIdleContinuation,
} from "@/objective/continuation"

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
    h.store.set(TID, { goal: "ship feature", budget: { maxTokens: 10 } })
    h.store.recordUsage(TID, { tokens: 5 })

    // (1) under cap — idle scan launches the continuation
    const r1 = await runIdleContinuation(TID, h.deps)
    expect(r1.launched).toBe(true)
    expect(h.resumes).toEqual([TID])

    // (2) over cap — status flips, continuation is GATED
    h.store.recordUsage(TID, { tokens: 100 })
    expect(h.store.get(TID)?.status).toBe("budget_limited")
    const r2 = await runIdleContinuation(TID, h.deps)
    expect(r2.launched).toBe(false)
    expect(r2.skipReason).toBe("goal-not-active")
    expect(h.resumes).toEqual([TID]) // unchanged — no second resume

    // (3) raising the cap un-limits, scan resumes
    h.store.set(TID, { goal: "ship feature", budget: { maxTokens: 10_000 } })
    h.store.recordUsage(TID, { tokens: 5 })
    expect(h.store.get(TID)?.status).toBe("active")
    const r3 = await runIdleContinuation(TID, h.deps)
    expect(r3.launched).toBe(true)
    expect(h.resumes).toEqual([TID, TID])
  })

  test("concurrent scans share one permit — at most one resume in flight", async () => {
    const h = harness()
    h.store.set(TID, { goal: "g" })
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
    h.store.set(TID, { goal: "g" })
    const offDeps: ContinuationDeps = { ...h.deps, enabled: false }
    const r = await runIdleContinuation(TID, offDeps)
    expect(r.launched).toBe(false)
    expect(r.skipReason).toBe("disabled")
    expect(h.resumes).toEqual([])
  })
})
