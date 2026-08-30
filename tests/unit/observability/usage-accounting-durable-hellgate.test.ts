/**
 * A6 hellgate — the authority survives a resume without double-billing.
 *
 * The plan review killed the first design for three specific failures, each
 * pinned here:
 *   - rebuilding `seen` from the RETAINED log re-bills every evicted callId;
 *     the full dedup state persists.
 *   - an external sequence (the emit-helper's old WeakMap) restarts at 1
 *     after hydrate, so NEW calls collide with restored ids; the sequence is
 *     owned and persisted by the authority itself.
 *   - corrupt state silently rendering as an exact $0 hides the loss; the
 *     books stay empty but SAY continuity was lost.
 */
import { describe, expect, test } from "bun:test"
import { MODEL_RATE_CARD, PRICING_VERSION } from "@/observability/pricing"
import {
  createUsageAccounting,
  normalizeUsage,
  priceUsage,
  type UsageAccountingPort,
  type UsageProvenance,
} from "@/observability/usage-accounting"

const PROV: UsageProvenance = {
  sessionId: "sess-1",
  agentId: "root",
  agentKind: "root",
  depth: 0,
}

const record = (acct: UsageAccountingPort, callId: string, inputTokens = 1_000_000) => {
  const usage = normalizeUsage({ model: "claude-sonnet-4-6", inputTokens, outputTokens: 0 })
  return acct.record({
    callId,
    at: 1,
    usage,
    cost: priceUsage(usage, MODEL_RATE_CARD, { pricingVersion: PRICING_VERSION }),
    provenance: PROV,
  })
}

describe("A6 — serialize → fresh authority → hydrate", () => {
  test("totals, buckets and the binding survive the round trip", () => {
    const a = createUsageAccounting()
    record(a, a.mintCallId(PROV))
    record(a, a.mintCallId(PROV))
    const b = createUsageAccounting()
    expect(b.hydrate(a.serialize())).toBe(true)
    expect(b.snapshot().totalUsd).toBeCloseTo(6, 9)
    expect(b.snapshot().calls).toBe(2)
    expect(b.snapshot().byKind.root.calls).toBe(2)
    expect(b.snapshot().boundSessionId).toBe("sess-1")
    expect(b.snapshot().continuityLost).toBe(false)
  })

  test("an EVICTED callId still deduplicates after hydrate", () => {
    // Retention bounds the drill-down log, not the dedup memory: the id of a
    // call pushed out of `recent()` must still be refused after a resume, or
    // a replayed transcript re-bills exactly the calls old enough to have
    // been evicted.
    const a = createUsageAccounting({ maxRetainedRecords: 2 })
    const first = a.mintCallId(PROV)
    record(a, first)
    record(a, a.mintCallId(PROV))
    record(a, a.mintCallId(PROV)) // evicts `first` from the retained log
    expect(a.recent().some((r) => r.callId === first)).toBe(false)

    const b = createUsageAccounting({ maxRetainedRecords: 2 })
    expect(b.hydrate(a.serialize())).toBe(true)
    expect(record(b, first)).toEqual({ admitted: false, reason: "duplicate" })
    expect(b.snapshot().totalUsd).toBeCloseTo(9, 9) // unchanged by the replay
  })

  test("a NEW call right after hydrate is admitted (the sequence continues)", () => {
    const a = createUsageAccounting()
    record(a, a.mintCallId(PROV))
    record(a, a.mintCallId(PROV))
    const b = createUsageAccounting()
    b.hydrate(a.serialize())
    // If the sequence restarted at 1, this mint would collide with a restored
    // id and be silently dropped as a duplicate.
    const fresh = b.mintCallId(PROV)
    expect(record(b, fresh)).toEqual({ admitted: true })
    expect(b.snapshot().calls).toBe(3)
  })

  test("corrupt state: empty books that SAY continuity was lost", () => {
    const b = createUsageAccounting()
    record(b, b.mintCallId(PROV))
    expect(b.hydrate("{ not json")).toBe(false)
    expect(b.snapshot().totalUsd).toBe(0)
    expect(b.snapshot().continuityLost).toBe(true)
    // …and the flag is not sticky across an explicit reset.
    b.reset()
    expect(b.snapshot().continuityLost).toBe(false)
  })

  test("a healthy authority reports continuityLost:false", () => {
    expect(createUsageAccounting().snapshot().continuityLost).toBe(false)
  })
})
