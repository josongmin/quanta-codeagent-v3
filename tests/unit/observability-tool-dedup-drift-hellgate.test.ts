import { describe, expect, test } from "bun:test"
import { defaultMetricsRegistry } from "@/observability/metrics/index"
import {
  defaultToolCallCache,
  type PerToolTtlDriftKind,
  RECOMMENDED_PER_TOOL_TTL_MS,
} from "@/observability/metrics/instrument-tool-dedup"

/**
 * Per-tool TTL drift detector hellgate (ADR-0189).
 *
 * Pins construction-time divergence between caller `perToolTtlMs` and
 * `RECOMMENDED_PER_TOOL_TTL_MS`:
 *   A. default-OFF — no comparison, no emit (byte-identical to ADR-0179).
 *   B. 4 drift kinds correctly classified.
 *   C. combined operator message + per-drift counter labels.
 *   D. no-throw on sink failure; metrics-only path still works without warn;
 *      exact-match suppression; empty/undefined perToolTtlMs handled.
 */

const findDriftCounter = (
  reg: ReturnType<typeof defaultMetricsRegistry>,
  tool: string,
  kind: PerToolTtlDriftKind,
): { value: number } | undefined => {
  const row = reg
    .snapshot()
    .find(
      (r) =>
        r.name === "tool.dedup.config_drift.total" &&
        r.labels.tool === tool &&
        r.labels.kind === kind,
    )
  return row !== undefined && row.kind === "counter" ? { value: row.value } : undefined
}

