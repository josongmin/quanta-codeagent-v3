/**
 * ★ CONTRACT — ADR-0182: PromptCacheObserver typed port + default in-memory
 *   adapter + budget bridge. Hit rate = cache_read / (input + cache_create).
 *   Cost savings = cache_read × (inputPerM − cacheReadPerM) / 1e6.
 *   exactOptionalPropertyTypes; per-event metrics emitted as 3 counters + 1
 *   gauge; aggregate-only state keeps record O(1) and snapshot O(states);
 *   budget-bridge wraps `observer.record` so events ALSO flow to the ledger;
 *   deregister restores original behaviour.
 *
 * HELLGATE — adversarial cases for prompt-cache observability:
 *   A. record + snapshot (1-8)         — model/session rollup, hit-rate math,
 *                                        savings, negative-tokens, unknown-model.
 *   B. attributeBreakpoint (9-12)      — named-breakpoint hit/miss + token span.
 *   C. MetricSink integration (13-16)  — 4 samples per record, labels, no-throw.
 *   D. Aggregate-only + reset (17-18)  — no event-ring churn, reset clears.
 *   E. budget-bridge (19-22)           — wire/no-wire/deregister/no-sink.
 *   F. Determinism (23-24)             — same input → same snapshot; clock injection.
 */

import { describe, expect, test } from "bun:test"
import { defaultBudgetLedger } from "@/agent/budget-ledger"
import type { MetricSample, MetricSink } from "@/observability/metrics/port"
import {
  type CacheHitEvent,
  defaultPromptCacheObserver,
  PromptCacheError,
  wirePromptCacheToBudget,
} from "@/observability/prompt-cache"

/** Recording sink that captures every sample for assertion. */
const makeRecordingSink = (): { sink: MetricSink; samples: MetricSample[] } => {
  const samples: MetricSample[] = []
  return {
    sink: {
      send(sample) {
        samples.push(sample)
      },
    },
    samples,
  }
}

/** Throwing sink — every send throws. */
const throwingSink: MetricSink = {
  send() {
    throw new Error("sink boom")
  },
}

/** Helper to build a CacheHitEvent with sensible defaults. */
const evt = (overrides: Partial<CacheHitEvent>): CacheHitEvent => ({
  model: "claude-sonnet-4-6",
  sessionId: "s1",
  turnIndex: 0,
  atMs: 1_700_000_000_000,
  inputTokens: 100,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 50,
  ...overrides,
})

