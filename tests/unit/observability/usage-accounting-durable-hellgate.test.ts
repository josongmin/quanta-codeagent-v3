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
import { describe, expect, spyOn, test } from "bun:test"
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

const mutateSerialized = (
  acct: UsageAccountingPort,
  mutate: (durable: Record<string, unknown>) => void,
): string => {
  const durable = JSON.parse(acct.serialize()) as Record<string, unknown>
  mutate(durable)
  return JSON.stringify(durable)
}

const serializeAsLegacyV1 = (acct: UsageAccountingPort, seq: number): string => {
  const snapshot = acct.snapshot()
  return JSON.stringify({
    v: 1,
    boundSessionId: snapshot.boundSessionId,
    seq,
    seen: acct.recent().map((entry) => entry.callId),
    retained: acct.recent(),
    total: snapshot,
    byModel: [...snapshot.byModel.entries()],
    byAgent: [...snapshot.byAgent.entries()],
    byKind: snapshot.byKind,
  })
}

type MutableDurable = {
  total: Record<string, unknown>
  byModel: Array<[string, Record<string, unknown>]>
  byAgent: Array<[string, Record<string, unknown>]>
  byKind: { root: Record<string, unknown>; subagent: Record<string, unknown> }
  retained: Array<{
    callId: string
    usage: Record<string, unknown>
    cost: Record<string, unknown>
  }>
}

const withConservedToken = (payload: MutableDurable, token: string, count: number): void => {
  for (const bucket of [
    payload.total,
    payload.byKind.root,
    payload.byModel[0]?.[1],
    payload.byAgent[0]?.[1],
  ]) {
    if (bucket === undefined) throw new Error("valid fixture bucket missing")
    bucket[token] = count
  }
}

const TOKEN_FIELDS = [
  "freshInputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
] as const

