import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { defaultMetricsRegistry } from "@/observability/metrics/index"
import {
  defaultToolCallCache,
  instrumentToolWithDedup,
  RECOMMENDED_PER_TOOL_TTL_MS,
  type ToolCallCache,
  type ToolDedupOpts,
} from "@/observability/metrics/instrument-tool-dedup"
import type { MetricSnapshot, MetricsRegistry } from "@/observability/metrics/port"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "@/tool"

/**
 * Tool-call dedup hellgate (ADR-0172).
 *
 * Pins:
 *   - `defaultToolCallCache`: TTL / LRU / clear / hit-vs-miss semantics.
 *   - `instrumentToolWithDedup` wrap: cache-hit short-circuits `execute`,
 *     emits `[from_cache] ` marker, increments
 *     `tool.call.dedup_collapse.total{tool}`; cwd-scoped keys; predicate
 *     opt-out path; ok:false caching; throwing-metrics no-throw invariant.
 */

// ── Fixture helpers ──────────────────────────────────────────────────────

interface FakeInput {
  q: string
}

const fakeCtx = (cwd = "/wd"): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

const fakeTool = (
  overrides: {
    name?: string
    isReadOnly?: boolean
    isConcurrencySafe?: boolean
    hitlTier?: Tool["hitlTier"]
    execute?: (input: FakeInput, ctx: ToolContext) => AsyncIterable<ToolEvent>
    callLog?: { count: number }
  } = {},
): Tool<FakeInput> => {
  const log = overrides.callLog
  const baseExecute =
    overrides.execute ??
    async function* (input: FakeInput) {
      yield {
        type: "result" as const,
        result: { ok: true, output: `result-for-${input.q}` } satisfies ToolResult,
      }
    }
  return {
    name: overrides.name ?? "fake",
    description: "fake tool",
    inputSchema: z.object({ q: z.string() }),
    isReadOnly: () => overrides.isReadOnly ?? true,
    isConcurrencySafe: () => overrides.isConcurrencySafe ?? true,
    ...(overrides.hitlTier ? { hitlTier: overrides.hitlTier } : {}),
    async *execute(input: FakeInput, ctx: ToolContext) {
      if (log) log.count++
      yield* baseExecute(input, ctx)
    },
  }
}

