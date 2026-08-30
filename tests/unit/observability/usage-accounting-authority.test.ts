/**
 * MR-02 hellgate — the session's accounting authority.
 *
 * Three properties, each of which the previous accountant got wrong:
 *
 *   1. Bounding the record log must not move a single dollar. The ledger this
 *      replaces recomputed aggregates from the retained slice, so $30 of spend
 *      reported as $12 once eviction kicked in — and a hard ceiling compared
 *      against that shrunken total never fired.
 *   2. The same model call recorded twice bills once. Retries and racing sinks
 *      are normal; double-billing is not.
 *   3. Spend is attributable. "How much did the subagents cost" has to be
 *      answerable from the snapshot, because that is the question every
 *      surprising bill turns into.
 */
import { describe, expect, test } from "bun:test"
import { MODEL_RATE_CARD, PRICING_VERSION } from "@/observability/pricing"
import {
  createUsageAccounting,
  normalizeUsage,
  priceUsage,
  type UsageRecord,
} from "@/observability/usage-accounting"

const priceOpts = { pricingVersion: PRICING_VERSION }

/** One $3 sonnet call (1M input @ $3/M), attributed. */
const call = (
  callId: string,
  over: {
    model?: string
    inputTokens?: number
    outputTokens?: number
    cacheWriteTokens?: number
    agentId?: string
    agentKind?: "root" | "subagent"
    sessionId?: string
    fallbackModel?: string
  } = {},
): UsageRecord => {
  const usage = normalizeUsage({
    model: over.model ?? "claude-sonnet-4-6",
    inputTokens: over.inputTokens ?? 1_000_000,
    outputTokens: over.outputTokens ?? 0,
    ...(over.cacheWriteTokens !== undefined ? { cacheWriteTokens: over.cacheWriteTokens } : {}),
  })
  return {
    callId,
    at: 1_700_000_000_000,
    usage,
    cost: priceUsage(usage, MODEL_RATE_CARD, {
      ...priceOpts,
      ...(over.fallbackModel !== undefined ? { fallbackModel: over.fallbackModel } : {}),
    }),
    provenance: {
      sessionId: over.sessionId ?? "sess-1",
      agentId: over.agentId ?? "root",
      agentKind: over.agentKind ?? "root",
      depth: over.agentKind === "subagent" ? 1 : 0,
      ...(over.agentKind === "subagent" ? { parentAgentId: "root" } : {}),
    },
  }
}

describe("retention bounds the log, never the accounting", () => {
  test("the total is unmoved by eviction", () => {
    const acct = createUsageAccounting({ maxRetainedRecords: 4 })
    for (let i = 0; i < 10; i++) acct.record(call(`c${i}`))

    const snap = acct.snapshot()
    expect(snap.retained).toBe(4) // eviction really happened
    expect(snap.calls).toBe(10) // …and the counter still knows about all ten
    expect(snap.totalUsd).toBeCloseTo(30, 9) // 10 × $3, not the retained 4 × $3
    expect(snap.byModel.get("claude-sonnet-4-6")?.totalUsd).toBeCloseTo(30, 9)
  })

  test("the drill-down log is bounded and keeps the NEWEST records", () => {
    const acct = createUsageAccounting({ maxRetainedRecords: 3 })
    for (let i = 0; i < 10; i++) acct.record(call(`c${i}`))
    expect(acct.recent().map((r) => r.callId)).toEqual(["c7", "c8", "c9"])
    expect(acct.recent(2).map((r) => r.callId)).toEqual(["c8", "c9"])
  })

  // PAIRED CONTROL — with room for everything, retained and admitted agree.
  test("PAIRED CONTROL: under the cap, retained == calls", () => {
    const acct = createUsageAccounting({ maxRetainedRecords: 100 })
    for (let i = 0; i < 10; i++) acct.record(call(`c${i}`))
    const snap = acct.snapshot()
    expect(snap.retained).toBe(10)
    expect(snap.calls).toBe(10)
    expect(snap.totalUsd).toBeCloseTo(30, 9)
  })
})