describe("R1 — durable token and conservation mutation rails", () => {
  for (const token of TOKEN_FIELDS) {
    test(`${token}: even conserved aggregate counts reject fractional or unsafe integers`, () => {
      const source = createUsageAccounting()
      record(source, source.mintCallId(PROV))
      for (const count of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
        const payload = JSON.parse(source.serialize()) as MutableDurable
        withConservedToken(payload, token, count)
        expect(createUsageAccounting().hydrate(JSON.stringify(payload))).toBe(false)
      }
    })

    test(`${token}: retained counts reject fractional, unsafe, negative, and non-finite values`, () => {
      const source = createUsageAccounting()
      record(source, source.mintCallId(PROV))
      for (const count of [
        0.5,
        Number.MAX_SAFE_INTEGER + 1,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        const payload = JSON.parse(source.serialize()) as MutableDurable
        const retained = payload.retained[0]
        if (retained === undefined) throw new Error("valid fixture record missing")
        retained.usage[token] = count
        expect(createUsageAccounting().hydrate(JSON.stringify(payload))).toBe(false)
      }
    })
  }

  for (const dimension of ["byModel", "byAgent", "byKind"] as const) {
    test(`${dimension}: a one-token disagreement is not hidden by USD tolerance`, () => {
      const source = createUsageAccounting()
      record(source, source.mintCallId(PROV))
      const payload = JSON.parse(source.serialize()) as MutableDurable
      withConservedToken(payload, "freshInputTokens", 1_000_000_000_000)
      const bucket = dimension === "byKind" ? payload.byKind.root : payload[dimension][0]?.[1]
      if (bucket === undefined) throw new Error("valid fixture bucket missing")
      bucket.freshInputTokens = 1_000_000_000_001
      expect(createUsageAccounting().hydrate(JSON.stringify(payload))).toBe(false)
    })

    test(`${dimension}: finite USD buckets whose sum overflows cannot conserve a finite total`, () => {
      const source = createUsageAccounting()
      record(source, source.mintCallId(PROV))
      record(source, source.mintCallId(PROV))
      const payload = JSON.parse(source.serialize()) as MutableDurable
      const half = { ...payload.total, totalUsd: 1e308, freshInputTokens: 1_000_000, calls: 1 }
      if (dimension === "byKind") payload.byKind = { root: half, subagent: { ...half } }
      else
        payload[dimension] = [
          ["first", half],
          ["second", { ...half }],
        ]
      const restored = createUsageAccounting()
      const blob = JSON.stringify(payload)
      expect(() => restored.hydrate(blob)).not.toThrow()
      expect(restored.hydrate(blob)).toBe(false)
      expect(restored.snapshot()).toMatchObject({ calls: 0, continuityLost: true })
    })
  }

  test("finite retained cost components whose sum overflows are rejected", () => {
    const source = createUsageAccounting()
    record(source, source.mintCallId(PROV))
    const payload = JSON.parse(source.serialize()) as MutableDurable
    const retained = payload.retained[0]
    if (retained === undefined) throw new Error("valid fixture record missing")
    retained.cost.freshInputUsd = 1e308
    retained.cost.cacheReadUsd = 1e308
    const restored = createUsageAccounting()
    const blob = JSON.stringify(payload)
    expect(() => restored.hydrate(blob)).not.toThrow()
    expect(restored.hydrate(blob)).toBe(false)
    expect(restored.snapshot()).toMatchObject({ calls: 0, continuityLost: true })
  })

  test("optional retained reasoningTokens obey the same safe-integer contract", () => {
    const source = createUsageAccounting()
    record(source, source.mintCallId(PROV))
    for (const count of [0.5, Number.MAX_SAFE_INTEGER + 1, -1, Number.NaN]) {
      const payload = JSON.parse(source.serialize()) as MutableDurable
      const retained = payload.retained[0]
      if (retained === undefined) throw new Error("valid fixture record missing")
      retained.usage.reasoningTokens = count
      expect(createUsageAccounting().hydrate(JSON.stringify(payload))).toBe(false)
    }
  })

  test("a retained callId absent from exact dedup memory is rejected", () => {
    const source = createUsageAccounting()
    record(source, source.mintCallId(PROV))
    const payload = JSON.parse(source.serialize()) as MutableDurable
    const retained = payload.retained[0]
    if (retained === undefined) throw new Error("valid fixture record missing")
    retained.callId = "not-admitted"
    expect(createUsageAccounting().hydrate(JSON.stringify(payload))).toBe(false)
  })
})

describe("A6 — serialize → fresh authority → hydrate", () => {
  test("prepared restore decodes and rebinds before commit without touching the live books", () => {
    const source = createUsageAccounting()
    record(source, source.mintCallId(PROV), 2_000_000)
    const live = createUsageAccounting()
    record(live, live.mintCallId(PROV))
    const before = live.serialize()
    const options = { rebindSessionId: "live-runtime" }
    const prepared = live.prepareHydrate(source.serialize(), options)
    expect(prepared.restored).toBe(true)
    expect(live.serialize()).toBe(before)
    options.rebindSessionId = "changed-after-prepare"
    const parse = spyOn(JSON, "parse").mockImplementation(() => {
      throw new Error("decode attempted during commit")
    })
    try {
      expect(() => prepared.commit()).not.toThrow()
    } finally {
      parse.mockRestore()
    }
    expect(live.snapshot()).toMatchObject({ totalUsd: 6, boundSessionId: "live-runtime" })
    expect(live.recent()[0]?.provenance.sessionId).toBe("live-runtime")
    live.reset()
    prepared.commit()
    expect(live.snapshot().calls).toBe(0)
  })

  test("absent and corrupt books prepare distinct empty states without changing live state", () => {
    const live = createUsageAccounting()
    record(live, live.mintCallId(PROV))
    const before = live.serialize()
    const corrupt = live.prepareHydrate("{ corrupt")
    const absent = live.prepareHydrate(undefined)
    expect(corrupt.restored).toBe(false)
    expect(absent.restored).toBe(true)
    expect(live.serialize()).toBe(before)
    corrupt.commit()
    expect(live.snapshot()).toMatchObject({ calls: 0, continuityLost: true })
    absent.commit()
    expect(live.snapshot()).toMatchObject({ calls: 0, continuityLost: false })
  })
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

  test("continuity loss survives repeated empty save, restore, and live rebind", () => {
    const source = createUsageAccounting()
    expect(source.hydrate("{ corrupt")).toBe(false)
    let blob = source.serialize()
    for (const sessionId of ["live-1", "live-2", "live-3"]) {
      const restored = createUsageAccounting()
      expect(restored.hydrate(blob, { rebindSessionId: sessionId })).toBe(true)
      expect(restored.snapshot()).toMatchObject({
        calls: 0,
        continuityLost: true,
        boundSessionId: undefined,
      })
      blob = restored.serialize()
    }
  })

  test("new spend does not erase lost-history provenance across restore and rebind", () => {
    const source = createUsageAccounting()
    source.hydrate("{ corrupt")
    record(source, source.mintCallId(PROV))
    const restored = createUsageAccounting()
    expect(restored.hydrate(source.serialize(), { rebindSessionId: "live-restored" })).toBe(true)
    expect(restored.snapshot()).toMatchObject({
      calls: 1,
      totalUsd: 3,
      continuityLost: true,
      boundSessionId: "live-restored",
    })
    const again = createUsageAccounting()
    expect(again.hydrate(restored.serialize())).toBe(true)
    expect(again.snapshot().continuityLost).toBe(true)
    again.reset()
    expect(again.snapshot()).toMatchObject({ calls: 0, continuityLost: false })
    expect(restored.hydrate(again.serialize())).toBe(true)
    expect(restored.snapshot().continuityLost).toBe(false)
  })

  test("legacy V1 and V2 without a continuity marker restore as healthy", () => {
    const source = createUsageAccounting()
    record(source, source.mintCallId(PROV))
    const legacyV2 = mutateSerialized(source, (durable) => {
      delete durable.continuityLost
    })
    for (const blob of [serializeAsLegacyV1(source, 1), legacyV2]) {
      const restored = createUsageAccounting()
      restored.hydrate("{ corrupt")
      expect(restored.hydrate(blob)).toBe(true)
      expect(restored.snapshot()).toMatchObject({ calls: 1, continuityLost: false })
    }
  })

  test("non-boolean continuity markers are rejected in both durable versions", () => {
    const source = createUsageAccounting()
    record(source, source.mintCallId(PROV))
    for (const blob of [serializeAsLegacyV1(source, 1), source.serialize()]) {
      for (const invalid of [null, "true", 0, {}, []]) {
        const payload = JSON.parse(blob) as Record<string, unknown>
        payload.continuityLost = invalid
        const restored = createUsageAccounting()
        expect(restored.hydrate(JSON.stringify(payload))).toBe(false)
        expect(restored.snapshot()).toMatchObject({ calls: 0, continuityLost: true })
      }
    }
  })

  test("nested bucket poison is rejected, clears prior books, and never throws", () => {
    const source = createUsageAccounting()
    record(source, source.mintCallId(PROV))
    const poisoned = mutateSerialized(source, (durable) => {
      ;(durable.total as Record<string, unknown>).freshInputTokens = "poison"
    })

    const target = createUsageAccounting()
    record(target, target.mintCallId(PROV))
    expect(() => target.hydrate(poisoned)).not.toThrow()
    expect(target.hydrate(poisoned)).toBe(false)
    expect(target.snapshot()).toMatchObject({
      calls: 0,
      totalUsd: 0,
      retained: 0,
      boundSessionId: undefined,
      continuityLost: true,
    })
  })

  test("malformed map entries and exact-set members are rejected without throwing", () => {
    const source = createUsageAccounting()
    record(source, source.mintCallId(PROV))
    const malformedMap = mutateSerialized(source, (durable) => {
      durable.byModel = [42]
    })
    const malformedSeen = mutateSerialized(source, (durable) => {
      durable.externalSeen = [42]
    })
    const malformedRanges = mutateSerialized(source, (durable) => {
      ;(durable.mint as Record<string, unknown>).admitted = [[2, 1]]
    })
    const duplicateRepresentation = mutateSerialized(source, (durable) => {
      const retained = durable.retained as Array<{ callId: string }>
      durable.externalSeen = [retained[0]?.callId]
    })

    for (const payload of [malformedMap, malformedSeen, malformedRanges, duplicateRepresentation]) {
      const target = createUsageAccounting()
      expect(() => target.hydrate(payload)).not.toThrow()
      expect(target.hydrate(payload)).toBe(false)
      expect(target.snapshot().continuityLost).toBe(true)
    }
  })

  test("a poisoned retained record and inconsistent aggregate are rejected", () => {
    const source = createUsageAccounting()
    record(source, source.mintCallId(PROV))
    const poisonedRecord = mutateSerialized(source, (durable) => {
      const retained = durable.retained as Array<Record<string, unknown>>
      const usage = retained[0]?.usage as Record<string, unknown>
      usage.freshInputTokens = "poison"
    })
    const inconsistentTotal = mutateSerialized(source, (durable) => {
      ;(durable.total as Record<string, unknown>).calls = 2
    })

    for (const payload of [poisonedRecord, inconsistentTotal]) {
      const target = createUsageAccounting()
      expect(target.hydrate(payload)).toBe(false)
      expect(target.snapshot()).toMatchObject({ calls: 0, continuityLost: true })
    }
  })

  test("valid legacy V1 state migrates and can rebind to the live runtime session", () => {
    const source = createUsageAccounting()
    record(source, source.mintCallId(PROV))
    const target = createUsageAccounting()

    expect(target.hydrate(serializeAsLegacyV1(source, 1), { rebindSessionId: "sess-live" })).toBe(
      true,
    )
    expect(target.snapshot().boundSessionId).toBe("sess-live")
    const liveProvenance = { ...PROV, sessionId: "sess-live" }
    const usage = normalizeUsage({
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 0,
    })
    expect(
      target.record({
        callId: target.mintCallId(liveProvenance),
        at: 2,
        usage,
        cost: priceUsage(usage, MODEL_RATE_CARD, { pricingVersion: PRICING_VERSION }),
        provenance: liveProvenance,
      }),
    ).toEqual({ admitted: true })
    expect(target.snapshot().calls).toBe(2)

    // Rebound state remains valid durable V1, including its retained records.
    const resumed = createUsageAccounting()
    expect(resumed.hydrate(target.serialize())).toBe(true)
    expect(resumed.snapshot()).toMatchObject({ calls: 2, boundSessionId: "sess-live" })
  })

  test("a healthy authority reports continuityLost:false", () => {
    expect(createUsageAccounting().snapshot().continuityLost).toBe(false)
  })

  test("V2 preserves exact gaps, merges out-of-order admissions, and skips external collisions", () => {
    const source = createUsageAccounting({ maxRetainedRecords: 1 })
    const first = source.mintCallId(PROV)
    const second = source.mintCallId(PROV)
    const third = source.mintCallId(PROV)
    expect(record(source, third)).toEqual({ admitted: true })
    expect(record(source, first)).toEqual({ admitted: true })
    expect(
      (JSON.parse(source.serialize()) as { mint: { admitted: number[][] } }).mint.admitted,
    ).toEqual([
      [1, 1],
      [3, 3],
    ])
    expect(record(source, second)).toEqual({ admitted: true })
    expect(
      (JSON.parse(source.serialize()) as { mint: { admitted: number[][] } }).mint.admitted,
    ).toEqual([[1, 3]])

    const collisionSource = createUsageAccounting({ maxRetainedRecords: 1 })
    const mintedFirst = collisionSource.mintCallId(PROV)
    const prefix = mintedFirst.slice(0, mintedFirst.lastIndexOf(":") + 1)
    const externalFuture = `${prefix}3`
    expect(record(collisionSource, externalFuture)).toEqual({ admitted: true })
    const mintedSecond = collisionSource.mintCallId(PROV)
    const mintedAfterCollision = collisionSource.mintCallId(PROV)
    expect(mintedSecond.endsWith(":2")).toBe(true)
    expect(mintedAfterCollision.endsWith(":4")).toBe(true)
    expect(record(collisionSource, mintedSecond)).toEqual({ admitted: true })
    expect(record(collisionSource, mintedAfterCollision)).toEqual({ admitted: true })

    const restored = createUsageAccounting()
    expect(restored.hydrate(collisionSource.serialize())).toBe(true)
    for (const duplicate of [externalFuture, mintedSecond, mintedAfterCollision]) {
      expect(record(restored, duplicate)).toEqual({ admitted: false, reason: "duplicate" })
    }
  })

  test(
    "P2: one million authority-minted calls persist as one exact interval",
    () => {
      const calls = 1_000_000
      const source = createUsageAccounting({ maxRetainedRecords: 1 })
      const usage = normalizeUsage({
        model: "claude-sonnet-4-6",
        inputTokens: 0,
        outputTokens: 0,
      })
      const cost = priceUsage(usage, MODEL_RATE_CARD, { pricingVersion: PRICING_VERSION })
      let first = ""
      let last = ""
      let admittedCalls = 0
      const buildStarted = performance.now()
      for (let index = 0; index < calls; index += 1) {
        const callId = source.mintCallId(PROV)
        if (index === 0) first = callId
        last = callId
        if (source.record({ callId, at: index, usage, cost, provenance: PROV }).admitted) {
          admittedCalls += 1
        }
      }
      const buildMs = performance.now() - buildStarted
      expect(admittedCalls).toBe(calls)
      expect(source.record({ callId: first, at: 0, usage, cost, provenance: PROV })).toEqual({
        admitted: false,
        reason: "duplicate",
      })

      const externalCallId = "external:caller-owned:id"
      expect(
        source.record({ callId: externalCallId, at: calls, usage, cost, provenance: PROV }),
      ).toEqual({ admitted: true })
      const blob = source.serialize()
      const durable = JSON.parse(blob) as {
        v: number
        mint: { admitted: Array<[number, number]> }
        externalSeen: string[]
      }
      expect(durable.v).toBe(2)
      expect(durable.mint.admitted).toEqual([[1, calls]])
      expect(durable.externalSeen).toEqual([externalCallId])
      expect(blob.length).toBeLessThan(10_000)
      expect(buildMs).toBeLessThan(15_000)

      const restored = createUsageAccounting({ maxRetainedRecords: 1 })
      const hydrateStarted = performance.now()
      expect(restored.hydrate(blob)).toBe(true)
      const hydrateMs = performance.now() - hydrateStarted
      expect(hydrateMs).toBeLessThan(2_000)
      expect(restored.snapshot().calls).toBe(calls + 1)
      for (const duplicate of [first, last, externalCallId]) {
        expect(
          restored.record({ callId: duplicate, at: calls + 1, usage, cost, provenance: PROV }),
        ).toEqual({ admitted: false, reason: "duplicate" })
      }
      const fresh = restored.mintCallId(PROV)
      expect(
        restored.record({ callId: fresh, at: calls + 2, usage, cost, provenance: PROV }),
      ).toEqual({ admitted: true })
    },
    { timeout: 30_000 },
  )
})
