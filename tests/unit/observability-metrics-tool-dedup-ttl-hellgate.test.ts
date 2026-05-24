import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { defaultMetricsRegistry } from "@/observability/metrics/index"
import {
  defaultToolCallCache,
  instrumentToolWithDedup,
  RECOMMENDED_PER_TOOL_TTL_MS,
} from "@/observability/metrics/instrument-tool-dedup"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "@/tool"

/**
 * Per-tool TTL hellgate (ADR-0178 — follow-up to ADR-0176).
 *
 * Pins the contract that `defaultToolCallCache({ perToolTtlMs })` resolves
 * TTL by tool-name at SET time, falls through to the global `ttlMs` for
 * unlisted tools, treats `0` as "never cache", and that the recommended
 * preset matches the audited cache-class table.
 *
 * Inspiration: Cursor's 4-tier freshness model (recent_edits overlay 0s
 * freshness / Rust debounce event-driven / 60s server reconciliation /
 * handshake ground truth) — per-data-class staleness tolerance maps onto
 * per-TOOL TTL one-for-one.
 */

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
    callLog?: { count: number }
  } = {},
): Tool<FakeInput> => {
  const log = overrides.callLog
  return {
    name: overrides.name ?? "fake",
    description: "fake tool",
    inputSchema: z.object({ q: z.string() }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input: FakeInput): AsyncIterable<ToolEvent> {
      if (log) log.count++
      yield {
        type: "result" as const,
        result: { ok: true, output: `result-for-${input.q}` } satisfies ToolResult,
      }
    },
  }
}

const drain = async (it: AsyncIterable<ToolEvent>): Promise<ToolEvent[]> => {
  const out: ToolEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

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
