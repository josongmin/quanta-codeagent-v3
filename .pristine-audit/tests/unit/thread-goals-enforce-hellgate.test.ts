/**
 * HELLGATE — feature H17 (FULL): thread-goal 6-state ENFORCEMENT machine +
 * idle goal-continuation (semaphore-gated, Codex-guarded).
 *
 * ADR-0394 shipped a 3-state objective (`active|blocked|completed`) with the
 * budget purely informational. A first H17 wave added a 4th DERIVED state
 * `budget_limited` (hard-stop on the goal's own token/turn cap). This wave
 * completes the Codex `core/src/goals.rs` state machine:
 *
 *   active | paused | usage_limited | budget_limited | completed | blocked
 *
 * NEW states:
 *   - `paused`        — EXPLICIT caller intent (like active/completed). A
 *                       paused goal does NOT auto-resume on idle.
 *   - `usage_limited` — DERIVED transient limit that AUTO-RESETS. Unlike
 *                       `budget_limited` (the goal's own hard cap), this models
 *                       an external usage/rate window: while `now <
 *                       usageLimitedUntil` the derived status is
 *                       `usage_limited`; once the clock passes the window the
 *                       status re-derives back to `active` (no sticky flag).
 *
 * Derivation priority (TOTAL function over the cell + injected clock):
 *   1. blockers.length > 0                       ⇒ blocked        (highest)
 *   2. enforce ∧ now < usageLimitedUntil         ⇒ usage_limited
 *   3. enforce ∧ budget exhausted (>= cap)       ⇒ budget_limited
 *   4. all criteria met (>=1)                    ⇒ completed
 *   5. else                                      ⇒ explicit (active|paused)
 *
 * IDLE CONTINUATION — `evaluateContinuation` is a PURE decision: when a thread
 * is idle with an `active` goal it returns `launch`; otherwise one of the
 * Codex guards (verbatim reasons). A single-permit SEMAPHORE serializes
 * launches so only ONE continuation runs at a time.
 *
 * Default-OFF byte-identical: absent enforcement ⇒ status never takes the new
 * derived values; absent continuation config ⇒ no continuation ever launches.
 */
import { describe, expect, test } from "bun:test"
import type { ObjectivePort } from "@/agent/objective"
import { createObjectiveStore } from "@/agent/objective"
import {
  ContinuationSemaphore,
  evaluateContinuation,
  type GoalContinuationInput,
} from "@/agent/objective/continuation"

const TID = "thread-h17"

const enforcingStore = (now: () => number): ObjectivePort =>
  createObjectiveStore({ now, enforceBudget: true })

// ─────────────────────────────────────────────────────────────────────────────
// 6-STATE STORE MACHINE
// ─────────────────────────────────────────────────────────────────────────────

