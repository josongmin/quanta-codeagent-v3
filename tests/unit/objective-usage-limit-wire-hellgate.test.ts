/**
 * HELLGATE leaf-units for RFC-06 A4.3 `applyMeasuredUsageLimit` — the pure
 * 429-retry-after → objective usage-window adapter. Every branch is exercised
 * with an OBSERVABLE effect (real store mutation / real derived status), and
 * each guard has a red-on-injection companion (the test would FAIL if the guard
 * were removed).
 *
 * Contract pinned here:
 *   - epoch = now() + retryAfterMs (a DELTA), derives usage_limited until then.
 *   - undefined / non-finite / non-positive retryAfterMs ⇒ no-op (no window).
 *   - unknown thread / empty threadId ⇒ no-op.
 *   - NO-RESURRECT: paused / completed / blocked / budget_limited ⇒ untouched.
 *   - re-arm: active AND already-usage_limited MAY be (re)limited.
 *   - NO-DOUBLE-COUNT: the host-settled usage ledger is never touched.
 *   - overflow (until non-finite) ⇒ no-op (never accidentally CLEARS).
 *
 * GOAL-01: fixtures only — `set` → `create`, `updateStatus("paused")` →
 * `setExplicitStatus("paused")`, `recordUsage` → host `settleTurns`. The wire
 * itself is unchanged.
 */
import { describe, expect, test } from "bun:test"
import { createObjectiveStore } from "@/objective"
import { applyMeasuredUsageLimit } from "@/objective/usage-limit-wire"
import { settleTurns } from "./objective/v2-helpers"

const TID = "t"

/** An ENFORCING store on an injected clock, so derived status is observable. */
const enforcing = (t: number) => {
  let clock = t
  const store = createObjectiveStore({ now: () => clock, enforceBudget: true })
  return { store, set: (n: number) => (clock = n), get: () => clock }
}

describe("applyMeasuredUsageLimit — epoch + derived transition", () => {
  test("active + finite delta ⇒ usage_limited until now+delta; past epoch ⇒ active", () => {
    const h = enforcing(1000)
    h.store.create(TID, { goal: "g" })
    expect(h.store.get(TID)?.status).toBe("active")

    const set = applyMeasuredUsageLimit(h.store, TID, 5000, () => h.get())
    expect(set).toBe(true)
    // Epoch = 1000 + 5000 = 6000. Before ⇒ usage_limited; at/after ⇒ active.
    expect(h.store.get(TID)?.status).toBe("usage_limited")
    h.set(5999)
    expect(h.store.get(TID)?.status).toBe("usage_limited")
    h.set(6000) // equality is the RESET instant (now === until ⇒ window elapsed)
    expect(h.store.get(TID)?.status).toBe("active")
  })

  test(
    "RED-ON-INJECTION (epoch basis): a naive impl that stamped `retryAfterMs` " +
      "as an ABSOLUTE epoch (not a delta) would derive active immediately — the " +
      "delta semantics are load-bearing",
    () => {
      const h = enforcing(1000)
      h.store.create(TID, { goal: "g" })
      // delta 5000 with clock 1000 ⇒ epoch 6000 (future). If the impl wrote 5000
      // as the epoch, then at clock 1000 the window (1000<5000) would still be
      // active BUT it would EXPIRE at 5000 — 1000ms EARLY. Assert the correct
      // 6000 boundary: at 5000 it must STILL be limited (proves delta, not abs).
      applyMeasuredUsageLimit(h.store, TID, 5000, () => h.get())
      h.set(5000)
      expect(h.store.get(TID)?.status).toBe("usage_limited") // 5000 < 6000
    },
  )
})

