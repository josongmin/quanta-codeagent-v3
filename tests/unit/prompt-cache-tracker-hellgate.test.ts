/**
 * ★ CONTRACT — ADR-0182 prompt-cache tracker math + extracted pricing table +
 *   `prompt_cache_status` tool surface. This battery is COMPLEMENTARY to
 *   `prompt-cache-observability-hellgate.test.ts` (the observer-internal
 *   24-case battery): it covers the new pricing-table extraction, sink
 *   integration edges left implicit by the observer battery (sink throws +
 *   sink absent), and the tool surface (metadata, snapshot rendering,
 *   unwired branch).
 *
 * HELLGATE — 20 adversarial cases:
 *   A. record + metrics math (1-8)
 *      1. single event, all regular input (0 cache) → hitRate=0, savings=0.
 *      2. single event, all cache_read → large savings, hitRate==0 (denom 0)
 *         per the documented formula (cache_read / (input + cache_create)).
 *      3. mixed event → correct ratios.
 *      4. multi-event same session → aggregates monotonic.
 *      5. multi-session → per-session isolation in snapshot.
 *      6. unknown model → fallback pricing (sonnet) applied, observer warns.
 *      7. zero tokens → cost=0, no NaN, no negative.
 *      8. very large counts (1 B tokens) → no overflow, finite.
 *   B. Sink integration (9-11)
 *      9. sink absent → no error, metrics still computable.
 *      10. sink wired → record fires 4 metric.send calls.
 *      11. sink throws → no-throw collapse.
 *   C. Aggregate-only compatibility + reset (12-13)
 *      12. maxEvents remains a source-compatible no-op on the aggregate-only
 *          adapter.
 *      13. reset() → all aggregates clear; subsequent record builds anew.
 *   D. Tool surface (14-16)
 *      14. tool metadata (name, read-only, concurrency-safe).
 *      15. tool execute → ok:true with formatted lifetime header.
 *      16. tool execute when tracker absent → ok:false typed message.
 */

import { describe, expect, test } from "bun:test"
import {
  type CacheHitEvent,
  DEFAULT_PROMPT_CACHE_PRICING,
  defaultPromptCacheObserver,
  FALLBACK_PRICING_MODEL,
  PromptCacheError,
} from "@/observability/prompt-cache"
import { promptCacheStatusTool, promptCacheStatusUnwiredTool } from "@/tool/prompt_cache_status"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

// ── Test harness helpers ────────────────────────────────────────────────

const ctx = (): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
})

const evt = (overrides: Partial<CacheHitEvent>): CacheHitEvent => ({
  model: "claude-sonnet-4-6",
  sessionId: "s1",
  turnIndex: 0,
  atMs: 1_700_000_000_000,
  inputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  ...overrides,
})

interface ExecutableTool {
  execute(input: unknown, c: ToolContext): AsyncIterable<ToolEvent>
}

const collect = async (tool: ExecutableTool, input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx())) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("tool produced no terminal result")
  return result
}

/** Sink shape inlined here (we deliberately avoid `@/observability/metrics`
 *  in this file because the legacy `src/observability/metrics.ts` shim
 *  shadows the directory — the tests/unit/observability-metrics-*.test.ts
 *  files import the `/index` subpath explicitly; for THIS battery the sink
 *  is a thin local mirror that only needs `send`). */
interface LocalSink {
  send(s: unknown): void
  samples: unknown[]
}
const makeSink = (): LocalSink => {
  const samples: unknown[] = []
  return {
    send(s: unknown): void {
      samples.push(s)
    },
    samples,
  }
}

// ── A. record + metrics math (1-8) ─────────────────────────────────────

