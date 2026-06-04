/**
 * HELLGATE — feature H17: thread-goal BUDGET ENFORCEMENT.
 *
 * ADR-0394 shipped `ObjectiveBudget { maxTokens?, maxTurns?, tokensUsed,
 * turnsUsed }` as STORED-but-never-read informational state. This wave makes
 * the budget a HARD GATE: when enforcement is enabled and the active
 * objective's accumulated `tokensUsed >= maxTokens` (or `turnsUsed >=
 * maxTurns`), the derived status flips to `"budget_limited"` and the
 * idle-continuation must NOT re-issue `setNextActions` on the exhausted goal.
 *
 * Enforcement is a CONSTRUCTION-TIME store option (`enforceBudget`) wired by
 * the host/loop from the `QUANTA_OBJECTIVE_BUDGET_ENFORCE` knob. The store
 * never reads env (slice fence). Default (OFF) ⇒ budget stays informational ⇒
 * status NEVER flips ⇒ byte-identical to ADR-0394.
 *
 * STATE MACHINE (total function over the cell):
 *   1. blockers.length > 0               ⇒ "blocked"        (highest priority)
 *   2. enforceBudget ∧ budget exceeded   ⇒ "budget_limited"
 *   3. else all criteria met (>=1)       ⇒ "completed"
 *   4. else                              ⇒ explicit value (default "active")
 *
 * "exceeded" = (maxTokens set ∧ tokensUsed >= maxTokens)
 *            ∨ (maxTurns  set ∧ turnsUsed  >= maxTurns).
 * No budget set ⇒ never exceeded ⇒ never limited. Comparison is EXACT (>=);
 * no arbitrary thresholds. Raising/resetting the budget un-limits (the derive
 * is a pure function of the current cell — no sticky flag).
 */
import { describe, expect, test } from "bun:test"
import type { ObjectivePort } from "@/agent/objective"
import { createObjectiveStore } from "@/agent/objective"

const TID = "thread-budget"

const enforcingStore = (now = 1_000): ObjectivePort =>
  createObjectiveStore({ now: () => now, enforceBudget: true })
const informationalStore = (now = 1_000): ObjectivePort => createObjectiveStore({ now: () => now })

describe("HELLGATE [H17] — token budget exhaustion flips status", () => {
  test("under maxTokens ⇒ active; crossing the exact limit ⇒ budget_limited", () => {
    const store = enforcingStore()
    store.set(TID, { goal: "do work", budget: { maxTokens: 100 } })

    let o = store.recordUsage(TID, { tokens: 99 })
    expect(o?.status).toBe("active") // 99 < 100
    expect(o?.budget.tokensUsed).toBe(99)

    o = store.recordUsage(TID, { tokens: 1 })
    expect(o?.status).toBe("budget_limited") // 100 >= 100 (exact)
    expect(o?.budget.tokensUsed).toBe(100)

    o = store.recordUsage(TID, { tokens: 500 })
    expect(o?.status).toBe("budget_limited") // stays limited well past
    expect(o?.budget.tokensUsed).toBe(600)
  })

  test("exact-boundary tokensUsed === maxTokens is limited (>= not >)", () => {
    const store = enforcingStore()
    store.set(TID, { goal: "g", budget: { maxTokens: 50 } })
    const o = store.recordUsage(TID, { tokens: 50 })
    expect(o?.status).toBe("budget_limited")
  })
})

describe("HELLGATE [H17] — turn budget exhaustion flips status", () => {
  test("crossing maxTurns ⇒ budget_limited (independent of tokens)", () => {
    const store = enforcingStore()
    store.set(TID, { goal: "g", budget: { maxTurns: 3 } })
    expect(store.recordUsage(TID, { turns: 2 })?.status).toBe("active")
    expect(store.recordUsage(TID, { turns: 1 })?.status).toBe("budget_limited") // 3 >= 3
  })

  test("either cap independently triggers (token OR turn)", () => {
    const store = enforcingStore()
    store.set(TID, { goal: "g", budget: { maxTokens: 1000, maxTurns: 2 } })
    // tokens far under, turns at cap ⇒ limited
    store.recordUsage(TID, { tokens: 10 })
    const o = store.recordUsage(TID, { turns: 2 })
    expect(o?.status).toBe("budget_limited")
  })
})