describe("applyMeasuredUsageLimit — guards (each with red-on-injection)", () => {
  test("undefined delta ⇒ no-op (429 without retry-after has no epoch)", () => {
    const h = enforcing(1000)
    h.store.create(TID, { goal: "g" })
    expect(applyMeasuredUsageLimit(h.store, TID, undefined, () => h.get())).toBe(false)
    expect(h.store.get(TID)?.status).toBe("active")
  })

  test("non-finite / non-positive delta ⇒ no-op (NaN, Infinity, 0, negative)", () => {
    const h = enforcing(1000)
    h.store.create(TID, { goal: "g" })
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(applyMeasuredUsageLimit(h.store, TID, bad, () => h.get())).toBe(false)
    }
    expect(h.store.get(TID)?.status).toBe("active")
  })

  test("unknown thread ⇒ no-op (get returns null)", () => {
    const h = enforcing(1000)
    // no create() — the thread does not exist
    expect(applyMeasuredUsageLimit(h.store, "ghost", 5000, () => h.get())).toBe(false)
    expect(h.store.get("ghost")).toBeNull()
  })

  test("empty threadId ⇒ no-op", () => {
    const h = enforcing(1000)
    h.store.create(TID, { goal: "g" })
    expect(applyMeasuredUsageLimit(h.store, "", 5000, () => h.get())).toBe(false)
  })

  test("NO-RESURRECT: paused ⇒ untouched (stays paused, not usage_limited)", () => {
    const h = enforcing(1000)
    h.store.create(TID, { goal: "g" })
    h.store.setExplicitStatus(TID, "paused")
    expect(h.store.get(TID)?.status).toBe("paused")
    expect(applyMeasuredUsageLimit(h.store, TID, 5000, () => h.get())).toBe(false)
    // RED-ON-INJECTION: if the guard were dropped, derive priority (usage_limited
    // > paused's explicit) would flip this to usage_limited.
    expect(h.store.get(TID)?.status).toBe("paused")
  })

  test("NO-RESURRECT: completed ⇒ untouched (stays completed)", () => {
    const h = enforcing(1000)
    // GOAL-01: `completed` is DERIVED only — reached by marking every criterion
    // met (there is no explicit completed intent).
    h.store.create(TID, { goal: "g", successCriteria: ["done"] })
    const crit = h.store.get(TID)?.successCriteria[0]?.id ?? ""
    h.store.markCriterion(TID, crit, true)
    expect(h.store.get(TID)?.status).toBe("completed")
    expect(applyMeasuredUsageLimit(h.store, TID, 5000, () => h.get())).toBe(false)
    // RED-ON-INJECTION: derive priority (usage_limited > completed) would
    // mis-report a FINISHED goal as merely throttled without the guard.
    expect(h.store.get(TID)?.status).toBe("completed")
  })

  test("NO-RESURRECT: blocked ⇒ untouched (blocked wins regardless, but no window set)", () => {
    const h = enforcing(1000)
    h.store.create(TID, { goal: "g" })
    h.store.addBlocker(TID, { reason: "waiting", waitingOn: "user" })
    expect(h.store.get(TID)?.status).toBe("blocked")
    expect(applyMeasuredUsageLimit(h.store, TID, 5000, () => h.get())).toBe(false)
    // No window set: clearing the blocker reveals `active` (not a latent window).
    const bid = h.store.get(TID)?.blockers[0]?.id ?? ""
    h.store.clearBlocker(TID, bid)
    expect(h.store.get(TID)?.status).toBe("active")
  })

  test("RE-ARM: an already usage_limited objective MAY be extended", () => {
    const h = enforcing(1000)
    h.store.create(TID, { goal: "g" })
    applyMeasuredUsageLimit(h.store, TID, 5000, () => h.get()) // epoch 6000
    expect(h.store.get(TID)?.status).toBe("usage_limited")
    // A SECOND 429 at clock 3000 with a longer delta extends to 3000+10000=13000.
    h.set(3000)
    expect(applyMeasuredUsageLimit(h.store, TID, 10_000, () => h.get())).toBe(true)
    h.set(6001) // past the FIRST epoch — must still be limited (extended).
    expect(h.store.get(TID)?.status).toBe("usage_limited")
    h.set(13_001)
    expect(h.store.get(TID)?.status).toBe("active")
  })

  test("NO-DOUBLE-COUNT: the host-settled usage ledger is untouched by the window mark", () => {
    const h = enforcing(1000)
    h.store.create(TID, { goal: "g", budget: { maxTokens: 100 } })
    settleTurns(h.store, TID, 2, 30) // GOAL-01: host settlement (2 attempts, 30 tokens)
    expect(h.store.get(TID)?.budget.tokensUsed).toBe(30)
    expect(h.store.get(TID)?.budget.turnsUsed).toBe(2)
    applyMeasuredUsageLimit(h.store, TID, 5000, () => h.get())
    const b = h.store.get(TID)?.budget
    expect(b?.tokensUsed).toBe(30) // unchanged — no token added
    expect(b?.turnsUsed).toBe(2)
  })

  test("overflow: MAX_SAFE clock + delta ⇒ non-finite epoch ⇒ no-op (never clears)", () => {
    const h = enforcing(Number.MAX_SAFE_INTEGER)
    h.store.create(TID, { goal: "g" })
    // First arm a real window at a sane clock so we can prove overflow does not
    // CLEAR it (markUsageLimited(non-finite) would clear).
    applyMeasuredUsageLimit(h.store, TID, 5000, () => 1000) // epoch 6000
    // Now an overflowing call must be a no-op, NOT clear the window.
    expect(applyMeasuredUsageLimit(h.store, TID, Number.MAX_VALUE, () => Number.MAX_VALUE)).toBe(
      false,
    )
    // Window still present: at clock 5999 (< 6000) still limited.
    h.set(5999)
    expect(h.store.get(TID)?.status).toBe("usage_limited")
  })

  test("INFORMATIONAL store: window set but never DERIVES usage_limited", () => {
    const clock = 1000
    const store = createObjectiveStore({ now: () => clock }) // enforce OFF
    store.create(TID, { goal: "g" })
    // The adapter still WRITES the window (the host gate — not this pure fn —
    // owns default-OFF), but the informational store renders it inert.
    expect(applyMeasuredUsageLimit(store, TID, 5000, () => clock)).toBe(true)
    expect(store.get(TID)?.status).toBe("active") // never usage_limited without enforce
  })
})
