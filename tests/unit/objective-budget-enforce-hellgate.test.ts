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
 * GOAL-01: usage is HOST-measured. The retired `recordUsage` self-report is
 * gone; the only debit is the system-actor `settleAttempt` mutation (one
 * attributed attempt ⇒ at most ONE turn). The tests below drive it through
 * `settleUsage` / `settleTurns` (tests/unit/objective/v2-helpers.ts).
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
import type { ObjectiveAttemptSettlement, ObjectivePort } from "@/objective"
import { asObjectiveAuthority, createObjectiveStore } from "@/objective"
import { objectiveUpdateSchema } from "@/tool/objective"
import { nextAttemptId, objectiveIdOf, settleTurns, settleUsage } from "./objective/v2-helpers"

const TID = "thread-budget"

const enforcingStore = (now = 1_000): ObjectivePort =>
  createObjectiveStore({ now: () => now, enforceBudget: true })
const informationalStore = (now = 1_000): ObjectivePort => createObjectiveStore({ now: () => now })

describe("HELLGATE [H17] — token budget exhaustion flips status", () => {
  test("under maxTokens ⇒ active; crossing the exact limit ⇒ budget_limited", () => {
    const store = enforcingStore()
    store.create(TID, { goal: "do work", budget: { maxTokens: 100 } })

    settleUsage(store, TID, { tokens: 99 })
    let o = store.get(TID)
    expect(o?.status).toBe("active") // 99 < 100
    expect(o?.budget.tokensUsed).toBe(99)

    settleUsage(store, TID, { tokens: 1 })
    o = store.get(TID)
    expect(o?.status).toBe("budget_limited") // 100 >= 100 (exact)
    expect(o?.budget.tokensUsed).toBe(100)

    settleUsage(store, TID, { tokens: 500 })
    o = store.get(TID)
    expect(o?.status).toBe("budget_limited") // stays limited well past
    expect(o?.budget.tokensUsed).toBe(600)
  })

  test("exact-boundary tokensUsed === maxTokens is limited (>= not >)", () => {
    const store = enforcingStore()
    store.create(TID, { goal: "g", budget: { maxTokens: 50 } })
    settleUsage(store, TID, { tokens: 50 })
    expect(store.get(TID)?.status).toBe("budget_limited")
  })
})

describe("HELLGATE [H17] — turn budget exhaustion flips status", () => {
  test("crossing maxTurns ⇒ budget_limited (independent of tokens)", () => {
    const store = enforcingStore()
    store.create(TID, { goal: "g", budget: { maxTurns: 3 } })
    settleTurns(store, TID, 2)
    expect(store.get(TID)?.status).toBe("active")
    settleTurns(store, TID, 1)
    expect(store.get(TID)?.status).toBe("budget_limited") // 3 >= 3
  })

  test("either cap independently triggers (token OR turn)", () => {
    const store = enforcingStore()
    store.create(TID, { goal: "g", budget: { maxTokens: 1000, maxTurns: 2 } })
    // tokens far under, turns at cap ⇒ limited
    settleUsage(store, TID, { tokens: 10 })
    settleTurns(store, TID, 2)
    const o = store.get(TID)
    expect(o?.budget.turnsUsed).toBe(2)
    expect(o?.status).toBe("budget_limited")
  })

  test("GOAL-01: one settlement debits at most ONE turn (host-attributed, never self-reported)", () => {
    const store = enforcingStore()
    store.create(TID, { goal: "g", budget: { maxTurns: 2 } })
    // A settlement claiming many turns still counts as one attributed attempt.
    settleUsage(store, TID, { turns: 9999 })
    expect(store.get(TID)?.budget.turnsUsed).toBe(1)
    expect(store.get(TID)?.status).toBe("active")
  })
})

describe("HELLGATE [H17] — no budget set ⇒ never limited", () => {
  test("settlement without any max* never flips status", () => {
    const store = enforcingStore()
    store.create(TID, { goal: "g" }) // no budget
    settleTurns(store, TID, 3, 1_000_000)
    const o = store.get(TID)
    expect(o?.budget.tokensUsed).toBe(1_000_000)
    expect(o?.budget.turnsUsed).toBe(3)
    expect(o?.status).toBe("active")
  })
})

describe("HELLGATE [H17] — knob OFF ⇒ informational only (byte-identical)", () => {
  test("default store never flips to budget_limited even when exceeded", () => {
    const store = informationalStore()
    store.create(TID, { goal: "g", budget: { maxTokens: 10, maxTurns: 1 } })
    settleUsage(store, TID, { tokens: 9999, turns: 1 })
    const o = store.get(TID)
    expect(o?.status).toBe("active") // informational — never limited
    expect(o?.budget.tokensUsed).toBe(9999) // still accounted, just not enforced
    expect(o?.budget.turnsUsed).toBe(1)
  })

  test("OFF status sequence is byte-identical to ADR-0394 derivation", () => {
    const off = informationalStore()
    off.create(TID, { goal: "g", budget: { maxTokens: 5 } })
    const seq: string[] = []
    settleUsage(off, TID, { tokens: 3 })
    seq.push(off.get(TID)?.status ?? "?")
    settleUsage(off, TID, { tokens: 3 })
    seq.push(off.get(TID)?.status ?? "?")
    expect(seq).toEqual(["active", "active"])
  })
})