const drain = async (it: AsyncIterable<ToolEvent>): Promise<ToolEvent[]> => {
  const out: ToolEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

// ─────────────────────────────────────────────────────────────────────────
// A. defaultToolCallCache
// ─────────────────────────────────────────────────────────────────────────

describe("defaultToolCallCache", () => {
  test("HELL-CACHE-1: set → get returns the result for same key", () => {
    const cache = defaultToolCallCache()
    const ctx = fakeCtx()
    const key = cache.computeKey("fake", { q: "a" }, ctx)
    const stored: ToolResult = { ok: true, output: "value" }
    cache.set(key, stored)
    expect(cache.get(key)?.output).toBe("value")
  })

  test("HELL-CACHE-2: miss returns null", () => {
    const cache = defaultToolCallCache()
    expect(cache.get("nonexistent")).toBe(null)
  })

  test("HELL-CACHE-3: TTL expiry — past TTL returns null", () => {
    let now = 0
    const cache = defaultToolCallCache({ ttlMs: 1000, now: () => now })
    const ctx = fakeCtx()
    const key = cache.computeKey("fake", { q: "a" }, ctx)
    cache.set(key, { ok: true, output: "v" })
    now = 999
    expect(cache.get(key)?.output).toBe("v") // still alive at boundary
    now = 1001
    expect(cache.get(key)).toBe(null) // expired
    // And the entry is dropped — second lookup also null.
    expect(cache.get(key)).toBe(null)
  })

  test("HELL-CACHE-4: LRU eviction at maxEntries — oldest dropped on overflow", () => {
    const cache = defaultToolCallCache({ maxEntries: 2 })
    cache.set("k1", { ok: true, output: "1" })
    cache.set("k2", { ok: true, output: "2" })
    cache.set("k3", { ok: true, output: "3" }) // overflow → k1 evicted
    expect(cache.get("k1")).toBe(null)
    expect(cache.get("k2")?.output).toBe("2")
    expect(cache.get("k3")?.output).toBe("3")
  })

  test("HELL-CACHE-5: clear() empties the cache", () => {
    const cache = defaultToolCallCache()
    cache.set("k1", { ok: true, output: "1" })
    cache.set("k2", { ok: true, output: "2" })
    cache.clear()
    expect(cache.get("k1")).toBe(null)
    expect(cache.get("k2")).toBe(null)
  })

  test("HELL-CACHE-6: get touches LRU — recently-read entry survives eviction", () => {
    const cache = defaultToolCallCache({ maxEntries: 2 })
    cache.set("k1", { ok: true, output: "1" })
    cache.set("k2", { ok: true, output: "2" })
    // Touch k1 so it becomes most-recently-used.
    expect(cache.get("k1")?.output).toBe("1")
    cache.set("k3", { ok: true, output: "3" }) // overflow → k2 evicted, not k1
    expect(cache.get("k1")?.output).toBe("1")
    expect(cache.get("k2")).toBe(null)
    expect(cache.get("k3")?.output).toBe("3")
  })

  test("HELL-CACHE-7: stableStringify — key invariant across object-key order", () => {
    const cache = defaultToolCallCache()
    const ctx = fakeCtx()
    const k1 = cache.computeKey("fake", { a: 1, b: 2 }, ctx)
    const k2 = cache.computeKey("fake", { b: 2, a: 1 }, ctx)
    expect(k1).toBe(k2)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// B. instrumentToolWithDedup wrap
// ─────────────────────────────────────────────────────────────────────────

describe("instrumentToolWithDedup", () => {
  test("HELL-WRAP-1: first call executes the tool; cache populated; no dedup counter", async () => {
    const m = defaultMetricsRegistry()
    const cache = defaultToolCallCache()
    const log = { count: 0 }
    const t = fakeTool({ callLog: log })
    const wrapped = instrumentToolWithDedup(t, m, { cache })

    const events = await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    expect(log.count).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe("result")
    if (events[0]?.type === "result") {
      expect(events[0].result.output).toBe("result-for-a")
    }
    expect(m.snapshot().find((s) => s.name === "tool.call.dedup_collapse.total")).toBeUndefined()
  })

  test("HELL-WRAP-2: second identical call hits cache, emits marker + counter, skips execute", async () => {
    const m = defaultMetricsRegistry()
    const cache = defaultToolCallCache()
    const log = { count: 0 }
    const t = fakeTool({ callLog: log })
    const wrapped = instrumentToolWithDedup(t, m, { cache })

    await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    const events2 = await drain(wrapped.execute({ q: "a" }, fakeCtx()))

    // execute called exactly once (the second call was served from cache).
    expect(log.count).toBe(1)
    expect(events2).toHaveLength(1)
    if (events2[0]?.type === "result") {
      expect(events2[0].result.output).toBe("[from_cache] result-for-a")
      expect(events2[0].result.ok).toBe(true)
    }
    const counter = m.snapshot().find((s) => s.name === "tool.call.dedup_collapse.total")
    expect(counter?.value).toBe(1)
    expect(counter?.labels.tool).toBe("fake")
  })

  test("HELL-WRAP-3: different input → different key → no hit, counter stays 0", async () => {
    const m = defaultMetricsRegistry()
    const cache = defaultToolCallCache()
    const log = { count: 0 }
    const t = fakeTool({ callLog: log })
    const wrapped = instrumentToolWithDedup(t, m, { cache })

    await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    await drain(wrapped.execute({ q: "b" }, fakeCtx()))
    expect(log.count).toBe(2)
    expect(m.snapshot().find((s) => s.name === "tool.call.dedup_collapse.total")).toBeUndefined()
  })

  test("HELL-WRAP-4: shouldCache=false → no caching, no counter, even after repeat", async () => {
    const m = defaultMetricsRegistry()
    const cache = defaultToolCallCache()
    const log = { count: 0 }
    const t = fakeTool({ callLog: log })
    const opts: ToolDedupOpts = { cache, shouldCache: () => false }
    const wrapped = instrumentToolWithDedup(t, m, opts)

    await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    expect(log.count).toBe(2)
    expect(m.snapshot().find((s) => s.name === "tool.call.dedup_collapse.total")).toBeUndefined()
  })

  test("HELL-WRAP-5: default predicate gates on isReadOnly=false (mutating tool)", async () => {
    const m = defaultMetricsRegistry()
    const cache = defaultToolCallCache()
    const log = { count: 0 }
    const t = fakeTool({ isReadOnly: false, callLog: log })
    const wrapped = instrumentToolWithDedup(t, m, { cache })

    await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    expect(log.count).toBe(2) // both executed, no caching
    expect(m.snapshot().find((s) => s.name === "tool.call.dedup_collapse.total")).toBeUndefined()
  })

  test("HELL-WRAP-6: default predicate gates on hitlTier === always-confirm", async () => {
    const m = defaultMetricsRegistry()
    const cache = defaultToolCallCache()
    const log = { count: 0 }
    const t = fakeTool({ hitlTier: () => "always-confirm", callLog: log })
    const wrapped = instrumentToolWithDedup(t, m, { cache })

    await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    expect(log.count).toBe(2)
    expect(m.snapshot().find((s) => s.name === "tool.call.dedup_collapse.total")).toBeUndefined()
  })

  test("HELL-WRAP-7: ok:false result is cached too; second call yields [from_cache] failure", async () => {
    const m = defaultMetricsRegistry()
    const cache = defaultToolCallCache()
    const log = { count: 0 }
    const t = fakeTool({
      callLog: log,
      execute: async function* () {
        yield { type: "result", result: { ok: false, output: "boom" } satisfies ToolResult }
      },
    })
    const wrapped = instrumentToolWithDedup(t, m, { cache })

    await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    const events = await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    expect(log.count).toBe(1)
    if (events[0]?.type === "result") {
      expect(events[0].result.ok).toBe(false)
      expect(events[0].result.output).toBe("[from_cache] boom")
    }
  })

  test("HELL-WRAP-8: ctx.cwd diff → different keys → no hit (cwd-scoped cache)", async () => {
    const m = defaultMetricsRegistry()
    const cache = defaultToolCallCache()
    const log = { count: 0 }
    const t = fakeTool({ callLog: log })
    const wrapped = instrumentToolWithDedup(t, m, { cache })

    await drain(wrapped.execute({ q: "a" }, fakeCtx("/wd-A")))
    await drain(wrapped.execute({ q: "a" }, fakeCtx("/wd-B")))
    expect(log.count).toBe(2)
    expect(m.snapshot().find((s) => s.name === "tool.call.dedup_collapse.total")).toBeUndefined()
  })

  test("HELL-WRAP-9: throwing metrics swallowed; tool result still flows + marker still applied", async () => {
    const throwing: MetricsRegistry = {
      ...defaultMetricsRegistry(),
      increment: () => {
        throw new Error("registry-broken")
      },
    } as never
    const cache = defaultToolCallCache()
    const t = fakeTool()
    const wrapped = instrumentToolWithDedup(t, throwing, { cache })

    await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    const events = await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    if (events[0]?.type === "result") {
      expect(events[0].result.output).toBe("[from_cache] result-for-a")
    }
  })

  test("HELL-WRAP-10: progress events from cache MISS pass through verbatim", async () => {
    const m = defaultMetricsRegistry()
    const cache = defaultToolCallCache()
    const t = fakeTool({
      execute: async function* () {
        yield { type: "progress", message: "thinking" }
        yield { type: "result", result: { ok: true, output: "done" } }
      },
    })
    const wrapped = instrumentToolWithDedup(t, m, { cache })

    const events = await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    expect(events.map((e) => e.type)).toEqual(["progress", "result"])
  })

  test("HELL-WRAP-11: cache-HIT yields exactly one event (no progress replay)", async () => {
    const m = defaultMetricsRegistry()
    const cache = defaultToolCallCache()
    const t = fakeTool({
      execute: async function* () {
        yield { type: "progress", message: "thinking" }
        yield { type: "result", result: { ok: true, output: "done" } }
      },
    })
    const wrapped = instrumentToolWithDedup(t, m, { cache })

    await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    const events2 = await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    expect(events2.map((e) => e.type)).toEqual(["result"])
    if (events2[0]?.type === "result") {
      expect(events2[0].result.output).toBe("[from_cache] done")
    }
  })

  test("HELL-WRAP-12: toolLabel override changes counter label", async () => {
    const m = defaultMetricsRegistry()
    const cache = defaultToolCallCache()
    const t = fakeTool({ name: "raw" })
    const wrapped = instrumentToolWithDedup(t, m, { cache, toolLabel: "facet" })

    await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    const c = m.snapshot().find((s) => s.name === "tool.call.dedup_collapse.total")
    expect(c?.labels.tool).toBe("facet")
  })

  test("HELL-WRAP-13: custom ToolCallCache port honored (not the default impl)", async () => {
    const m = defaultMetricsRegistry()
    const calls = { computeKey: 0, get: 0, set: 0, clear: 0 }
    const inner = new Map<string, ToolResult>()
    const customCache: ToolCallCache = {
      computeKey: (n) => {
        calls.computeKey++
        return `custom:${n}`
      },
      get: (k) => {
        calls.get++
        return inner.get(k) ?? null
      },
      set: (k, r) => {
        calls.set++
        inner.set(k, r)
      },
      clear: () => {
        calls.clear++
        inner.clear()
      },
    }
    const t = fakeTool()
    const wrapped = instrumentToolWithDedup(t, m, { cache: customCache })
    await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    expect(calls.computeKey).toBeGreaterThanOrEqual(2)
    expect(calls.set).toBe(1)
    expect(calls.get).toBe(2)
  })
})

/* ------------------------------------------------------------------ */
/* merged from observability-metrics-tool-dedup-ttl-hellgate.test.ts (ADR-0179) */
/* ------------------------------------------------------------------ */

// ─────────────────────────────────────────────────────────────────────────
// A. defaultToolCallCache — per-tool TTL resolution
// ─────────────────────────────────────────────────────────────────────────

describe("defaultToolCallCache — perToolTtlMs", () => {
  test("HELL-TTL-1: per-tool override beats global — read survives global ttl", () => {
    let now = 0
    const cache = defaultToolCallCache({
      ttlMs: 30_000,
      perToolTtlMs: { read: 60_000 },
      now: () => now,
    })
    const ctx = fakeCtx()
    const key = cache.computeKey("read", { path: "a.ts" }, ctx)
    cache.set(key, { ok: true, output: "content" }, "read")
    // Past the GLOBAL ttl (30s) but inside the per-tool override (60s).
    now = 50_000
    expect(cache.get(key)?.output).toBe("content")
    // Past the per-tool override too → expired.
    now = 60_001
    expect(cache.get(key)).toBe(null)
  })

  test("HELL-TTL-2: tool not in perToolTtlMs falls through to global ttlMs", () => {
    let now = 0
    const cache = defaultToolCallCache({
      ttlMs: 1_000,
      perToolTtlMs: { read: 60_000 },
      now: () => now,
    })
    const ctx = fakeCtx()
    const key = cache.computeKey("not_listed", { q: "x" }, ctx)
    cache.set(key, { ok: true, output: "v" }, "not_listed")
    now = 999
    expect(cache.get(key)?.output).toBe("v")
    now = 1_001
    expect(cache.get(key)).toBe(null)
  })

  test("HELL-TTL-3: perToolTtlMs[read]=0 → read never caches (every get is miss)", () => {
    let now = 0
    const cache = defaultToolCallCache({
      ttlMs: 30_000,
      perToolTtlMs: { read: 0 },
      now: () => now,
    })
    const ctx = fakeCtx()
    const key = cache.computeKey("read", { q: "x" }, ctx)
    cache.set(key, { ok: true, output: "v" }, "read")
    // Same tick: still a miss because 0-TTL stores nothing.
    expect(cache.get(key)).toBe(null)
    // Advance time: still a miss.
    now = 5
    expect(cache.get(key)).toBe(null)
    // Re-set + immediately re-get: still miss.
    cache.set(key, { ok: true, output: "v2" }, "read")
    expect(cache.get(key)).toBe(null)
  })

  test("HELL-TTL-4: different tool names → independent TTL (read=60s, grep=30s, set at t=0)", () => {
    let now = 0
    const cache = defaultToolCallCache({
      ttlMs: 10_000, // global default the test should NOT hit
      perToolTtlMs: { read: 60_000, grep: 30_000 },
      now: () => now,
    })
    const ctx = fakeCtx()
    const readKey = cache.computeKey("read", { q: "r" }, ctx)
    const grepKey = cache.computeKey("grep", { q: "g" }, ctx)
    cache.set(readKey, { ok: true, output: "read-v" }, "read")
    cache.set(grepKey, { ok: true, output: "grep-v" }, "grep")
    // At t=20s: both still alive.
    now = 20_000
    expect(cache.get(readKey)?.output).toBe("read-v")
    expect(cache.get(grepKey)?.output).toBe("grep-v")
    // At t=30_001: grep expired, read still alive.
    now = 30_001
    expect(cache.get(grepKey)).toBe(null)
    expect(cache.get(readKey)?.output).toBe("read-v")
    // At t=60_001: read expired too.
    now = 60_001
    expect(cache.get(readKey)).toBe(null)
  })

  test("HELL-TTL-5: RECOMMENDED preset has never-cache (0) for bash, web_fetch, web_search", () => {
    expect(RECOMMENDED_PER_TOOL_TTL_MS.bash).toBe(0)
    expect(RECOMMENDED_PER_TOOL_TTL_MS.web_fetch).toBe(0)
    expect(RECOMMENDED_PER_TOOL_TTL_MS.web_search).toBe(0)
  })

  test("HELL-TTL-6: RECOMMENDED preset has read=60_000ms (longest safe read TTL)", () => {
    expect(RECOMMENDED_PER_TOOL_TTL_MS.read).toBe(60_000)
    // The preset should also be frozen (caller cannot accidentally mutate it).
    expect(Object.isFrozen(RECOMMENDED_PER_TOOL_TTL_MS)).toBe(true)
  })

  test("HELL-TTL-7: tool name routing — wrap calls set() with tool.name (asserted via never-cache)", async () => {
    const m = defaultMetricsRegistry()
    // If the wrap forwards tool.name correctly, the per-tool TTL of 0 for
    // "fake" will defeat caching (no [from_cache] marker, second call also
    // executes). If it forgot to pass the name, the global ttlMs would kick
    // in and the second call would hit cache.
    const cache = defaultToolCallCache({
      ttlMs: 30_000,
      perToolTtlMs: { fake: 0 },
    })
    const log = { count: 0 }
    const t = fakeTool({ callLog: log })
    const wrapped = instrumentToolWithDedup(t, m, { cache })

    await drain(wrapped.execute({ q: "a" }, fakeCtx()))
    const events2 = await drain(wrapped.execute({ q: "a" }, fakeCtx()))

    expect(log.count).toBe(2) // second call NOT served from cache
    if (events2[0]?.type === "result") {
      expect(events2[0].result.output).toBe("result-for-a") // no [from_cache] marker
    }
    expect(m.snapshot().find((s) => s.name === "tool.call.dedup_collapse.total")).toBeUndefined()
  })

  test("HELL-TTL-8: determinism — same inputs + same clock yield identical eviction order", () => {
    // Build two caches with identical opts; perform the same operations on
    // both; assert the same set of keys survives at the end.
    const buildOps = (cache: ReturnType<typeof defaultToolCallCache>) => {
      const ctx = fakeCtx()
      // Two tools with different TTL classes; insert interleaved.
      const k1 = cache.computeKey("read", { q: "1" }, ctx)
      const k2 = cache.computeKey("grep", { q: "2" }, ctx)
      const k3 = cache.computeKey("read", { q: "3" }, ctx)
      cache.set(k1, { ok: true, output: "1" }, "read")
      cache.set(k2, { ok: true, output: "2" }, "grep")
      cache.set(k3, { ok: true, output: "3" }, "read")
      return [k1, k2, k3]
    }
    let now1 = 0
    let now2 = 0
    const opts = { ttlMs: 10_000, perToolTtlMs: { read: 60_000, grep: 5_000 } }
    const a = defaultToolCallCache({ ...opts, now: () => now1 })
    const b = defaultToolCallCache({ ...opts, now: () => now2 })
    const ka = buildOps(a)
    const kb = buildOps(b)
    expect(ka).toEqual(kb)
    // Advance clocks identically — grep should be the only one expiring.
    now1 = 6_000
    now2 = 6_000
    const surviveA = ka.map((k) => a.get(k)?.output ?? null)
    const surviveB = kb.map((k) => b.get(k)?.output ?? null)
    expect(surviveA).toEqual(surviveB)
    expect(surviveA).toEqual(["1", null, "3"])
  })

  test("HELL-TTL-9: legacy set() without toolName falls through to global ttlMs (back-compat)", () => {
    let now = 0
    const cache = defaultToolCallCache({
      ttlMs: 1_000,
      perToolTtlMs: { read: 60_000 }, // configured but irrelevant for nameless set
      now: () => now,
    })
    cache.set("k", { ok: true, output: "v" }) // no toolName arg
    now = 999
    expect(cache.get("k")?.output).toBe("v")
    now = 1_001
    expect(cache.get("k")).toBe(null)
  })

  test("HELL-TTL-10: opts absent → byte-identical to ADR-0176 (global ttlMs only)", () => {
    let now = 0
    const cache = defaultToolCallCache({ ttlMs: 5_000, now: () => now })
    const ctx = fakeCtx()
    const key = cache.computeKey("read", { q: "x" }, ctx)
    cache.set(key, { ok: true, output: "v" }, "read") // toolName ignored when no perToolTtlMs
    now = 4_999
    expect(cache.get(key)?.output).toBe("v")
    now = 5_001
    expect(cache.get(key)).toBe(null)
  })
})

/* ------------------------------------------------------------------ */
/* merged from observability-tool-dedup-drift-hellgate.test.ts */
/* ------------------------------------------------------------------ */

/**
 * Per-tool TTL drift detector hellgate (ADR-0183 — follow-up to ADR-0179).
 *
 * Pins that `defaultToolCallCache({ checkRecommendedDrift: true })`:
 *   - default-OFF behavior matches ADR-0179 byte-for-byte (no flag → no
 *     comparison, no counter, no warn).
 *   - emits `tool.dedup.config_drift.total{tool, kind}` per divergent tool
 *     across 4 closed kinds (too-permissive / too-restrictive / missing /
 *     unknown-tool).
 *   - calls `onDriftWarn` ONCE with a combined message listing every drift
 *     grouped by kind (dual-audience: operator log + machine counter,
 *     mirroring ADR-0169/0175 split).
 *   - degrades gracefully when one sink is wired but not the other
 *     (`metrics: undefined` + `onDriftWarn` set → warn fires, no counter).
 *   - swallows registry/sink throws — drift observability MUST NOT break
 *     cache construction.
 *
 * Research grounding: Cursor's `FastRepoInitHandshakeV2` (cursor-localization
 * §17.6) returns a per-codebase `UP_TO_DATE` / `OUT_OF_SYNC` / `EMPTY`
 * verdict every `doUpdate` cycle — drift is a typed result the caller acts
 * on. Per-tool TTL drift is the construction-time analog.
 */

const driftCounters = (m: MetricsRegistry): ReadonlyArray<MetricSnapshot> =>
  m.snapshot().filter((s) => s.name === "tool.dedup.config_drift.total")

// ─────────────────────────────────────────────────────────────────────────
// A. Default-OFF
// ─────────────────────────────────────────────────────────────────────────

describe("defaultToolCallCache — drift detector default-OFF (ADR-0183)", () => {
  test("HELL-DRIFT-1: checkRecommendedDrift absent → no counter, no warn (byte-identical to ADR-0179)", () => {
    const m = defaultMetricsRegistry()
    const warnCalls: string[] = []
    // Drifty config: caller has nothing in common with the preset.
    defaultToolCallCache({
      perToolTtlMs: { my_custom: 99 },
      metrics: m,
      onDriftWarn: (msg) => warnCalls.push(msg),
      // checkRecommendedDrift intentionally NOT set
    })
    expect(driftCounters(m).length).toBe(0)
    expect(warnCalls.length).toBe(0)
  })

  test("HELL-DRIFT-2: checkRecommendedDrift:true + no perToolTtlMs → every preset key emits a 'missing' drift", () => {
    const m = defaultMetricsRegistry()
    const warnCalls: string[] = []
    defaultToolCallCache({
      checkRecommendedDrift: true,
      metrics: m,
      onDriftWarn: (msg) => warnCalls.push(msg),
      // perToolTtlMs intentionally undefined — caller has NONE of preset.
    })
    const counters = driftCounters(m)
    const presetKeys = Object.keys(RECOMMENDED_PER_TOOL_TTL_MS)
    expect(counters.length).toBe(presetKeys.length)
    // Every counter is a "missing" kind.
    for (const c of counters) {
      expect(c.labels.kind).toBe("missing")
      expect(presetKeys).toContain(c.labels.tool ?? "")
      expect(c.value).toBe(1)
    }
    expect(warnCalls.length).toBe(1)
    expect(warnCalls[0]).toContain("missing=[")
    expect(warnCalls[0]).toContain(`${presetKeys.length} drift(s)`)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// B. Drift kinds (4 closed)
// ─────────────────────────────────────────────────────────────────────────

describe("defaultToolCallCache — drift kinds (ADR-0183)", () => {
  test("HELL-DRIFT-3: caller > preset → 'too-permissive' for that tool", () => {
    const m = defaultMetricsRegistry()
    // Mirror the preset on every key EXCEPT read (caller=90s > preset=60s).
    const perToolTtlMs = { ...RECOMMENDED_PER_TOOL_TTL_MS, read: 90_000 }
    defaultToolCallCache({
      checkRecommendedDrift: true,
      perToolTtlMs,
      metrics: m,
    })
    const counters = driftCounters(m)
    expect(counters.length).toBe(1)
    expect(counters[0]?.labels).toEqual({ tool: "read", kind: "too-permissive" })
  })

  test("HELL-DRIFT-4: caller < preset → 'too-restrictive' for that tool", () => {
    const m = defaultMetricsRegistry()
    const perToolTtlMs = { ...RECOMMENDED_PER_TOOL_TTL_MS, read: 30_000 }
    defaultToolCallCache({
      checkRecommendedDrift: true,
      perToolTtlMs,
      metrics: m,
    })
    const counters = driftCounters(m)
    expect(counters.length).toBe(1)
    expect(counters[0]?.labels).toEqual({ tool: "read", kind: "too-restrictive" })
  })

  test("HELL-DRIFT-5: caller has tool not in preset → 'unknown-tool' (informational)", () => {
    const m = defaultMetricsRegistry()
    const perToolTtlMs = { ...RECOMMENDED_PER_TOOL_TTL_MS, my_custom: 5_000 }
    defaultToolCallCache({
      checkRecommendedDrift: true,
      perToolTtlMs,
      metrics: m,
    })
    const counters = driftCounters(m)
    expect(counters.length).toBe(1)
    expect(counters[0]?.labels).toEqual({ tool: "my_custom", kind: "unknown-tool" })
  })

  test("HELL-DRIFT-6: exact preset match → NO counter for that tool", () => {
    const m = defaultMetricsRegistry()
    const warnCalls: string[] = []
    // Identical to preset → zero drifts.
    defaultToolCallCache({
      checkRecommendedDrift: true,
      perToolTtlMs: { ...RECOMMENDED_PER_TOOL_TTL_MS },
      metrics: m,
      onDriftWarn: (msg) => warnCalls.push(msg),
    })
    expect(driftCounters(m).length).toBe(0)
    expect(warnCalls.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// C. Combined message (operator log)
// ─────────────────────────────────────────────────────────────────────────

describe("defaultToolCallCache — combined drift message (ADR-0183)", () => {
  test("HELL-DRIFT-7: multiple drift kinds → onDriftWarn called ONCE with combined per-kind message", () => {
    const m = defaultMetricsRegistry()
    const warnCalls: string[] = []
    // Mirror preset, then introduce 4 drifts of 3 kinds:
    //   read 90_000 (too-permissive)
    //   grep 90_000 (too-permissive)
    //   git_log 30_000 (too-restrictive)
    //   custom_a 5_000 (unknown-tool)
    const perToolTtlMs: Record<string, number> = {
      ...RECOMMENDED_PER_TOOL_TTL_MS,
      read: 90_000,
      grep: 90_000,
      git_log: 30_000,
      custom_a: 5_000,
    }
    defaultToolCallCache({
      checkRecommendedDrift: true,
      perToolTtlMs,
      metrics: m,
      onDriftWarn: (msg) => warnCalls.push(msg),
    })
    expect(warnCalls.length).toBe(1)
    const msg = warnCalls[0] ?? ""
    expect(msg).toContain("4 drift(s) vs RECOMMENDED")
    expect(msg).toContain("too-permissive=[")
    expect(msg).toContain("grep")
    expect(msg).toContain("read")
    expect(msg).toContain("too-restrictive=[git_log]")
    expect(msg).toContain("unknown=[custom_a]")
    expect(msg).toContain("'checkRecommendedDrift:false'")
    // Counter labels match the kinds.
    const counters = driftCounters(m)
    expect(counters.length).toBe(4)
    const kinds = counters.map((c) => c.labels.kind).sort()
    expect(kinds).toEqual(["too-permissive", "too-permissive", "too-restrictive", "unknown-tool"])
  })

  test("HELL-DRIFT-8: custom onDriftWarn port → that called, console.warn NOT touched", () => {
    const m = defaultMetricsRegistry()
    const warnCalls: string[] = []
    // Spy console.warn to assert we do NOT fall back to it.
    const origConsoleWarn = console.warn
    let consoleWarnCount = 0
    console.warn = () => {
      consoleWarnCount++
    }
    try {
      defaultToolCallCache({
        checkRecommendedDrift: true,
        perToolTtlMs: { read: 90_000 },
        metrics: m,
        onDriftWarn: (msg) => warnCalls.push(msg),
      })
    } finally {
      console.warn = origConsoleWarn
    }
    expect(warnCalls.length).toBe(1)
    expect(consoleWarnCount).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// D. Edge cases — graceful degradation + no-throw invariant
// ─────────────────────────────────────────────────────────────────────────

describe("defaultToolCallCache — drift detector edge cases (ADR-0183)", () => {
  test("HELL-DRIFT-9: metrics undefined + onDriftWarn set → warn fires, no counter (graceful)", () => {
    const warnCalls: string[] = []
    // No metrics registry at all — drift detection should still warn.
    defaultToolCallCache({
      checkRecommendedDrift: true,
      perToolTtlMs: { read: 90_000 },
      onDriftWarn: (msg) => warnCalls.push(msg),
      // metrics intentionally undefined
    })
    expect(warnCalls.length).toBe(1)
    expect(warnCalls[0]).toContain("too-permissive=[read]")
  })

  test("HELL-DRIFT-10: metrics.increment throws → swallowed, cache construction succeeds", () => {
    const warnCalls: string[] = []
    // Throwing registry — every increment raises.
    const throwingMetrics: MetricsRegistry = {
      increment: () => {
        throw new Error("boom")
      },
      observe: () => {},
      gauge: () => {},
      snapshot: () => [],
      reset: () => {},
      flush: async () => {},
    }
    let cache: ReturnType<typeof defaultToolCallCache> | undefined
    expect(() => {
      cache = defaultToolCallCache({
        checkRecommendedDrift: true,
        perToolTtlMs: { read: 90_000 },
        metrics: throwingMetrics,
        onDriftWarn: (msg) => warnCalls.push(msg),
      })
    }).not.toThrow()
    expect(cache).toBeDefined()
    // The warn sink still fired (drift observability is independent per sink).
    expect(warnCalls.length).toBe(1)
    // The cache is still functional.
    cache?.set("k", { ok: true, output: "v" }, "anything")
    expect(cache?.get("k")?.output).toBe("v")
  })

  test("HELL-DRIFT-11: caller value 0 vs preset > 0 → 'too-restrictive' (never-cache vs recommended)", () => {
    const m = defaultMetricsRegistry()
    // Preset has read=60_000; caller sets read=0 (never cache).
    defaultToolCallCache({
      checkRecommendedDrift: true,
      perToolTtlMs: { ...RECOMMENDED_PER_TOOL_TTL_MS, read: 0 },
      metrics: m,
    })
    const counters = driftCounters(m)
    expect(counters.length).toBe(1)
    expect(counters[0]?.labels).toEqual({ tool: "read", kind: "too-restrictive" })
  })

  test("HELL-DRIFT-12: onDriftWarn throws → swallowed (cache construction still succeeds)", () => {
    const m = defaultMetricsRegistry()
    let cache: ReturnType<typeof defaultToolCallCache> | undefined
    const perToolTtlMs = { ...RECOMMENDED_PER_TOOL_TTL_MS, read: 90_000 }
    expect(() => {
      cache = defaultToolCallCache({
        checkRecommendedDrift: true,
        perToolTtlMs,
        metrics: m,
        onDriftWarn: () => {
          throw new Error("boom")
        },
      })
    }).not.toThrow()
    expect(cache).toBeDefined()
    // Counter still recorded despite warn throw.
    expect(driftCounters(m).length).toBe(1)
  })
})
