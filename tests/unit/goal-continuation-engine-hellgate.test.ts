/**
 * HELLGATE — adversarial, mutation-grade proofs for the PURE goal-continuation
 * engine (`@/objective` barrel → `src/objective/continuation.ts`).
 *
 * Target surface (H17, Codex `core/src/goals.rs` PURE core):
 *   - evaluateContinuation(input): TOTAL no-I/O guard chain → launch|skip+reason
 *   - ContinuationSemaphore: single-permit, idempotent-release
 *   - runIdleContinuation(threadId, deps): NO-THROW orchestrator wiring the pure
 *     decision to injected ports + a resume sink
 *
 * Every test is written to go RED if the corresponding line in continuation.ts
 * is mutated/broken. The WHY-red is stated inline per case. No vacuous asserts
 * (no bare toBeDefined); exact values only; paired controls isolate the ONE
 * variable under test; resume side-effects are observed via a real spy.
 */

import { describe, expect, test } from "bun:test"
import type {
  ContinuationDeps,
  ContinuationSkipReason,
  GoalContinuationInput,
  ObjectiveStatus,
} from "@/objective"
import {
  ContinuationSemaphore,
  createObjectiveStore,
  evaluateContinuation,
  runIdleContinuation,
} from "@/objective"

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures / builders
// ─────────────────────────────────────────────────────────────────────────────

/** The ALL-PASS snapshot: every guard passes → evaluateContinuation launches.
 *  Each test flips exactly ONE field so the launch↔skip delta is the guard
 *  under test (paired-control). If a mutation broke a guard, the all-pass
 *  baseline would launch when it must skip (or vice-versa). */
const ALL_PASS: GoalContinuationInput = {
  enabled: true,
  threadIdle: true,
  goalStatusAtScan: "active",
  goalStatusAtLaunch: "active",
  planModeActive: false,
  turnActive: false,
  queuedInputPending: false,
  mailboxInputPending: false,
  ephemeralThread: false,
}

/** The closed set of NON-active statuses (the whole enum minus "active"). */
const NON_ACTIVE_STATUSES: readonly ObjectiveStatus[] = [
  "paused",
  "usage_limited",
  "budget_limited",
  "completed",
  "blocked",
]

/** A throwing thunk — proves a port/probe/sink was NEVER touched (default-OFF /
 *  no-touch proofs) OR that a throw degrades to skip (no-throw contract). */
const boom = (): never => {
  throw new Error("PORT TOUCHED — must not happen")
}

/** Spy-able resume sink. `calls` records every threadId it was invoked with. */
const makeResumeSpy = (): {
  resume: (threadId: string) => Promise<void>
  calls: string[]
} => {
  const calls: string[] = []
  return {
    calls,
    resume: async (threadId: string): Promise<void> => {
      calls.push(threadId)
    },
  }
}

/** A ContinuationDeps whose probes ALL pass (→ launch) unless overridden.
 *  `objective.get` returns a minimal active objective for any thread. */
