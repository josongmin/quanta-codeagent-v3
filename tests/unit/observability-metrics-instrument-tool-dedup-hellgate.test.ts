import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { defaultMetricsRegistry } from "@/observability/metrics/index"
import {
  defaultToolCallCache,
  instrumentToolWithDedup,
  type ToolCallCache,
  type ToolDedupOpts,
} from "@/observability/metrics/instrument-tool-dedup"
import type { MetricsRegistry } from "@/observability/metrics/port"
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