describe("admission is idempotent and defensive", () => {
  test("the same call recorded twice bills once", () => {
    const acct = createUsageAccounting()
    expect(acct.record(call("same"))).toEqual({ admitted: true })
    expect(acct.record(call("same"))).toEqual({ admitted: false, reason: "duplicate" })
    const snap = acct.snapshot()
    expect(snap.calls).toBe(1)
    expect(snap.totalUsd).toBeCloseTo(3, 9)
  })

  test("distinct calls with identical content both bill", () => {
    // Guards the idempotency key from being widened into content hashing: two
    // genuinely separate calls that happen to cost the same must both count.
    const acct = createUsageAccounting()
    acct.record(call("a"))
    acct.record(call("b"))
    expect(acct.snapshot().totalUsd).toBeCloseTo(6, 9)
  })

  test("a non-finite token count is rejected loudly, not clamped to zero", () => {
    const acct = createUsageAccounting()
    const broken = call("broken", { inputTokens: Number.NaN })
    expect(acct.record(broken)).toEqual({ admitted: false, reason: "non-finite" })
    // Nothing was folded in — the total is not NaN, and not a silent 0-cost
    // admission that would understate the bill while looking healthy.
    const snap = acct.snapshot()
    expect(snap.calls).toBe(0)
    expect(snap.totalUsd).toBe(0)
    // …and a rejected call id is NOT consumed, so a corrected retry is admitted.
    expect(acct.record(call("broken")).admitted).toBe(true)
  })
})

describe("spend is attributable to the agent that incurred it", () => {
  test("root and subagent spend are separable, and sum to the total", () => {
    const acct = createUsageAccounting()
    acct.record(call("r1", { inputTokens: 100_000 })) // root, $0.30
    acct.record(call("s1", { agentId: "child-1", agentKind: "subagent", inputTokens: 500_000 })) // $1.50
    acct.record(call("s2", { agentId: "child-2", agentKind: "subagent", inputTokens: 200_000 })) // $0.60

    const snap = acct.snapshot()
    expect(snap.totalUsd).toBeCloseTo(2.4, 9)
    expect(snap.byKind.root.totalUsd).toBeCloseTo(0.3, 9)
    expect(snap.byKind.subagent.totalUsd).toBeCloseTo(2.1, 9)
    expect(snap.byKind.root.totalUsd + snap.byKind.subagent.totalUsd).toBeCloseTo(snap.totalUsd, 9)
    expect(snap.byAgent.get("child-1")?.totalUsd).toBeCloseTo(1.5, 9)
    expect(snap.byAgent.get("child-2")?.totalUsd).toBeCloseTo(0.6, 9)
  })

  test("both kind arms exist even when no subagent ran", () => {
    // A surface must not have to tell "no subagents" apart from "no data".
    const snap = createUsageAccounting().snapshot()
    expect(snap.byKind.subagent.calls).toBe(0)
    expect(snap.byKind.subagent.totalUsd).toBe(0)
  })

  test("A5: the authority BINDS to its first session and rejects strangers", () => {
    // bySession was a structurally-singleton dimension (one authority per
    // session by construction) — but deleting the map alone would let a
    // wrongly-SHARED authority silently sum two sessions into one bill. So
    // the singleton becomes a checked invariant: first admitted sessionId
    // binds; a different one is rejected, visibly.
    const acct = createUsageAccounting()
    expect(acct.record(call("a", { sessionId: "s1" })).admitted).toBe(true)
    const rejected = acct.record(call("b", { sessionId: "s2" }))
    expect(rejected).toEqual({ admitted: false, reason: "session-mismatch" })
    expect(acct.snapshot().totalUsd).toBeCloseTo(3, 9) // only s1's call
    // …and the same session keeps flowing.
    expect(acct.record(call("c", { sessionId: "s1" })).admitted).toBe(true)
  })
})

describe("estimated spend is tracked as an amount, not a verdict", () => {
  test("only the unpriced portion counts as estimated", () => {
    const acct = createUsageAccounting()
    acct.record(call("known", { inputTokens: 1_000_000 })) // $3, priced
    acct.record(
      call("guess", {
        model: "mystery-model-99",
        inputTokens: 1_000_000,
        fallbackModel: "claude-sonnet-4-6",
      }),
    ) // $3, estimated

    const snap = acct.snapshot()
    expect(snap.totalUsd).toBeCloseTo(6, 9)
    // A surface can say "$6.00, of which $3.00 is estimated" instead of
    // condemning the whole figure because one call was unpriced.
    expect(snap.estimatedUsd).toBeCloseTo(3, 9)
  })

  test("a fully-priced session reports zero estimated spend", () => {
    const acct = createUsageAccounting()
    acct.record(call("a"))
    expect(acct.snapshot().estimatedUsd).toBe(0)
  })
})

describe("reset clears counters, not just the log", () => {
  test("reset zeroes the aggregates and frees the idempotency keys", () => {
    const acct = createUsageAccounting()
    acct.record(call("a"))
    acct.reset()
    expect(acct.snapshot().totalUsd).toBe(0)
    expect(acct.snapshot().calls).toBe(0)
    // The id is reusable after a reset — otherwise a reset session could never
    // re-record a replayed call.
    expect(acct.record(call("a")).admitted).toBe(true)
  })
})