const makeDeps = (over: Partial<ContinuationDeps> = {}): ContinuationDeps => {
  const activeObjective = (threadId: string) => ({
    // GOAL-01: every objective carries its authority-minted generation id + creator.
    objectiveId: `obj-${threadId}`,
    createdBy: "system" as const,
    attempts: { autonomousTurnsStarted: 0 },
    threadId,
    goal: "g",
    successCriteria: [],
    status: "active" as ObjectiveStatus,
    budget: { tokensUsed: 0, turnsUsed: 0 },
    blockers: [],
    blockerObservations: [],
    nextActions: [],
    createdAt: 0,
    updatedAt: 0,
  })
  return {
    enabled: true,
    objective: { get: (id: string) => activeObjective(id) },
    semaphore: new ContinuationSemaphore(),
    now: () => 0,
    threadIdle: () => true,
    planModeActive: () => false,
    turnActive: () => false,
    queuedInputPending: () => false,
    mailboxInputPending: () => false,
    isEphemeral: () => false,
    resume: async () => {},
    ...over,
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. evaluateContinuation — ALL-PASS baseline + guard PRECEDENCE table
// ═════════════════════════════════════════════════════════════════════════════

describe("evaluateContinuation — baseline", () => {
  test("ALL-PASS snapshot launches with no skipReason", () => {
    // RED if any guard's polarity is inverted (a broken guard would skip here).
    const d = evaluateContinuation(ALL_PASS)
    expect(d.launch).toBe(true)
    expect(d.skipReason).toBeUndefined()
  })
})

/**
 * PRECEDENCE table. For each guard we build a snapshot where THAT guard AND
 * every LATER guard would ALSO fail — yet the earlier guard's reason must win.
 * This proves the FIXED evaluation order (line 124→136), not merely "some
 * skip". Each row = the earliest-failing guard's expected reason.
 *
 * `later` sets every field that trips a guard strictly AFTER the row's guard,
 * so if two guards were reordered the expected reason would change → RED.
 */
describe("evaluateContinuation — guard precedence (fixed order)", () => {
  // Fields ordered by guard precedence. Setting field N to its failing value
  // (plus all fields > N) must surface guard N's reason.
  const rows: ReadonlyArray<{
    guard: string
    reason: ContinuationSkipReason
    // The snapshot: this guard fails AND every later guard also fails.
    input: GoalContinuationInput
  }> = [
    {
      guard: "disabled (1st)",
      reason: "disabled",
      // enabled:false wins even though not-idle, no-goal, ephemeral, ... all fail.
      input: {
        enabled: false,
        threadIdle: false,
        goalStatusAtScan: null,
        goalStatusAtLaunch: null,
        planModeActive: true,
        turnActive: true,
        queuedInputPending: true,
        mailboxInputPending: true,
        ephemeralThread: true,
      },
    },
    {
      guard: "not-idle (2nd)",
      reason: "not-idle",
      // enabled passes; not-idle wins over no-goal/ephemeral/... which also fail.
      input: {
        enabled: true,
        threadIdle: false,
        goalStatusAtScan: null,
        goalStatusAtLaunch: null,
        planModeActive: true,
        turnActive: true,
        queuedInputPending: true,
        mailboxInputPending: true,
        ephemeralThread: true,
      },
    },
    {
      guard: "no-goal (3rd)",
      reason: "no-goal",
      // idle passes; null-scan wins over ephemeral/plan/turn/... which also fail.
      input: {
        enabled: true,
        threadIdle: true,
        goalStatusAtScan: null,
        goalStatusAtLaunch: null,
        planModeActive: true,
        turnActive: true,
        queuedInputPending: true,
        mailboxInputPending: true,
        ephemeralThread: true,
      },
    },
    {
      guard: "ephemeral-thread (4th)",
      reason: "ephemeral-thread",
      // goal present + ephemeral wins over plan/turn/queue/mailbox/goal-not-active.
      input: {
        enabled: true,
        threadIdle: true,
        goalStatusAtScan: "paused", // would trip goal-not-active (later)
        goalStatusAtLaunch: "paused",
        planModeActive: true,
        turnActive: true,
        queuedInputPending: true,
        mailboxInputPending: true,
        ephemeralThread: true,
      },
    },
    {
      guard: "plan-mode-active (5th)",
      reason: "plan-mode-active",
      input: {
        enabled: true,
        threadIdle: true,
        goalStatusAtScan: "paused",
        goalStatusAtLaunch: "paused",
        planModeActive: true,
        turnActive: true,
        queuedInputPending: true,
        mailboxInputPending: true,
        ephemeralThread: false, // ephemeral passes so plan-mode is the earliest
      },
    },
    {
      guard: "turn-active (6th)",
      reason: "turn-active",
      input: {
        enabled: true,
        threadIdle: true,
        goalStatusAtScan: "paused",
        goalStatusAtLaunch: "paused",
        planModeActive: false,
        turnActive: true,
        queuedInputPending: true,
        mailboxInputPending: true,
        ephemeralThread: false,
      },
    },
    {
      guard: "queued-input (7th)",
      reason: "queued-input",
      input: {
        enabled: true,
        threadIdle: true,
        goalStatusAtScan: "paused",
        goalStatusAtLaunch: "paused",
        planModeActive: false,
        turnActive: false,
        queuedInputPending: true,
        mailboxInputPending: true,
        ephemeralThread: false,
      },
    },
    {
      guard: "mailbox-input (8th)",
      reason: "mailbox-input",
      input: {
        enabled: true,
        threadIdle: true,
        goalStatusAtScan: "paused",
        goalStatusAtLaunch: "paused",
        planModeActive: false,
        turnActive: false,
        queuedInputPending: false,
        mailboxInputPending: true,
        ephemeralThread: false,
      },
    },
    {
      guard: "goal-not-active (9th)",
      reason: "goal-not-active",
      // scan non-active wins over goal-changed (launch also non-active).
      input: {
        enabled: true,
        threadIdle: true,
        goalStatusAtScan: "paused",
        goalStatusAtLaunch: "blocked", // would trip goal-changed (later)
        planModeActive: false,
        turnActive: false,
        queuedInputPending: false,
        mailboxInputPending: false,
        ephemeralThread: false,
      },
    },
    {
      guard: "goal-changed (10th)",
      reason: "goal-changed",
      // scan active (passes goal-not-active), launch non-active → goal-changed.
      input: {
        enabled: true,
        threadIdle: true,
        goalStatusAtScan: "active",
        goalStatusAtLaunch: "blocked",
        planModeActive: false,
        turnActive: false,
        queuedInputPending: false,
        mailboxInputPending: false,
        ephemeralThread: false,
      },
    },
  ]

  for (const { guard, reason, input } of rows) {
    test(`${guard} → skipReason "${reason}" (earliest-failing guard wins)`, () => {
      // RED if the guard order in continuation.ts is permuted: a later guard
      // would then short-circuit first and surface the WRONG reason.
      const d = evaluateContinuation(input)
      expect(d.launch).toBe(false)
      expect(d.skipReason).toBe(reason)
    })
  }

  test("launch:true ONLY when ALL guards pass", () => {
    // Paired control for the whole table: flipping every failing field back to
    // its passing value yields launch. RED if any guard rejects a valid input.
    const d = evaluateContinuation(ALL_PASS)
    expect(d.launch).toBe(true)
    expect(d.skipReason).toBeUndefined()
  })

  test("precedence: disabled beats not-idle (adjacent 1↔2 swap detector)", () => {
    // RED if guards 1 and 2 are swapped — reason would flip to "not-idle".
    const d = evaluateContinuation({ ...ALL_PASS, enabled: false, threadIdle: false })
    expect(d.skipReason).toBe("disabled")
  })

  test("precedence: no-goal beats ephemeral (adjacent 3↔4 swap detector)", () => {
    // RED if guards 3 and 4 are swapped — reason would flip to "ephemeral-thread".
    const d = evaluateContinuation({
      ...ALL_PASS,
      goalStatusAtScan: null,
      goalStatusAtLaunch: null,
      ephemeralThread: true,
    })
    expect(d.skipReason).toBe("no-goal")
  })

  test("precedence: goal-not-active beats goal-changed (adjacent 9↔10 swap)", () => {
    // scan=paused (trips 9), launch=completed (would trip 10). Reason must be 9.
    // RED if 9↔10 swapped — reason would flip to "goal-changed".
    const d = evaluateContinuation({
      ...ALL_PASS,
      goalStatusAtScan: "paused",
      goalStatusAtLaunch: "completed",
    })
    expect(d.skipReason).toBe("goal-not-active")
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. goal-not-active — the whole closed enum minus "active"
// ═════════════════════════════════════════════════════════════════════════════

describe("evaluateContinuation — goal-not-active over the closed enum", () => {
  for (const status of NON_ACTIVE_STATUSES) {
    test(`scan status "${status}" → "goal-not-active"`, () => {
      // scan==launch==status (no scan-vs-launch delta) so ONLY the goal-not-
      // active guard can fire. RED if the `!== "active"` check (line 132) is
      // weakened to accept this status.
      const d = evaluateContinuation({
        ...ALL_PASS,
        goalStatusAtScan: status,
        goalStatusAtLaunch: status,
      })
      expect(d.launch).toBe(false)
      expect(d.skipReason).toBe("goal-not-active")
    })
  }

  test("paired control: scan==launch=='active' launches (not goal-not-active)", () => {
    // The ONLY difference from the rows above is status active → launch.
    const d = evaluateContinuation(ALL_PASS)
    expect(d.launch).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. goal-changed — active at scan, non-active at launch (distinct reason)
// ═════════════════════════════════════════════════════════════════════════════

describe("evaluateContinuation — goal-changed (scan-vs-launch distinction)", () => {
  for (const status of NON_ACTIVE_STATUSES) {
    test(`active→"${status}" between scan and launch → "goal-changed"`, () => {
      // scan active passes guard 9; launch non-active trips guard 10. Proves the
      // TWO distinct reads (scan vs launch) are compared independently.
      // RED if line 136 reads goalStatusAtScan instead of goalStatusAtLaunch —
      // it would then launch (scan is active).
      const d = evaluateContinuation({
        ...ALL_PASS,
        goalStatusAtScan: "active",
        goalStatusAtLaunch: status,
      })
      expect(d.launch).toBe(false)
      expect(d.skipReason).toBe("goal-changed")
    })
  }

  test("goal-changed is DISTINCT from goal-not-active", () => {
    // Same launch status "paused" but different scan status yields different
    // reasons — proving the two guards are not conflated.
    const changed = evaluateContinuation({
      ...ALL_PASS,
      goalStatusAtScan: "active",
      goalStatusAtLaunch: "paused",
    })
    const notActive = evaluateContinuation({
      ...ALL_PASS,
      goalStatusAtScan: "paused",
      goalStatusAtLaunch: "paused",
    })
    expect(changed.skipReason).toBe("goal-changed")
    expect(notActive.skipReason).toBe("goal-not-active")
    expect(changed.skipReason).not.toBe(notActive.skipReason)
  })

  test("paired control: active→active launches (no change)", () => {
    // Only difference from the goal-changed rows: launch stays active.
    const d = evaluateContinuation({
      ...ALL_PASS,
      goalStatusAtScan: "active",
      goalStatusAtLaunch: "active",
    })
    expect(d.launch).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. ContinuationSemaphore — single permit, idempotent release, ≤1 outstanding
// ═════════════════════════════════════════════════════════════════════════════

describe("ContinuationSemaphore — single-permit invariants", () => {
  test("single permit: 2nd tryAcquire is null while 1st is held", () => {
    // RED if #held is not set on acquire (line 160) — 2nd would also succeed.
    const sem = new ContinuationSemaphore()
    const p1 = sem.tryAcquire()
    const p2 = sem.tryAcquire()
    expect(p1).not.toBeNull()
    expect(p2).toBeNull()
  })

  test("release restores availability", () => {
    // RED if release() doesn't clear #held (line 166) — re-acquire would be null.
    const sem = new ContinuationSemaphore()
    const p1 = sem.tryAcquire()
    expect(p1).not.toBeNull()
    p1?.release()
    const p2 = sem.tryAcquire()
    expect(p2).not.toBeNull()
  })

  test("release is IDEMPOTENT: double-release never frees a 2nd permit", () => {
    // Core invariant: acquire → release → release must NOT leak. We then let a
    // DIFFERENT holder acquire; a STALE double-release of the first permit must
    // NOT free the new holder's permit.
    const sem = new ContinuationSemaphore()
    const first = sem.tryAcquire()
    expect(first).not.toBeNull()
    first?.release()
    first?.release() // stale double-release — must be a no-op (line 164 guard)

    // A different holder takes the (single) permit.
    const second = sem.tryAcquire()
    expect(second).not.toBeNull()

    // Now a THIRD stale release of `first` must not free `second`'s permit.
    // RED if release closes over the shared #held without a per-permit
    // `released` flag — the stale release would flip #held=false and a
    // concurrent acquire would wrongly succeed.
    first?.release()
    const stolen = sem.tryAcquire()
    expect(stolen).toBeNull() // second still holds the only permit
  })

  test("≤1 outstanding under interleaved acquire/release", () => {
    // Drive an interleaving and assert the permit is mutually exclusive at every
    // step. RED if #held bookkeeping is off by any path.
    const sem = new ContinuationSemaphore()
    const a = sem.tryAcquire()
    expect(a).not.toBeNull()
    expect(sem.tryAcquire()).toBeNull() // held by a
    a?.release()
    const b = sem.tryAcquire()
    expect(b).not.toBeNull()
    expect(sem.tryAcquire()).toBeNull() // held by b
    a?.release() // stale — must not free b's permit
    expect(sem.tryAcquire()).toBeNull() // still held by b
    b?.release()
    const c = sem.tryAcquire()
    expect(c).not.toBeNull() // free again
    c?.release()
  })

  test("per-permit release isolation: releasing an OLD permit can't free a NEW one", () => {
    // Distinct-holder isolation across a full cycle. Each permit's release only
    // affects the state IT set. RED if `released` were module/instance-scoped
    // instead of per-permit-closure.
    const sem = new ContinuationSemaphore()
    const p1 = sem.tryAcquire()
    p1?.release()
    const p2 = sem.tryAcquire() // p2 now holds
    expect(p2).not.toBeNull()
    p1?.release() // idempotent no-op on p1 — must not touch p2's permit
    expect(sem.tryAcquire()).toBeNull() // p2 still holds
    p2?.release()
    expect(sem.tryAcquire()).not.toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. runIdleContinuation — NO-THROW contract (every port/sink may throw)
// ═════════════════════════════════════════════════════════════════════════════

describe("runIdleContinuation — NO-THROW degradation contract", () => {
  test("throwing objective.get → {launched:false}, never throws", async () => {
    // readStatus swallows the throw → null status → no-goal skip, no crash.
    // RED if readStatus (line 288) drops its try/catch.
    const spy = makeResumeSpy()
    const deps = makeDeps({ objective: { get: boom }, resume: spy.resume })
    const r = await runIdleContinuation("t1", deps)
    expect(r.launched).toBe(false)
    expect(r.skipReason).toBe("no-goal")
    expect(spy.calls).toEqual([])
  })

  test("throwing idle probe → treated NOT-idle (blocks continuation)", async () => {
    // A throwing idle probe must NOT auto-continue. probeIdle catches → false →
    // not-idle skip. RED if probeIdle (line 296) returns true on throw or drops
    // the catch (would then crash → caught by outer → {launched:false} with NO
    // skipReason, which this assertion on "not-idle" would still catch).
    const spy = makeResumeSpy()
    const deps = makeDeps({ threadIdle: boom, resume: spy.resume })
    const r = await runIdleContinuation("t1", deps)
    expect(r.launched).toBe(false)
    expect(r.skipReason).toBe("not-idle")
    expect(spy.calls).toEqual([])
  })

  const throwingBlockingProbes: ReadonlyArray<{
    readonly name: string
    readonly reason: ContinuationSkipReason
    readonly override: Partial<ContinuationDeps>
  }> = [
    { name: "plan", reason: "plan-mode-active", override: { planModeActive: boom } },
    { name: "turn", reason: "turn-active", override: { turnActive: boom } },
    { name: "queue", reason: "queued-input", override: { queuedInputPending: boom } },
    { name: "mailbox", reason: "mailbox-input", override: { mailboxInputPending: boom } },
    { name: "ephemeral", reason: "ephemeral-thread", override: { isEphemeral: boom } },
  ]

  for (const { name, reason, override } of throwingBlockingProbes) {
    test(`throwing ${name} probe fails closed as ${reason}`, async () => {
      const spy = makeResumeSpy()
      const r = await runIdleContinuation("t1", makeDeps({ ...override, resume: spy.resume }))
      expect(r).toEqual({ launched: false, skipReason: reason })
      expect(spy.calls).toEqual([])
    })
  }

  test("throwing resume → {launched:false}, never throws", async () => {
    // resume throws inside the inner try; outer catch → {launched:false}.
    // RED if the outer try/catch (line 227/283) is removed — the throw escapes.
    const deps = makeDeps({ resume: async () => boom() })
    const r = await runIdleContinuation("t1", deps)
    expect(r.launched).toBe(false)
    // outer catch returns bare {launched:false} — no skipReason.
    expect(r.skipReason).toBeUndefined()
  })

  test("permit RELEASED in finally even when resume throws (2nd run still launches)", async () => {
    // Shared semaphore across two runs. Run 1 throws in resume; the finally
    // (line 280) must release the permit. Run 2 (clean resume) must therefore
    // still acquire and launch. RED if release is not in a finally — run 2
    // would hit "semaphore-busy".
    const sem = new ContinuationSemaphore()
    let throwOnce = true
    const calls: string[] = []
    const resume = async (threadId: string): Promise<void> => {
      if (throwOnce) {
        throwOnce = false
        throw new Error("first resume boom")
      }
      calls.push(threadId)
    }
    const deps = makeDeps({ semaphore: sem, resume })

    const r1 = await runIdleContinuation("t1", deps)
    expect(r1.launched).toBe(false) // resume threw

    const r2 = await runIdleContinuation("t1", deps)
    expect(r2.launched).toBe(true) // permit was freed → 2nd run launches
    expect(calls).toEqual(["t1"])
  })

  test("empty / non-string threadId → no-goal skip, no touch", async () => {
    // Guard at line 230. RED if the threadId validation is dropped.
    const spy = makeResumeSpy()
    const deps = makeDeps({ objective: { get: boom }, resume: spy.resume })
    const r = await runIdleContinuation("", deps)
    expect(r.launched).toBe(false)
    expect(r.skipReason).toBe("no-goal")
    expect(spy.calls).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. semaphore-busy — the single permit is already held
// ═════════════════════════════════════════════════════════════════════════════

describe("runIdleContinuation — semaphore-busy", () => {
  test("pre-held permit → skipReason 'semaphore-busy', resume not called", async () => {
    // Inject a semaphore with the single permit already taken. tryAcquire
    // returns null → line 262. RED if the null-check is dropped (would deref
    // null / launch anyway).
    const sem = new ContinuationSemaphore()
    const preHeld = sem.tryAcquire()
    expect(preHeld).not.toBeNull() // pre-condition: permit is now held
    const spy = makeResumeSpy()
    const deps = makeDeps({ semaphore: sem, resume: spy.resume })
    const r = await runIdleContinuation("t1", deps)
    expect(r.launched).toBe(false)
    expect(r.skipReason).toBe("semaphore-busy")
    expect(spy.calls).toEqual([])
  })

  test("paired control: after releasing the pre-held permit, it launches", async () => {
    // The ONLY difference from the case above is releasing the pre-held permit.
    const sem = new ContinuationSemaphore()
    const preHeld = sem.tryAcquire()
    preHeld?.release()
    const spy = makeResumeSpy()
    const deps = makeDeps({ semaphore: sem, resume: spy.resume })
    const r = await runIdleContinuation("t1", deps)
    expect(r.launched).toBe(true)
    expect(spy.calls).toEqual(["t1"])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 7. real resume side-effect — all guards pass + real store active goal
// ═════════════════════════════════════════════════════════════════════════════

describe("runIdleContinuation — real store, real resume side-effect", () => {
  test("all guards pass → resume invoked EXACTLY once with threadId; launched:true", async () => {
    // Uses the REAL createObjectiveStore (default informational) with an active
    // goal. Proves the end-to-end wire: scan read → guards → acquire → re-read →
    // resume. RED if resume (line 278) is not called or called with wrong arg.
    const store = createObjectiveStore()
    store.create("thread-A", { goal: "ship it" })
    expect(store.get("thread-A")?.status).toBe("active") // pre-condition

    const spy = makeResumeSpy()
    const deps = makeDeps({ objective: store, resume: spy.resume })
    const r = await runIdleContinuation("thread-A", deps)

    expect(r.launched).toBe(true)
    expect(r.skipReason).toBeUndefined()
    expect(spy.calls).toEqual(["thread-A"]) // exactly once, exact threadId
  })

  test("real store with paused goal → goal-not-active, resume NOT called", async () => {
    // Paired control against the case above: only the store status differs.
    // RED if the scan-status guard doesn't read the real store status.
    const store = createObjectiveStore()
    store.create("thread-B", { goal: "later" })
    store.setExplicitStatus("thread-B", "paused")
    expect(store.get("thread-B")?.status).toBe("paused")

    const spy = makeResumeSpy()
    const deps = makeDeps({ objective: store, resume: spy.resume })
    const r = await runIdleContinuation("thread-B", deps)

    expect(r.launched).toBe(false)
    expect(r.skipReason).toBe("goal-not-active")
    expect(spy.calls).toEqual([])
  })

  test("real store with NO goal for the thread → no-goal, resume NOT called", async () => {
    // Store exists but the thread has no objective → get() null → no-goal.
    const store = createObjectiveStore()
    store.create("other-thread", { goal: "unrelated" })
    expect(store.get("thread-C")).toBeNull()

    const spy = makeResumeSpy()
    const deps = makeDeps({ objective: store, resume: spy.resume })
    const r = await runIdleContinuation("thread-C", deps)

    expect(r.launched).toBe(false)
    expect(r.skipReason).toBe("no-goal")
    expect(spy.calls).toEqual([])
  })

  test("real store: goal-changed to blocked between scan and launch → goal-changed", async () => {
    // Inject an objective port that returns active on the FIRST get (scan) and
    // blocked on the SECOND (launch re-read) — proving the double-read wire.
    // RED if runIdleContinuation reuses the scan status instead of re-reading
    // (line 267) — it would launch.
    const active = {
      objectiveId: "obj-thread-D",
      createdBy: "system" as const,
      attempts: { autonomousTurnsStarted: 0 },
      threadId: "thread-D",
      goal: "g",
      successCriteria: [],
      status: "active" as ObjectiveStatus,
      budget: { tokensUsed: 0, turnsUsed: 0 },
      blockers: [],
      blockerObservations: [],
      nextActions: [],
      createdAt: 0,
      updatedAt: 0,
    }
    const blocked = { ...active, status: "blocked" as ObjectiveStatus }
    let reads = 0
    const spy = makeResumeSpy()
    const deps = makeDeps({
      objective: {
        get: () => {
          reads += 1
          return reads === 1 ? active : blocked
        },
      },
      resume: spy.resume,
    })
    const r = await runIdleContinuation("thread-D", deps)

    expect(reads).toBe(2) // scan + launch re-read
    expect(r.launched).toBe(false)
    expect(r.skipReason).toBe("goal-changed")
    expect(spy.calls).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 8. default-OFF — enabled:false is a hard, zero-touch short-circuit
// ═════════════════════════════════════════════════════════════════════════════

describe("default-OFF (enabled:false)", () => {
  test("evaluateContinuation → 'disabled'", () => {
    // RED if the `!input.enabled` guard (line 124) is removed/reordered.
    const d = evaluateContinuation({ ...ALL_PASS, enabled: false })
    expect(d.launch).toBe(false)
    expect(d.skipReason).toBe("disabled")
  })

  test("runIdleContinuation reads NO port and never calls resume (all thunks throw)", async () => {
    // Every port/probe/sink throws. If enabled:false short-circuits BEFORE any
    // read (line 229), none of them fire and we get a clean 'disabled' skip.
    // RED if the short-circuit is moved AFTER any port read — a throw would
    // surface (caught by outer → {launched:false} with NO skipReason, which
    // this assertion on "disabled" catches).
    const deps = makeDeps({
      enabled: false,
      objective: { get: boom },
      threadIdle: boom,
      planModeActive: boom,
      turnActive: boom,
      queuedInputPending: boom,
      mailboxInputPending: boom,
      isEphemeral: boom,
      now: boom,
      resume: async () => boom(),
    })
    const r = await runIdleContinuation("t1", deps)
    expect(r.launched).toBe(false)
    expect(r.skipReason).toBe("disabled")
  })

  test("default-OFF never acquires the semaphore (pre-held permit is irrelevant)", async () => {
    // If enabled:false truly short-circuits, a busy semaphore is never even
    // consulted — the reason is 'disabled', NOT 'semaphore-busy'. Proves the
    // ordering: disabled precedes the acquire (line 229 before line 261).
    const sem = new ContinuationSemaphore()
    sem.tryAcquire() // pre-hold the permit
    const deps = makeDeps({ enabled: false, semaphore: sem })
    const r = await runIdleContinuation("t1", deps)
    expect(r.skipReason).toBe("disabled")
    expect(r.skipReason).not.toBe("semaphore-busy")
  })
})
