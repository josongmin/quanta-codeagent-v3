import { describe, expect, test } from "bun:test"
import { defaultMetricsRegistry } from "@/observability/metrics/index"
import {
  defaultToolCallCache,
  RECOMMENDED_PER_TOOL_TTL_MS,
} from "@/observability/metrics/instrument-tool-dedup"
import type { MetricSnapshot, MetricsRegistry } from "@/observability/metrics/port"

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
    expect(() => {
      cache = defaultToolCallCache({
        checkRecommendedDrift: true,
        perToolTtlMs: { read: 90_000 },
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