describe("ADR-0182 — prompt-cache tracker math (A)", () => {
  test("[1] single event, all regular input → hitRate=0 + savings=0", () => {
    const o = defaultPromptCacheObserver()
    o.record(evt({ inputTokens: 500 }))
    const s = o.snapshot()
    expect(s.cacheHitRate).toBe(0)
    expect(s.costSavingsUsd).toBe(0)
    expect(s.totalInputTokens).toBe(500)
    expect(s.totalCacheReadTokens).toBe(0)
  })

  test("[2] single event, all cache_read → savings populated (denom=0 ⇒ hitRate=0)", () => {
    // Pure cache-read event with no input/create: per the documented formula
    // hit rate = cache_read / (input + cache_create) → 1_000_000 / 0 → 0
    // (no NaN). Savings still computed: 1M sonnet cache_read = $2.70.
    const o = defaultPromptCacheObserver()
    o.record(evt({ cacheReadTokens: 1_000_000 }))
    const s = o.snapshot()
    expect(s.cacheHitRate).toBe(0)
    expect(s.costSavingsUsd).toBeCloseTo(2.7, 6)
    expect(s.totalCacheReadTokens).toBe(1_000_000)
  })

  test("[3] mixed event → ratios match formula", () => {
    // input=100, cache_create=20, cache_read=80 → hitRate = 80 / 120 = 2/3.
    // Savings on sonnet (cache_read 80) = 80 * (3 - 0.3) / 1M = 0.000216.
    const o = defaultPromptCacheObserver()
    o.record(evt({ inputTokens: 100, cacheCreationTokens: 20, cacheReadTokens: 80 }))
    const s = o.snapshot()
    expect(s.cacheHitRate).toBeCloseTo(80 / 120, 6)
    expect(s.costSavingsUsd).toBeCloseTo((80 * 2.7) / 1_000_000, 9)
  })

  test("[4] multi-event same session → aggregates sum", () => {
    const o = defaultPromptCacheObserver()
    o.record(evt({ inputTokens: 100, cacheReadTokens: 200 }))
    o.record(evt({ inputTokens: 50, cacheReadTokens: 300 }))
    o.record(evt({ inputTokens: 25, cacheReadTokens: 100 }))
    const s = o.snapshot()
    expect(s.totalInputTokens).toBe(175)
    expect(s.totalCacheReadTokens).toBe(600)
    // perSession s1 has one row
    expect(s.perSession.size).toBe(1)
    expect(s.perSession.get("s1")?.totalCacheReadTokens).toBe(600)
  })

  test("[5] multi-session → per-session isolation", () => {
    const o = defaultPromptCacheObserver()
    o.record(
      evt({ sessionId: "A", model: "claude-sonnet-4-6", inputTokens: 100, cacheReadTokens: 200 }),
    )
    o.record(
      evt({ sessionId: "A", model: "claude-opus-4-7", inputTokens: 25, cacheReadTokens: 50 }),
    )
    o.record(
      evt({ sessionId: "B", model: "claude-haiku-4-5", inputTokens: 50, cacheReadTokens: 999 }),
    )
    const s = o.snapshot()
    expect(s.perSession.size).toBe(2)
    expect(s.perSession.get("A")?.totalInputTokens).toBe(125)
    expect(s.perSession.get("A")?.totalCacheReadTokens).toBe(250)
    expect(s.perSession.get("A")?.perModel.size).toBe(2)
    expect(s.perSession.get("A")?.perModel.get("claude-opus-4-7")?.cacheReadTokens).toBe(50)
    expect(s.perSession.get("B")?.totalCacheReadTokens).toBe(999)
    expect(s.perSession.get("B")?.perModel.get("claude-haiku-4-5")?.cacheReadTokens).toBe(999)
    expect(s.perSession.get("B")?.perModel.get("claude-sonnet-4-6")).toBeUndefined()
  })

  test("[6] unknown model → fallback pricing (sonnet rates) applied", () => {
    const o = defaultPromptCacheObserver()
    o.record(evt({ model: "unknown-vendor-v9", cacheReadTokens: 1_000_000 }))
    const s = o.snapshot()
    // Sonnet rates → 2.70 savings, NOT zero (unknown model fall-through is
    // safe-LOUD: aggregates still credit the unknown model).
    expect(s.costSavingsUsd).toBeCloseTo(2.7, 6)
    expect(s.perModel.get("unknown-vendor-v9")?.cacheReadTokens).toBe(1_000_000)
    // Sanity: the fallback model exists in the bundled table.
    expect(DEFAULT_PROMPT_CACHE_PRICING[FALLBACK_PRICING_MODEL]).toBeDefined()
  })

  test("[6.a] gpt-5.6-terra uses its own current cache rates, not sonnet fallback", () => {
    const pricing = DEFAULT_PROMPT_CACHE_PRICING["gpt-5.6-terra"]
    expect(pricing).toEqual({
      inputPerM: 2,
      outputPerM: 12,
      cacheCreationPerM: 2.5,
      cacheReadPerM: 0.2,
    })
    const o = defaultPromptCacheObserver()
    o.record(evt({ model: "gpt-5.6-terra", cacheReadTokens: 1_000_000 }))
    expect(o.snapshot().costSavingsUsd).toBeCloseTo(1.8, 6)
  })

  test("[7] zero-token event → cost=0, no NaN, no Infinity, no negative", () => {
    const o = defaultPromptCacheObserver()
    o.record(evt({}))
    const s = o.snapshot()
    expect(s.cacheHitRate).toBe(0)
    expect(s.costSavingsUsd).toBe(0)
    expect(Number.isFinite(s.cacheHitRate)).toBe(true)
    expect(Number.isFinite(s.costSavingsUsd)).toBe(true)
    expect(s.costSavingsUsd).toBeGreaterThanOrEqual(0)
  })

  test("[8] 1 B tokens → no overflow, savings finite", () => {
    const o = defaultPromptCacheObserver()
    o.record(
      evt({ model: "claude-opus-4-7", inputTokens: 1_000_000_000, cacheReadTokens: 1_000_000_000 }),
    )
    const s = o.snapshot()
    // Opus: cache read 1 B tokens × (15 - 1.5) / 1M = $13_500.
    expect(s.costSavingsUsd).toBeCloseTo(13_500, 0)
    expect(Number.isFinite(s.costSavingsUsd)).toBe(true)
    expect(Number.isFinite(s.cacheHitRate)).toBe(true)
  })

  test("[7.b] negative-tokens still throws PromptCacheError", () => {
    // Closed-error invariant: the one validation surface is still in place.
    const o = defaultPromptCacheObserver()
    expect(() => o.record(evt({ inputTokens: -1 }))).toThrow(PromptCacheError)
    expect(o.snapshot().totalInputTokens).toBe(0)
  })
})