describe("HELLGATE [H17] — no budget set ⇒ never limited", () => {
  test("recordUsage without any max* never flips status", () => {
    const store = enforcingStore()
    store.set(TID, { goal: "g" }) // no budget
    const o = store.recordUsage(TID, { tokens: 1_000_000, turns: 9999 })
    expect(o?.status).toBe("active")
  })
})

describe("HELLGATE [H17] — knob OFF ⇒ informational only (byte-identical)", () => {
  test("default store never flips to budget_limited even when exceeded", () => {
    const store = informationalStore()
    store.set(TID, { goal: "g", budget: { maxTokens: 10, maxTurns: 1 } })
    const o = store.recordUsage(TID, { tokens: 9999, turns: 9999 })
    expect(o?.status).toBe("active") // informational — never limited
    expect(o?.budget.tokensUsed).toBe(9999) // still accounted, just not enforced
  })

  test("OFF status sequence is byte-identical to ADR-0394 derivation", () => {
    const off = informationalStore()
    off.set(TID, { goal: "g", budget: { maxTokens: 5 } })
    const seq: string[] = []
    seq.push(off.recordUsage(TID, { tokens: 3 })?.status ?? "?")
    seq.push(off.recordUsage(TID, { tokens: 3 })?.status ?? "?")
    expect(seq).toEqual(["active", "active"])
  })
})

describe("HELLGATE [H17] — raising the budget un-limits (no sticky flag)", () => {
  test("re-set with a higher maxTokens releases budget_limited", () => {
    const store = enforcingStore()
    store.set(TID, { goal: "g", budget: { maxTokens: 100 } })
    expect(store.recordUsage(TID, { tokens: 100 })?.status).toBe("budget_limited")
    // Raise the cap above current usage ⇒ active again (set replaces the cell,
    // so re-declare carrying the higher cap; usage resets on a fresh set).
    const raised = store.set(TID, { goal: "g", budget: { maxTokens: 100000 } })
    expect(raised.status).toBe("active")
  })
})

describe("HELLGATE [H17] — blockers still win over budget_limited", () => {
  test("a blocked + budget-exhausted objective reports blocked", () => {
    const store = enforcingStore()
    store.set(TID, { goal: "g", budget: { maxTokens: 10 } })
    store.recordUsage(TID, { tokens: 50 }) // exhausted
    const o = store.addBlocker(TID, { reason: "need user", waitingOn: "user" })
    expect(o?.status).toBe("blocked") // blocker is highest priority
    // clearing the blocker falls back to budget_limited (not active)
    const cleared = store.clearBlocker(TID, o?.blockers[0]?.id ?? "")
    expect(cleared?.status).toBe("budget_limited")
  })
})

describe("HELLGATE [H17] — budget_limited outranks completed", () => {
  test("all criteria met but budget exhausted ⇒ budget_limited", () => {
    const store = enforcingStore()
    const set = store.set(TID, {
      goal: "g",
      successCriteria: ["done"],
      budget: { maxTokens: 10 },
    })
    store.recordUsage(TID, { tokens: 20 })
    const cid = set.successCriteria[0]?.id ?? ""
    const o = store.markCriterion(TID, cid, true)
    expect(o?.status).toBe("budget_limited")
  })
})

describe("HELLGATE [H17] — snapshot round-trip preserves enforcement", () => {
  test("fromSnapshot into an enforcing store re-derives budget_limited", () => {
    const src = enforcingStore()
    src.set(TID, { goal: "g", budget: { maxTokens: 10 } })
    src.recordUsage(TID, { tokens: 20 })
    const snap = src.toSnapshot()

    const dst = createObjectiveStore({ now: () => 2_000, enforceBudget: true })
    dst.fromSnapshot(snap)
    expect(dst.get(TID)?.status).toBe("budget_limited")

    // Same snapshot into a NON-enforcing store ⇒ informational (active).
    const dstOff = createObjectiveStore({ now: () => 2_000 })
    dstOff.fromSnapshot(snap)
    expect(dstOff.get(TID)?.status).toBe("active")
  })
})