describe("HELLGATE [H17] — raising the budget un-limits (no sticky flag)", () => {
  test("GOAL-01: amendBudget (same generation) raises the cap and releases budget_limited", () => {
    const store = enforcingStore()
    store.create(TID, { goal: "g", budget: { maxTokens: 100 } })
    const id = objectiveIdOf(store, TID)
    settleUsage(store, TID, { tokens: 100 })
    expect(store.get(TID)?.status).toBe("budget_limited")
    // Same-ID amendment: the cap moves, the ledger does NOT reset.
    const raised = store.amendBudget(TID, { maxTokens: 100_000 })
    expect(raised?.status).toBe("active")
    expect(raised?.objectiveId).toBe(id)
    expect(raised?.budget.tokensUsed).toBe(100)
  })

  test("GOAL-01: replace (a fresh generation) carries the higher cap and resets usage", () => {
    const store = enforcingStore()
    store.create(TID, { goal: "g", budget: { maxTokens: 100 } })
    const id = objectiveIdOf(store, TID)
    settleUsage(store, TID, { tokens: 100 })
    expect(store.get(TID)?.status).toBe("budget_limited")
    // GOAL-01: the legacy `set` overwrite is now an explicit `replace` — it mints
    // a NEW objectiveId and the ledger starts from zero.
    const raised = store.replace(TID, { goal: "g", budget: { maxTokens: 100_000 } })
    expect(raised?.status).toBe("active")
    expect(raised?.objectiveId).not.toBe(id)
    expect(raised?.budget.tokensUsed).toBe(0)
    // GOAL-01: `create` on a thread that already has an objective is refused
    // (`objective-exists`) and the live generation is untouched.
    // NOTE: pinned through the authority protocol — the `ObjectivePort.create`
    // surface currently echoes the EXISTING objective instead of the documented
    // `null` (src/objective/authority.ts `refused()` returns `core.get`), which
    // is reported as a src discrepancy, not papered over here.
    const auth = asObjectiveAuthority(store)
    const dup = auth.commit(
      auth.prepare({
        threadId: TID,
        actor: "system",
        mutation: { kind: "create", definition: { goal: "g2" } },
      }),
      { admitted: true },
    )
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.reason).toBe("objective-exists")
    expect(store.get(TID)?.goal).toBe("g")
    expect(store.get(TID)?.objectiveId).toBe(raised?.objectiveId ?? "")
  })
})

describe("HELLGATE [H17] — blockers still win over budget_limited", () => {
  test("a blocked + budget-exhausted objective reports blocked", () => {
    const store = enforcingStore()
    store.create(TID, { goal: "g", budget: { maxTokens: 10 } })
    settleUsage(store, TID, { tokens: 50 }) // exhausted
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
    const created = store.create(TID, {
      goal: "g",
      successCriteria: ["done"],
      budget: { maxTokens: 10 },
    })
    settleUsage(store, TID, { tokens: 20 })
    const cid = created?.successCriteria[0]?.id ?? ""
    const o = store.markCriterion(TID, cid, true)
    expect(o?.status).toBe("budget_limited")
  })
})

describe("HELLGATE [H17] — snapshot round-trip preserves enforcement", () => {
  test("fromSnapshot into an enforcing store re-derives budget_limited", () => {
    const src = enforcingStore()
    src.create(TID, { goal: "g", budget: { maxTokens: 10 } })
    settleUsage(src, TID, { tokens: 20 })
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

describe("HELLGATE [H17] / GOAL-01 — usage is host-measured, never self-reported", () => {
  test("REVERSED: the `objective_update` tool has NO `recordUsage` op (zod rejects it)", () => {
    // GOAL-01: the model's self-report op was removed from the tool schema. A
    // model can no longer inflate (or starve) its own budget ledger.
    const parsed = objectiveUpdateSchema.safeParse({
      thread_id: TID,
      op: { kind: "recordUsage", tokens: 100, turns: 1 },
    })
    expect(parsed.success).toBe(false)
  })

  test("a MODEL actor cannot settle an attempt (actor-forbidden); the SYSTEM actor can", () => {
    const store = enforcingStore()
    store.create(TID, { goal: "g", budget: { maxTokens: 10 } })
    const auth = asObjectiveAuthority(store)
    const settlement: ObjectiveAttemptSettlement = {
      objectiveId: objectiveIdOf(store, TID),
      attemptId: nextAttemptId(),
      startedRevision: auth.readDomain(TID).revision,
      tokensUsed: 10,
      turnsUsed: 1,
      outcome: "completed",
      executionMode: "foreground",
      criterionIdsBefore: [],
      verifierReceiptIdsBefore: [],
      recordedAt: 0,
    }
    const asModel = auth.commit(
      auth.prepare({
        threadId: TID,
        actor: "model",
        mutation: { kind: "settleAttempt", settlement },
      }),
      { admitted: true },
    )
    expect(asModel.ok).toBe(false)
    if (!asModel.ok) expect(asModel.reason).toBe("actor-forbidden")
    expect(store.get(TID)?.budget.tokensUsed).toBe(0)
    expect(store.get(TID)?.status).toBe("active")

    // Host settlement still derives budget_limited under enforceBudget: true.
    const asSystem = settleUsage(store, TID, { tokens: 10, turns: 1 })
    expect(asSystem.ok).toBe(true)
    expect(store.get(TID)?.budget.tokensUsed).toBe(10)
    expect(store.get(TID)?.status).toBe("budget_limited")
  })

  test("a replayed attemptId is refused (attempt-replayed) — the ledger is debited exactly once", () => {
    const store = enforcingStore()
    store.create(TID, { goal: "g", budget: { maxTokens: 100 } })
    const attemptId = nextAttemptId()
    expect(settleUsage(store, TID, { tokens: 40 }, { attemptId }).ok).toBe(true)
    const replay = settleUsage(store, TID, { tokens: 40 }, { attemptId })
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.reason).toBe("attempt-replayed")
    expect(store.get(TID)?.budget.tokensUsed).toBe(40)
    expect(store.get(TID)?.status).toBe("active")
  })
})