describe("ADR-0182 — prompt-cache observability — A. record + snapshot", () => {
  test("[1] single event populates perModel with 1 entry", () => {
    const o = defaultPromptCacheObserver()
    o.record(evt({ inputTokens: 200, cacheReadTokens: 800 }))
    const snap = o.snapshot()
    expect(snap.perModel.size).toBe(1)
    expect(snap.perModel.get("claude-sonnet-4-6")?.inputTokens).toBe(200)
    expect(snap.perModel.get("claude-sonnet-4-6")?.cacheReadTokens).toBe(800)
    expect(snap.totalInputTokens).toBe(200)
    expect(snap.totalCacheReadTokens).toBe(800)
  })

  test("[2] multi-event same model sums per-model totals", () => {
    const o = defaultPromptCacheObserver()
    o.record(evt({ inputTokens: 100, cacheReadTokens: 200 }))
    o.record(evt({ inputTokens: 50, cacheReadTokens: 300, cacheCreationTokens: 25 }))
    const snap = o.snapshot()
    const row = snap.perModel.get("claude-sonnet-4-6")
    expect(row?.inputTokens).toBe(150)
    expect(row?.cacheReadTokens).toBe(500)
    expect(row?.cacheCreationTokens).toBe(25)
  })

  test("[3] multi-model produces separate per-model entries", () => {
    const o = defaultPromptCacheObserver()
    o.record(evt({ model: "claude-sonnet-4-6", inputTokens: 100 }))
    o.record(evt({ model: "claude-opus-4-7", inputTokens: 50, cacheReadTokens: 1000 }))
    const snap = o.snapshot()
    expect(snap.perModel.size).toBe(2)
    expect(snap.perModel.get("claude-sonnet-4-6")?.inputTokens).toBe(100)
    expect(snap.perModel.get("claude-opus-4-7")?.cacheReadTokens).toBe(1000)
  })

  test("[4] hit-rate formula = cache_read / (input + cache_create); denom=0 → 0", () => {
    // Case A: input=20, cache_create=0, cache_read=80 → 80 / 20 = 4.0
    // (intentional — the formula expresses "how many cache-read tokens did we
    // get for every input token we wrote"; can exceed 1.0 when the system
    // prompt is mostly cached and only a small dynamic tail is "input"). The
    // ADR documents this as the SOTA-aligned ratio.
    const o = defaultPromptCacheObserver()
    o.record(evt({ inputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 80 }))
    const snap = o.snapshot()
    expect(snap.cacheHitRate).toBeCloseTo(4.0, 6)

    // Case B: denom = 0 → hitRate = 0 (no NaN).
    const o2 = defaultPromptCacheObserver()
    o2.record(evt({ inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }))
    const snap2 = o2.snapshot()
    expect(snap2.cacheHitRate).toBe(0)
    // Even with cache_read but no input/create, denom is 0 → hitRate 0.
    const o3 = defaultPromptCacheObserver()
    o3.record(evt({ inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 500 }))
    expect(o3.snapshot().cacheHitRate).toBe(0)
  })

  test("[5] cost savings: 1M cache_read on Sonnet → $2.70", () => {
    // Sonnet pricing: inputPerM=3, cacheReadPerM=0.3. Savings per 1M tokens
    // = (3 - 0.3) × 1M / 1M = $2.70.
    const o = defaultPromptCacheObserver()
    o.record(evt({ model: "claude-sonnet-4-6", cacheReadTokens: 1_000_000 }))
    const snap = o.snapshot()
    expect(snap.costSavingsUsd).toBeCloseTo(2.7, 6)
    expect(snap.perModel.get("claude-sonnet-4-6")?.savingsUsd).toBeCloseTo(2.7, 6)
  })

  test("[6] perSession aggregation splits by sessionId and keeps per-session perModel local", () => {
    const o = defaultPromptCacheObserver()
    o.record(
      evt({ sessionId: "s1", model: "claude-sonnet-4-6", inputTokens: 100, cacheReadTokens: 50 }),
    )
    o.record(
      evt({ sessionId: "s1", model: "claude-opus-4-7", inputTokens: 25, cacheReadTokens: 75 }),
    )
    o.record(
      evt({ sessionId: "s2", model: "claude-haiku-4-5", inputTokens: 200, cacheReadTokens: 100 }),
    )
    o.record(evt({ sessionId: "s1", model: "claude-sonnet-4-6", inputTokens: 50 }))
    const snap = o.snapshot()
    expect(snap.perSession.size).toBe(2)
    const s1 = snap.perSession.get("s1")
    expect(s1?.totalInputTokens).toBe(175)
    expect(s1?.totalCacheReadTokens).toBe(125)
    expect(s1?.perModel.size).toBe(2)
    expect(s1?.perModel.get("claude-sonnet-4-6")?.inputTokens).toBe(150)
    expect(s1?.perModel.get("claude-opus-4-7")?.cacheReadTokens).toBe(75)
    expect(s1?.perModel.get("claude-haiku-4-5")).toBeUndefined()
    expect(snap.perSession.get("s2")?.totalCacheReadTokens).toBe(100)
    expect(snap.perSession.get("s2")?.perModel.get("claude-haiku-4-5")?.cacheReadTokens).toBe(100)
  })

  test("[7] negative token count throws PromptCacheError('negative-tokens')", () => {
    const o = defaultPromptCacheObserver()
    expect(() => o.record(evt({ inputTokens: -1 }))).toThrow(PromptCacheError)
    expect(() => o.record(evt({ cacheReadTokens: -100 }))).toThrow(PromptCacheError)
    try {
      o.record(evt({ inputTokens: -5 }))
    } catch (e) {
      expect(e).toBeInstanceOf(PromptCacheError)
      expect((e as PromptCacheError).errorCode).toBe("negative-tokens")
    }
    // No state should be recorded on throw.
    expect(o.snapshot().totalInputTokens).toBe(0)
  })

  test("[8] unknown model falls back to sonnet pricing + logs warn (no throw)", () => {
    const o = defaultPromptCacheObserver()
    // 1M cache_read on unknown model → fallback sonnet pricing → $2.70
    o.record(evt({ model: "made-up-mega-model-9000", cacheReadTokens: 1_000_000 }))
    const snap = o.snapshot()
    expect(snap.costSavingsUsd).toBeCloseTo(2.7, 6)
    // Aggregates STILL credit the unknown model — operator notices it in the
    // breakdown (safe-LOUD posture, parity with ADR-0138 clause #4).
    expect(snap.perModel.get("made-up-mega-model-9000")?.cacheReadTokens).toBe(1_000_000)
  })
})