describe("HELLGATE [H17] — 6-state status machine", () => {
  test("budget exceeded ⇒ budget_limited (hard-stop)", () => {
    const t = 1_000
    const store = enforcingStore(() => t)
    store.set(TID, { goal: "g", budget: { maxTokens: 100 } })
    store.recordUsage(TID, { tokens: 99 })
    expect(store.get(TID)?.status).toBe("active")
    store.recordUsage(TID, { tokens: 1 }) // exactly hits the cap
    expect(store.get(TID)?.status).toBe("budget_limited")
  })

  test("usage_limited window ⇒ usage_limited; window reset ⇒ back to active", () => {
    let t = 1_000
    const store = enforcingStore(() => t)
    store.set(TID, { goal: "g" })
    // host marks a transient usage limit until t=5000
    const limited = store.markUsageLimited(TID, 5_000)
    expect(limited?.status).toBe("usage_limited")
    // before the window resets, still limited
    t = 4_999
    expect(store.get(TID)?.status).toBe("usage_limited")
    // window resets — auto-transition back to active (no explicit call)
    t = 5_000
    expect(store.get(TID)?.status).toBe("active")
  })

  test("paused is an EXPLICIT intent — survives until cleared, no auto-resume eligibility", () => {
    let t = 1_000
    const store = enforcingStore(() => t)
    store.set(TID, { goal: "g" })
    expect(store.get(TID)?.status).toBe("active")
    store.updateStatus(TID, "paused")
    expect(store.get(TID)?.status).toBe("paused")
    t = 9_999_999
    expect(store.get(TID)?.status).toBe("paused")
    store.updateStatus(TID, "active")
    expect(store.get(TID)?.status).toBe("active")
  })

  test("priority — blockers outrank usage_limited outranks budget_limited outranks completed", () => {
    const t = 1_000
    const store = enforcingStore(() => t)
    store.set(TID, { goal: "g", successCriteria: ["c"], budget: { maxTokens: 1 } })
    store.recordUsage(TID, { tokens: 1 }) // exhausted
    store.markCriterion(TID, store.get(TID)!.successCriteria[0]!.id, true) // all met
    // budget_limited outranks completed
    expect(store.get(TID)?.status).toBe("budget_limited")
    // usage_limited outranks budget_limited
    store.markUsageLimited(TID, 5_000)
    expect(store.get(TID)?.status).toBe("usage_limited")
    // blockers outrank everything
    store.addBlocker(TID, { reason: "x", waitingOn: "user" })
    expect(store.get(TID)?.status).toBe("blocked")
  })

  test("DEFAULT-OFF byte-identical — informational store never produces new derived states", () => {
    let t = 1_000
    const store = createObjectiveStore({ now: () => t }) // enforceBudget defaults false
    store.set(TID, { goal: "g", budget: { maxTokens: 1 } })
    store.recordUsage(TID, { tokens: 100 }) // way over
    store.markUsageLimited(TID, 5_000) // no-op under informational store
    expect(store.get(TID)?.status).toBe("active")
    t = 1 // even inside the would-be window
    expect(store.get(TID)?.status).toBe("active")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IDLE CONTINUATION — guards + launch
// ─────────────────────────────────────────────────────────────────────────────

/** A baseline input where the continuation SHOULD launch (idle + active goal,
 *  nothing blocking). Each guard test perturbs exactly ONE field. */
const baseInput = (over: Partial<GoalContinuationInput> = {}): GoalContinuationInput => ({
  enabled: true,
  threadIdle: true,
  goalStatusAtScan: "active",
  goalStatusAtLaunch: "active",
  planModeActive: false,
  turnActive: false,
  queuedInputPending: false,
  mailboxInputPending: false,
  ephemeralThread: false,
  ...over,
})

describe("HELLGATE [H17] — idle continuation launches", () => {
  test("idle + active goal ⇒ launch", () => {
    expect(evaluateContinuation(baseInput()).launch).toBe(true)
  })
})

describe("HELLGATE [H17] — EACH guard blocks continuation (one test per guard)", () => {
  test("config OFF ⇒ skip (default-OFF byte-identical)", () => {
    const d = evaluateContinuation(baseInput({ enabled: false }))
    expect(d.launch).toBe(false)
    expect(d.skipReason).toBe("disabled")
  })

  test("plan mode active ⇒ skip", () => {
    const d = evaluateContinuation(baseInput({ planModeActive: true }))
    expect(d.launch).toBe(false)
    expect(d.skipReason).toBe("plan-mode-active")
  })

  test("a turn is already active ⇒ skip", () => {
    const d = evaluateContinuation(baseInput({ turnActive: true }))
    expect(d.launch).toBe(false)
    expect(d.skipReason).toBe("turn-active")
  })

  test("queued input exists ⇒ skip", () => {
    const d = evaluateContinuation(baseInput({ queuedInputPending: true }))
    expect(d.launch).toBe(false)
    expect(d.skipReason).toBe("queued-input")
  })

  test("mailbox input pending ⇒ skip", () => {
    const d = evaluateContinuation(baseInput({ mailboxInputPending: true }))
    expect(d.launch).toBe(false)
    expect(d.skipReason).toBe("mailbox-input")
  })

  test("no goal set ⇒ skip", () => {
    const d = evaluateContinuation(baseInput({ goalStatusAtScan: null }))
    expect(d.launch).toBe(false)
    expect(d.skipReason).toBe("no-goal")
  })

  test("goal not active (budget_limited) ⇒ skip", () => {
    const d = evaluateContinuation(baseInput({ goalStatusAtScan: "budget_limited" }))
    expect(d.launch).toBe(false)
    expect(d.skipReason).toBe("goal-not-active")
  })

  test("ephemeral thread ⇒ skip", () => {
    const d = evaluateContinuation(baseInput({ ephemeralThread: true }))
    expect(d.launch).toBe(false)
    expect(d.skipReason).toBe("ephemeral-thread")
  })

  test("goal changed before launch ⇒ skip", () => {
    const d = evaluateContinuation(
      baseInput({ goalStatusAtScan: "active", goalStatusAtLaunch: "budget_limited" }),
    )
    expect(d.launch).toBe(false)
    expect(d.skipReason).toBe("goal-changed")
  })

  test("thread not idle ⇒ skip", () => {
    const d = evaluateContinuation(baseInput({ threadIdle: false }))
    expect(d.launch).toBe(false)
    expect(d.skipReason).toBe("not-idle")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SEMAPHORE — single permit
// ─────────────────────────────────────────────────────────────────────────────

describe("HELLGATE [H17] — single-permit continuation semaphore", () => {
  test("a second concurrent acquire is refused until the first releases", () => {
    const sem = new ContinuationSemaphore()
    const a = sem.tryAcquire()
    expect(a).not.toBeNull()
    // second acquire while the first is held ⇒ refused
    expect(sem.tryAcquire()).toBeNull()
    // release the first permit
    a!.release()
    // now a fresh acquire succeeds
    const b = sem.tryAcquire()
    expect(b).not.toBeNull()
    b!.release()
  })

  test("double-release is idempotent (no extra permits leak)", () => {
    const sem = new ContinuationSemaphore()
    const a = sem.tryAcquire()!
    a.release()
    a.release() // idempotent
    const b = sem.tryAcquire()
    expect(b).not.toBeNull()
    // still single-permit after the buggy double-release
    expect(sem.tryAcquire()).toBeNull()
    b!.release()
  })
})