describe("ADR-0189: per-tool TTL drift detector", () => {
  describe("A. default-OFF (byte-identical baseline)", () => {
    test("[A1] checkRecommendedDrift omitted → no drift rows even with divergent perToolTtlMs", () => {
      const metrics = defaultMetricsRegistry()
      const warnMsgs: string[] = []
      defaultToolCallCache({
        perToolTtlMs: { read: 999_999 }, // wildly divergent — must not be reported
        metrics,
        onDriftWarn: (m) => warnMsgs.push(m),
      })
      const driftRows = metrics
        .snapshot()
        .filter((r) => r.name === "tool.dedup.config_drift.total")
      expect(driftRows).toHaveLength(0)
      expect(warnMsgs).toHaveLength(0)
    })

    test("[A2] checkRecommendedDrift:false explicitly → still byte-identical", () => {
      const metrics = defaultMetricsRegistry()
      const warnMsgs: string[] = []
      defaultToolCallCache({
        checkRecommendedDrift: false,
        perToolTtlMs: { bash: 60_000 },
        metrics,
        onDriftWarn: (m) => warnMsgs.push(m),
      })
      expect(
        metrics.snapshot().filter((r) => r.name === "tool.dedup.config_drift.total"),
      ).toHaveLength(0)
      expect(warnMsgs).toHaveLength(0)
    })
  })

  describe("B. 4 drift kinds (closed enum)", () => {
    test("[B1] too-permissive — caller TTL > preset → emit + label kind", () => {
      const metrics = defaultMetricsRegistry()
      const warnMsgs: string[] = []
      defaultToolCallCache({
        checkRecommendedDrift: true,
        perToolTtlMs: { read: 120_000 }, // preset 60_000
        metrics,
        onDriftWarn: (m) => warnMsgs.push(m),
      })
      const counter = findDriftCounter(metrics, "read", "too-permissive")
      expect(counter?.value).toBe(1)
      expect(warnMsgs).toHaveLength(1)
      expect(warnMsgs[0]).toContain("too-permissive=[read]")
    })

    test("[B2] too-restrictive — caller TTL < preset → emit + label kind", () => {
      const metrics = defaultMetricsRegistry()
      const warnMsgs: string[] = []
      defaultToolCallCache({
        checkRecommendedDrift: true,
        perToolTtlMs: { read: 5_000, grep: 1_000 }, // both below preset
        metrics,
        onDriftWarn: (m) => warnMsgs.push(m),
      })
      expect(findDriftCounter(metrics, "read", "too-restrictive")?.value).toBe(1)
      expect(findDriftCounter(metrics, "grep", "too-restrictive")?.value).toBe(1)
      expect(warnMsgs[0]).toContain("too-restrictive=[grep,read]")
    })

    test("[B3] missing — preset has key, caller omits → emit per missing tool", () => {
      const metrics = defaultMetricsRegistry()
      const warnMsgs: string[] = []
      defaultToolCallCache({
        checkRecommendedDrift: true,
        perToolTtlMs: { read: RECOMMENDED_PER_TOOL_TTL_MS.read! }, // only `read` set
        metrics,
        onDriftWarn: (m) => warnMsgs.push(m),
      })
      // every other preset key (8 of them) should be flagged missing
      const presetKeys = Object.keys(RECOMMENDED_PER_TOOL_TTL_MS).filter((k) => k !== "read")
      for (const k of presetKeys) {
        expect(findDriftCounter(metrics, k, "missing")?.value).toBe(1)
      }
      expect(warnMsgs[0]).toContain("missing=")
    })

    test("[B4] unknown-tool — caller has key, preset lacks → emit + label kind", () => {
      const metrics = defaultMetricsRegistry()
      const warnMsgs: string[] = []
      defaultToolCallCache({
        checkRecommendedDrift: true,
        perToolTtlMs: {
          ...RECOMMENDED_PER_TOOL_TTL_MS, // exact-match for all preset keys → no drift on those
          my_custom_tool: 10_000,
          another_custom: 20_000,
        },
        metrics,
        onDriftWarn: (m) => warnMsgs.push(m),
      })
      expect(findDriftCounter(metrics, "my_custom_tool", "unknown-tool")?.value).toBe(1)
      expect(findDriftCounter(metrics, "another_custom", "unknown-tool")?.value).toBe(1)
      expect(warnMsgs[0]).toContain("unknown=[another_custom,my_custom_tool]")
    })
  })

  describe("C. combined operator message + machine counter split", () => {
    test("[C1] single warn call with one combined message regardless of drift count", () => {
      const metrics = defaultMetricsRegistry()
      const warnMsgs: string[] = []
      defaultToolCallCache({
        checkRecommendedDrift: true,
        perToolTtlMs: { read: 120_000, grep: 1_000, custom: 999 },
        metrics,
        onDriftWarn: (m) => warnMsgs.push(m),
      })
      expect(warnMsgs).toHaveLength(1) // one combined call, not per-drift
      const msg = warnMsgs[0]!
      expect(msg).toContain("too-permissive=[read]")
      expect(msg).toContain("too-restrictive=[grep]")
      expect(msg).toContain("unknown=[custom]")
      expect(msg).toContain("RECOMMENDED")
      expect(msg).toContain("checkRecommendedDrift:false") // remediation hint
    })

    test("[C2] metrics-only (no onDriftWarn) — counter still fires", () => {
      const metrics = defaultMetricsRegistry()
      defaultToolCallCache({
        checkRecommendedDrift: true,
        perToolTtlMs: { read: 5_000 },
        metrics,
      })
      expect(findDriftCounter(metrics, "read", "too-restrictive")?.value).toBe(1)
    })

    test("[C3] warn-only (no metrics) — counter never fires, warn still does", () => {
      const warnMsgs: string[] = []
      defaultToolCallCache({
        checkRecommendedDrift: true,
        perToolTtlMs: { read: 5_000 },
        onDriftWarn: (m) => warnMsgs.push(m),
      })
      expect(warnMsgs).toHaveLength(1)
      expect(warnMsgs[0]).toContain("too-restrictive=[read]")
    })
  })

  describe("D. edge cases — no-throw, exact-match, empty input", () => {
    test("[D1] throwing onDriftWarn — construction does NOT throw", () => {
      const metrics = defaultMetricsRegistry()
      expect(() =>
        defaultToolCallCache({
          checkRecommendedDrift: true,
          perToolTtlMs: { read: 5_000 },
          metrics,
          onDriftWarn: () => {
            throw new Error("operator sink crashed")
          },
        }),
      ).not.toThrow()
      // metric still recorded — warn failure isolates to its own sink
      expect(findDriftCounter(metrics, "read", "too-restrictive")?.value).toBe(1)
    })

    test("[D2] exact match on every preset key → zero drift, zero emit", () => {
      const metrics = defaultMetricsRegistry()
      const warnMsgs: string[] = []
      defaultToolCallCache({
        checkRecommendedDrift: true,
        perToolTtlMs: { ...RECOMMENDED_PER_TOOL_TTL_MS },
        metrics,
        onDriftWarn: (m) => warnMsgs.push(m),
      })
      expect(
        metrics.snapshot().filter((r) => r.name === "tool.dedup.config_drift.total"),
      ).toHaveLength(0)
      expect(warnMsgs).toHaveLength(0)
    })

    test("[D3] perToolTtlMs omitted entirely → every preset key flagged missing once", () => {
      const metrics = defaultMetricsRegistry()
      const warnMsgs: string[] = []
      defaultToolCallCache({
        checkRecommendedDrift: true,
        metrics,
        onDriftWarn: (m) => warnMsgs.push(m),
      })
      const missingRows = metrics
        .snapshot()
        .filter((r) => r.name === "tool.dedup.config_drift.total" && r.labels.kind === "missing")
      expect(missingRows).toHaveLength(Object.keys(RECOMMENDED_PER_TOOL_TTL_MS).length)
      expect(warnMsgs).toHaveLength(1)
      expect(warnMsgs[0]).toMatch(/missing=\[[^\]]+\]/)
    })

    test("[D4] cache still functions normally after drift report", () => {
      const cache = defaultToolCallCache({
        checkRecommendedDrift: true,
        perToolTtlMs: { read: 5_000 },
      })
      const ctx = { cwd: "/wd", signal: new AbortController().signal }
      const key = cache.computeKey("read", { path: "x" }, ctx)
      expect(cache.get(key)).toBeNull()
      cache.set(key, { ok: true, output: "hi" }, "read")
      expect(cache.get(key)?.output).toBe("hi")
    })
  })
})