describe("ADR-0182 — prompt-cache observability — B. attributeBreakpoint", () => {
  test("[9] single breakpoint hit → hitCount=1, missCount=0", () => {
    const o = defaultPromptCacheObserver()
    o.attributeBreakpoint("system-prefix", 1000, true)
    const snap = o.snapshot()
    expect(snap.breakpoints?.size).toBe(1)
    const bp = snap.breakpoints?.get("system-prefix")
    expect(bp?.hitCount).toBe(1)
    expect(bp?.missCount).toBe(0)
    expect(bp?.tokenSpan).toBe(1000)
  })

  test("[10] multiple breakpoints produce separate entries", () => {
    const o = defaultPromptCacheObserver()
    o.attributeBreakpoint("system-prefix", 1000, true)
    o.attributeBreakpoint("rules", 500, false)
    o.attributeBreakpoint("memory-recall", 200, true)
    o.attributeBreakpoint("tool-defs", 800, true)
    const snap = o.snapshot()
    expect(snap.breakpoints?.size).toBe(4)
    expect(snap.breakpoints?.get("rules")?.hitCount).toBe(0)
    expect(snap.breakpoints?.get("rules")?.missCount).toBe(1)
    expect(snap.breakpoints?.get("tool-defs")?.hitCount).toBe(1)
  })

  test("[11] repeated calls accumulate tokenSpan + hit/miss counts", () => {
    const o = defaultPromptCacheObserver()
    o.attributeBreakpoint("system-prefix", 1000, true)
    o.attributeBreakpoint("system-prefix", 1000, true)
    o.attributeBreakpoint("system-prefix", 500, false)
    const bp = o.snapshot().breakpoints?.get("system-prefix")
    expect(bp?.tokenSpan).toBe(2500)
    expect(bp?.hitCount).toBe(2)
    expect(bp?.missCount).toBe(1)
  })

  test("[12] no attributeBreakpoint calls → snapshot.breakpoints OMITTED", () => {
    const o = defaultPromptCacheObserver()
    o.record(evt({}))
    const snap = o.snapshot()
    // exactOptionalPropertyTypes: undefined, NOT present as undefined key.
    expect(snap.breakpoints).toBeUndefined()
    expect("breakpoints" in snap).toBe(false)
  })
})