// ── B. Sink integration (9-11) ──────────────────────────────────────────

describe("ADR-0182 — prompt-cache tracker sink (B)", () => {
  test("[9] sink absent → record works, snapshot computable", () => {
    const o = defaultPromptCacheObserver()
    expect(() => o.record(evt({ inputTokens: 100, cacheReadTokens: 50 }))).not.toThrow()
    expect(o.snapshot().totalCacheReadTokens).toBe(50)
  })

  test("[10] sink wired → record fires 4 metric.send calls", () => {
    const sink = makeSink()
    // The observer's `metricsSink` option requires a `MetricSink` shape; we
    // cast through `as never` to satisfy the type without importing the
    // shadowed `@/observability/metrics` barrel here.
    const o = defaultPromptCacheObserver({ metricsSink: sink as never })
    o.record(evt({ inputTokens: 100, cacheReadTokens: 50, cacheCreationTokens: 20 }))
    expect(sink.samples).toHaveLength(4)
    // Sanity: names cover the 4 expected metric ids.
    const names = (sink.samples as { name: string }[]).map((s) => s.name).sort()
    expect(names).toEqual([
      "prompt_cache.cache_read_tokens",
      "prompt_cache.cache_write_tokens",
      "prompt_cache.hit_rate",
      "prompt_cache.input_tokens",
    ])
  })

  test("[11] sink throws → record does not throw; aggregates still update", () => {
    const throwingSink = {
      send(): void {
        throw new Error("sink boom")
      },
    }
    const o = defaultPromptCacheObserver({ metricsSink: throwingSink as never })
    expect(() => o.record(evt({ inputTokens: 100, cacheReadTokens: 50 }))).not.toThrow()
    expect(o.snapshot().totalCacheReadTokens).toBe(50)
  })
})

// ── C. Aggregate-only compatibility + reset (12-13) ───────────────────

describe("ADR-0182 — prompt-cache tracker aggregate-only + reset (C)", () => {
  test("[12] maxEvents stays source-compatible but does not change aggregate semantics", () => {
    const bounded = defaultPromptCacheObserver({ maxEvents: 10 })
    const unbounded = defaultPromptCacheObserver()
    for (let i = 0; i < 15; i += 1) {
      const event = evt({
        sessionId: i % 2 === 0 ? "even" : "odd",
        model:
          i % 3 === 0 ? "claude-sonnet-4-6" : i % 3 === 1 ? "claude-opus-4-7" : "claude-haiku-4-5",
        inputTokens: i + 1,
        cacheReadTokens: i,
      })
      bounded.record(event)
      unbounded.record(event)
    }
    const boundedSnap = bounded.snapshot()
    const unboundedSnap = unbounded.snapshot()
    expect(boundedSnap.totalInputTokens).toBe(unboundedSnap.totalInputTokens)
    expect(boundedSnap.totalCacheReadTokens).toBe(unboundedSnap.totalCacheReadTokens)
    expect(boundedSnap.perSession.get("even")?.perModel.size).toBe(
      unboundedSnap.perSession.get("even")?.perModel.size,
    )
  })

  test("[13] reset() clears every aggregate", () => {
    const o = defaultPromptCacheObserver()
    o.record(evt({ inputTokens: 100, cacheReadTokens: 50 }))
    o.attributeBreakpoint("system-prefix", 1000, true)
    o.reset()
    const s = o.snapshot()
    expect(s.totalInputTokens).toBe(0)
    expect(s.totalCacheReadTokens).toBe(0)
    expect(s.costSavingsUsd).toBe(0)
    expect(s.perModel.size).toBe(0)
    expect(s.perSession.size).toBe(0)
    expect(s.breakpoints).toBeUndefined()
    // ... and a subsequent record builds anew from zero.
    o.record(evt({ inputTokens: 7 }))
    expect(o.snapshot().totalInputTokens).toBe(7)
  })
})