describe("ADR-0182 — prompt-cache observability — C. MetricSink integration", () => {
  test("[13] one record → 4 metric samples (input/cache_read/cache_write/hit_rate)", () => {
    const { sink, samples } = makeRecordingSink()
    const o = defaultPromptCacheObserver({ metricsSink: sink })
    o.record(evt({ inputTokens: 100, cacheReadTokens: 50, cacheCreationTokens: 20 }))
    expect(samples).toHaveLength(4)
    const names = samples.map((s) => s.name).sort()
    expect(names).toEqual([
      "prompt_cache.cache_read_tokens",
      "prompt_cache.cache_write_tokens",
      "prompt_cache.hit_rate",
      "prompt_cache.input_tokens",
    ])
    // Counter values match event tokens.
    expect(samples.find((s) => s.name === "prompt_cache.input_tokens")?.value).toBe(100)
    expect(samples.find((s) => s.name === "prompt_cache.cache_read_tokens")?.value).toBe(50)
    expect(samples.find((s) => s.name === "prompt_cache.cache_write_tokens")?.value).toBe(20)
    // Hit rate gauge = 50 / (100 + 20) = ~0.4167
    expect(samples.find((s) => s.name === "prompt_cache.hit_rate")?.value).toBeCloseTo(50 / 120, 6)
  })

  test("[14] sample labels include {model, session}", () => {
    const { sink, samples } = makeRecordingSink()
    const o = defaultPromptCacheObserver({ metricsSink: sink })
    o.record(evt({ model: "claude-opus-4-7", sessionId: "alpha", inputTokens: 10 }))
    for (const s of samples) {
      expect(s.labels?.model).toBe("claude-opus-4-7")
      expect(s.labels?.session).toBe("alpha")
    }
  })

  test("[15] throwing sink → record completes normally (no-throw)", () => {
    const o = defaultPromptCacheObserver({ metricsSink: throwingSink })
    expect(() => o.record(evt({ inputTokens: 100 }))).not.toThrow()
    // Internal aggregates still updated.
    expect(o.snapshot().totalInputTokens).toBe(100)
  })

  test("[16] sink with no .flush is allowed (we never assume flush exists)", () => {
    // Bare sink without flush member — observer must not call flush implicitly.
    const sink: MetricSink = { send() {} }
    const o = defaultPromptCacheObserver({ metricsSink: sink })
    expect(() => o.record(evt({}))).not.toThrow()
  })
})

describe("ADR-0182 — prompt-cache observability — D. Aggregate-only + reset", () => {
  test("[17] maxEvents is a backward-compatible no-op on the aggregate-only adapter", () => {
    const bounded = defaultPromptCacheObserver({ maxEvents: 2 })
    const unbounded = defaultPromptCacheObserver()
    const events = [
      evt({ sessionId: "s1", model: "claude-sonnet-4-6", inputTokens: 10 }),
      evt({ sessionId: "s1", model: "claude-opus-4-7", inputTokens: 20, cacheReadTokens: 5 }),
      evt({ sessionId: "s2", model: "claude-haiku-4-5", inputTokens: 30, cacheReadTokens: 10 }),
      evt({ sessionId: "s1", model: "claude-sonnet-4-6", inputTokens: 40, cacheCreationTokens: 7 }),
    ]
    for (const event of events) {
      bounded.record(event)
      unbounded.record(event)
    }
    const boundedSnap = bounded.snapshot()
    const unboundedSnap = unbounded.snapshot()
    expect(boundedSnap.totalInputTokens).toBe(unboundedSnap.totalInputTokens)
    expect(boundedSnap.totalCacheReadTokens).toBe(unboundedSnap.totalCacheReadTokens)
    expect(boundedSnap.perModel.size).toBe(unboundedSnap.perModel.size)
    expect(boundedSnap.perSession.size).toBe(unboundedSnap.perSession.size)
    expect(boundedSnap.perSession.get("s1")?.perModel.get("claude-sonnet-4-6")?.inputTokens).toBe(
      unboundedSnap.perSession.get("s1")?.perModel.get("claude-sonnet-4-6")?.inputTokens,
    )
  })

  test("[18] reset() clears every aggregate + breakpoint", () => {
    const o = defaultPromptCacheObserver()
    o.record(evt({ inputTokens: 100, cacheReadTokens: 50 }))
    o.attributeBreakpoint("system-prefix", 1000, true)
    o.reset()
    const snap = o.snapshot()
    expect(snap.totalInputTokens).toBe(0)
    expect(snap.totalCacheReadTokens).toBe(0)
    expect(snap.perModel.size).toBe(0)
    expect(snap.perSession.size).toBe(0)
    expect(snap.breakpoints).toBeUndefined()
    expect(snap.costSavingsUsd).toBe(0)
  })
})

describe("ADR-0182 — prompt-cache observability — E. budget-bridge", () => {
  test("[19] wirePromptCacheToBudget — record event reaches ledger with matching tokens", () => {
    const o = defaultPromptCacheObserver()
    const l = defaultBudgetLedger()
    wirePromptCacheToBudget(o, l)
    o.record(evt({ inputTokens: 100, cacheReadTokens: 200, cacheCreationTokens: 30 }))
    const lsnap = l.snapshot()
    // Ledger has exactly one event.
    expect(lsnap.events).toBe(1)
    const row = lsnap.perModel.get("claude-sonnet-4-6")
    expect(row?.inputTokens).toBe(100)
    expect(row?.cacheReadTokens).toBe(200)
    expect(row?.cacheWriteTokens).toBe(30)
  })

  test("[20] without bridge — ledger receives nothing on observer.record", () => {
    const o = defaultPromptCacheObserver()
    const l = defaultBudgetLedger()
    o.record(evt({ inputTokens: 100, cacheReadTokens: 50 }))
    expect(l.snapshot().events).toBe(0)
  })

  test("[21] deregister stops further events from flowing to ledger", () => {
    const o = defaultPromptCacheObserver()
    const l = defaultBudgetLedger()
    const unwire = wirePromptCacheToBudget(o, l)
    o.record(evt({ inputTokens: 100 }))
    expect(l.snapshot().events).toBe(1)
    unwire()
    o.record(evt({ inputTokens: 200 }))
    // Observer still updates its own aggregates...
    expect(o.snapshot().totalInputTokens).toBe(300)
    // ...but the ledger does NOT see the post-deregister event.
    expect(l.snapshot().events).toBe(1)
    // Idempotent deregister.
    expect(() => unwire()).not.toThrow()
  })

  test("[22] bridge with no metricsSink still wires to ledger (independent channels)", () => {
    const o = defaultPromptCacheObserver() // NO metricsSink
    const l = defaultBudgetLedger()
    wirePromptCacheToBudget(o, l)
    o.record(evt({ inputTokens: 50 }))
    expect(l.snapshot().events).toBe(1)
    // And: bridge + validation throw → neither primitive records (atomicity).
    expect(() => o.record(evt({ inputTokens: -10 }))).toThrow(PromptCacheError)
    expect(l.snapshot().events).toBe(1) // unchanged
    expect(o.snapshot().totalInputTokens).toBe(50) // unchanged
  })
})

describe("ADR-0182 — prompt-cache observability — F. determinism", () => {
  test("[23] same input → same snapshot (deep-equal)", () => {
    const build = (): ReturnType<ReturnType<typeof defaultPromptCacheObserver>["snapshot"]> => {
      const o = defaultPromptCacheObserver()
      o.record(evt({ inputTokens: 100, cacheReadTokens: 50 }))
      o.record(evt({ sessionId: "s2", inputTokens: 200, cacheCreationTokens: 25 }))
      o.attributeBreakpoint("system-prefix", 1000, true)
      o.attributeBreakpoint("rules", 500, false)
      return o.snapshot()
    }
    const a = build()
    const b = build()
    expect(a.totalInputTokens).toBe(b.totalInputTokens)
    expect(a.totalCacheReadTokens).toBe(b.totalCacheReadTokens)
    expect(a.cacheHitRate).toBe(b.cacheHitRate)
    expect(a.costSavingsUsd).toBe(b.costSavingsUsd)
    expect(a.perModel.size).toBe(b.perModel.size)
    expect(a.perSession.size).toBe(b.perSession.size)
    expect(a.breakpoints?.size).toBe(b.breakpoints?.size)
  })

  test("[24] injected clock drives metric sample.at deterministically", () => {
    const { sink, samples } = makeRecordingSink()
    let t = 5_000_000_000_000
    const o = defaultPromptCacheObserver({ metricsSink: sink, now: () => t })
    o.record(evt({ inputTokens: 100 }))
    // All 4 samples should carry the same injected `at`.
    for (const s of samples) expect(s.at).toBe(5_000_000_000_000)
    samples.length = 0
    t = 9_999_999_999_999
    o.record(evt({ inputTokens: 50 }))
    for (const s of samples) expect(s.at).toBe(9_999_999_999_999)
  })
})