// ── D. Tool surface (14-16) ─────────────────────────────────────────────

describe("ADR-0182 — prompt_cache_status tool (D)", () => {
  test("[14] tool metadata (name, read-only, concurrency-safe)", () => {
    const o = defaultPromptCacheObserver()
    const t = promptCacheStatusTool(o)
    expect(t.name).toBe("prompt_cache_status")
    expect(t.isReadOnly()).toBe(true)
    expect(t.isConcurrencySafe({} as never)).toBe(true)
    // Unwired tool surface has the same shape (caller can swap if no observer).
    const u = promptCacheStatusUnwiredTool()
    expect(u.name).toBe("prompt_cache_status")
    expect(u.isReadOnly()).toBe(true)
    expect(u.isConcurrencySafe({} as never)).toBe(true)
  })

  test("[15] execute → ok:true with formatted lifetime header + savings line", async () => {
    const o = defaultPromptCacheObserver()
    o.record(
      evt({
        model: "claude-opus-4-7",
        inputTokens: 1_000,
        cacheCreationTokens: 500,
        cacheReadTokens: 10_000,
      }),
    )
    o.attributeBreakpoint("system-prefix", 5_000, true)
    const t = promptCacheStatusTool(o)
    const r = await collect(t, {})
    expect(r.ok).toBe(true)
    // Header sentinel
    expect(r.output).toContain("Prompt cache report:")
    expect(r.output).toContain("Hit rate:")
    expect(r.output).toContain("Savings:")
    // Per-session list rendered
    expect(r.output).toContain("By session")
    // Breakpoint section rendered
    expect(r.output).toContain("By breakpoint:")
    expect(r.output).toContain("system-prefix")
    // 10K cache_read on opus = $0.135 savings; we don't pin the exact pennies,
    // just that the dollar sign + formula footnote are present.
    expect(r.output).toMatch(/\$\d+\.\d{2}/)
    expect(r.output).toContain("Savings =")
  })

  test("[15.b] execute with sessionId filter → drill-down section", async () => {
    const o = defaultPromptCacheObserver()
    o.record(evt({ sessionId: "alpha", inputTokens: 100, cacheReadTokens: 50 }))
    o.record(evt({ sessionId: "beta", inputTokens: 200 }))
    const t = promptCacheStatusTool(o)
    const r = await collect(t, { sessionId: "alpha" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("Session alpha:")
    // The drill-down does NOT include the all-sessions list table heading.
    expect(r.output).not.toContain("By session (top by savings):")
  })

  test("[15.c] execute with sessionId that has no events → ok:true + helpful note", async () => {
    const o = defaultPromptCacheObserver()
    o.record(evt({ sessionId: "real", inputTokens: 10 }))
    const t = promptCacheStatusTool(o)
    const r = await collect(t, { sessionId: "ghost" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('(no events recorded for session "ghost")')
  })

  test("[16] tracker absent → ok:false with typed 'observer_not_attached'", async () => {
    const t = promptCacheStatusUnwiredTool()
    const r = await collect(t, {})
    expect(r.ok).toBe(false)
    expect(r.output).toContain("no prompt-cache observer is wired")
    expect(r.failure?.mode).toBe("rejected")
    if (r.failure?.mode === "rejected") {
      expect(r.failure.reason).toBe("observer_not_attached")
    }
  })

  test("[16.b] tracker abort signal pre-set → ok:false with rejected/aborted", async () => {
    const o = defaultPromptCacheObserver()
    const t = promptCacheStatusTool(o)
    const ac = new AbortController()
    ac.abort()
    let result: ToolResult | undefined
    for await (const ev of t.execute({ topN: 5 }, { cwd: "/tmp", signal: ac.signal })) {
      if (ev.type === "result") result = ev.result
    }
    expect(result?.ok).toBe(false)
    expect(result?.failure?.mode).toBe("rejected")
  })
})
