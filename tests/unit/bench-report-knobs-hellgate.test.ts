/**
 * Hellgate — bench-report knobs section adversarial pins.
 *
 * Companion to `bench-report-knobs.test.ts` (positive contract). This file
 * stresses the contract under exotic inputs:
 *   - `BenchReportKnobs` shape stability (preset present iff string; no null)
 *   - very-large inactive lists (1000+ ids)
 *   - JSON round-trip with deeply-nested values
 *   - circular-reference values produce a thrown JSON error (NOT silent
 *     corruption) — caller decides how to handle
 *   - writeArtifacts idempotency under repeated calls
 *   - writeArtifacts when ONLY predictionsFile is provided (no report)
 *   - writeArtifacts when ONLY reportFile is provided (no predictions)
 *   - Empty results + empty registry ⇒ minimal stable report
 *   - meta.knobs takes precedence over env (test seam invariant)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { collectBenchKnobsTelemetry, writeArtifacts } from "@/runner/batch/core"
import { type BenchReportKnobs, buildReport } from "@/runner/batch/report"
import type { InstanceResult } from "@/runner/batch/types"
import { __resetRegistry, type Knob, registerKnob, type Surface } from "@/runner/knobs"

const BENCH: readonly Surface[] = ["bench"]

const mkBoolKnob = (id: string, envKey: string): Knob<true> => ({
  id,
  envKey,
  category: "agent",
  surfaces: BENCH,
  parse: (raw) => (raw === "1" ? true : undefined),
  apply: (cfg: AgentConfig) => cfg,
  describe: `knob ${id}`,
})

const mkResult = (id: string, passed: boolean): InstanceResult => ({
  id,
  passed,
  patch: "",
  turns: 1,
})

const ENV_KEYS = [
  "QUANTA_KNOBS_PRESET",
  "QUANTA_BENCH_TEST_ONE",
  "QUANTA_BENCH_TEST_TWO",
  "QUANTA_BENCH_TEST_THREE",
] as const

const snap = (): Map<string, string | undefined> => {
  const m = new Map<string, string | undefined>()
  for (const k of ENV_KEYS) m.set(k, process.env[k])
  return m
}
const restore = (m: Map<string, string | undefined>): void => {
  for (const [k, v] of m) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

let saved: Map<string, string | undefined>
beforeEach(() => {
  saved = snap()
  for (const k of ENV_KEYS) delete process.env[k]
  __resetRegistry()
})
afterEach(() => {
  restore(saved)
  __resetRegistry()
})

// ── A. buildReport shape invariants ────────────────────────────────────────────

describe("hellgate — buildReport knobs section shape", () => {
  test("no meta.knobs + no results ⇒ knobs = { resolved:{}, inactive:[] }", () => {
    const r = buildReport({ model: "m", provider: "p", n: 0, timestamp: "t" }, [])
    expect(r.knobs).toEqual({ resolved: {}, inactive: [] })
    expect("preset" in r.knobs).toBe(false)
  })

  test("meta.knobs WITHOUT preset ⇒ preset absent (NOT null, NOT undefined-explicit)", () => {
    const knobs: BenchReportKnobs = { resolved: {}, inactive: ["a"] }
    const r = buildReport({ model: "m", provider: "p", n: 0, timestamp: "t", knobs }, [])
    expect("preset" in r.knobs).toBe(false)
    // JSON.stringify drops undefined keys; round-trip ⇒ identical.
    const round = JSON.parse(JSON.stringify(r.knobs)) as BenchReportKnobs
    expect("preset" in round).toBe(false)
  })

  test("meta.knobs.preset = '' (empty string) ⇒ surfaced verbatim", () => {
    // The buildReport contract is to pass `meta.knobs` through verbatim; if
    // an upstream feeder produced preset:'' the report records it. The
    // telemetry collector itself filters '' to undefined (separate concern).
    const knobs: BenchReportKnobs = { resolved: {}, preset: "", inactive: [] }
    const r = buildReport({ model: "m", provider: "p", n: 0, timestamp: "t", knobs }, [])
    expect(r.knobs.preset).toBe("")
  })

  test("inactive list with 1000 ids ⇒ embedded verbatim, no truncation", () => {
    const ids: string[] = []
    for (let i = 0; i < 1000; i++) ids.push(`k${i}`)
    const knobs: BenchReportKnobs = { resolved: {}, inactive: ids }
    const r = buildReport({ model: "m", provider: "p", n: 0, timestamp: "t", knobs }, [])
    expect(r.knobs.inactive.length).toBe(1000)
    expect(r.knobs.inactive[999]).toBe("k999")
  })

  test("resolved value of deep-nested object ⇒ round-trips through JSON", () => {
    const deep = {
      level1: { level2: { level3: [1, 2, { x: "y" }] } },
      arr: ["a", "b", "c"],
    }
    const knobs: BenchReportKnobs = {
      resolved: { complex: { value: deep, source: "preset" } },
      inactive: [],
    }
    const r = buildReport({ model: "m", provider: "p", n: 0, timestamp: "t", knobs }, [])
    const round = JSON.parse(JSON.stringify(r)) as typeof r
    expect(round.knobs.resolved.complex?.value).toEqual(deep)
  })

  test("circular-reference value ⇒ JSON.stringify throws (no silent corruption)", () => {
    const circ: Record<string, unknown> = { name: "outer" }
    circ.self = circ
    const knobs: BenchReportKnobs = {
      resolved: { circ: { value: circ, source: "env" } },
      inactive: [],
    }
    const r = buildReport({ model: "m", provider: "p", n: 0, timestamp: "t", knobs }, [])
    // Native stringify must throw on a cycle — proves the report did NOT
    // silently swallow the circularity.
    expect(() => JSON.stringify(r)).toThrow()
  })

  test("knobs section is the SAME reference passed in (no defensive clone)", () => {
    // BuildReport returns the same `knobs` reference — caller may freeze it.
    // This pins that we are NOT paying clone cost on every build.
    const knobs: BenchReportKnobs = { resolved: {}, inactive: ["only"] }
    const r = buildReport({ model: "m", provider: "p", n: 0, timestamp: "t", knobs }, [])
    expect(r.knobs).toBe(knobs)
  })
})

// ── B. collectBenchKnobsTelemetry adversarial ──────────────────────────────────

describe("hellgate — collectBenchKnobsTelemetry env reads", () => {
  test("with NO env vars set, NO registered knobs ⇒ safe-baseline empties (no preset key)", () => {
    const k = collectBenchKnobsTelemetry()
    expect(k.resolved).toEqual({})
    expect(k.inactive).toEqual([])
    expect("preset" in k).toBe(false)
  })

  test("QUANTA_KNOBS_PRESET set to empty string ⇒ preset key absent in result", () => {
    process.env.QUANTA_KNOBS_PRESET = ""
    const k = collectBenchKnobsTelemetry()
    expect("preset" in k).toBe(false)
  })

  test("QUANTA_KNOBS_PRESET = 'agentless-full' with no preset knob registered ⇒ surfaced verbatim", () => {
    process.env.QUANTA_KNOBS_PRESET = "agentless-full"
    const k = collectBenchKnobsTelemetry()
    expect(k.preset).toBe("agentless-full")
    expect(k.resolved).toEqual({})
  })

  test("many registered knobs, all inactive ⇒ ALL listed in inactive (registry-order)", () => {
    for (let i = 0; i < 30; i++) {
      registerKnob(mkBoolKnob(`mass-${i.toString().padStart(2, "0")}`, `QUANTA_BENCH_MASS_${i}`))
    }
    const k = collectBenchKnobsTelemetry()
    expect(k.inactive.length).toBe(30)
    expect(k.inactive[0]).toBe("mass-00")
    expect(k.inactive[29]).toBe("mass-29")
  })

  test("idempotent across calls (no side-effect on registry)", () => {
    registerKnob(mkBoolKnob("k1", "QUANTA_BENCH_TEST_ONE"))
    process.env.QUANTA_BENCH_TEST_ONE = "1"
    const a = collectBenchKnobsTelemetry()
    const b = collectBenchKnobsTelemetry()
    expect(a).toEqual(b)
  })
})

// ── C. writeArtifacts adversarial paths ────────────────────────────────────────

describe("hellgate — writeArtifacts file IO edges", () => {
  test("ONLY predictionsFile (no reportFile) ⇒ NO report.json written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-hg-"))
    try {
      const predFile = join(dir, "preds.jsonl")
      await writeArtifacts(predFile, undefined, [mkResult("a", true)], {
        model: "m",
        provider: "p",
        n: 1,
      })
      expect(existsSync(predFile)).toBe(true)
      expect(existsSync(join(dir, "report.json"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("ONLY reportFile (no predictionsFile) ⇒ report.json carries knobs section", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-hg-"))
    try {
      const reportFile = join(dir, "report.json")
      await writeArtifacts(undefined, reportFile, [mkResult("a", true)], {
        model: "m",
        provider: "p",
        n: 1,
      })
      expect(existsSync(reportFile)).toBe(true)
      const parsed = JSON.parse(readFileSync(reportFile, "utf8")) as { knobs: BenchReportKnobs }
      expect(parsed.knobs).toEqual({ resolved: {}, inactive: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("predictionsFile = '' (empty path) ⇒ skipped (no file created)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-hg-"))
    try {
      const reportFile = join(dir, "report.json")
      // hasPath rejects "" → predictions skipped.
      await writeArtifacts("", reportFile, [mkResult("a", true)], {
        model: "m",
        provider: "p",
        n: 1,
      })
      expect(existsSync(reportFile)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("reportFile = '' (empty path) ⇒ skipped (no file created)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-hg-"))
    try {
      const predFile = join(dir, "preds.jsonl")
      await writeArtifacts(predFile, "", [mkResult("a", true)], {
        model: "m",
        provider: "p",
        n: 1,
      })
      expect(existsSync(predFile)).toBe(true)
      expect(existsSync(join(dir, "report.json"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("both files undefined ⇒ no-op, returns cleanly (no throw)", async () => {
    await writeArtifacts(undefined, undefined, [mkResult("a", true)], {
      model: "m",
      provider: "p",
      n: 1,
    })
    // No exception; nothing more to assert.
  })

  test("explicit meta.knobs takes PRECEDENCE over env (test-seam invariant)", async () => {
    // Register a knob + set env so the env path WOULD produce a value.
    registerKnob(mkBoolKnob("k1", "QUANTA_BENCH_TEST_ONE"))
    process.env.QUANTA_BENCH_TEST_ONE = "1"
    process.env.QUANTA_KNOBS_PRESET = "env-preset"

    // Supply explicit knobs telemetry that DOES NOT match the env state.
    const explicit: BenchReportKnobs = {
      resolved: { foo: { value: "bar", source: "cli" } },
      preset: "explicit-preset",
      inactive: ["zoz"],
    }
    const dir = mkdtempSync(join(tmpdir(), "bench-hg-"))
    try {
      const reportFile = join(dir, "report.json")
      await writeArtifacts(undefined, reportFile, [mkResult("a", true)], {
        model: "m",
        provider: "p",
        n: 1,
        knobs: explicit,
      })
      const parsed = JSON.parse(readFileSync(reportFile, "utf8")) as { knobs: BenchReportKnobs }
      // The explicit value wins — env had no influence.
      expect(parsed.knobs).toEqual(explicit)
      expect(parsed.knobs.preset).toBe("explicit-preset")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("idempotent: two consecutive writes ⇒ identical bytes (timestamp permitting)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-hg-"))
    try {
      const reportFile = join(dir, "report.json")
      const knobs: BenchReportKnobs = {
        resolved: { f: { value: 1, source: "cli" } },
        inactive: [],
      }
      const meta = { model: "m", provider: "p", n: 1, knobs }
      await writeArtifacts(undefined, reportFile, [mkResult("a", true)], meta)
      const first = readFileSync(reportFile, "utf8")
      await writeArtifacts(undefined, reportFile, [mkResult("a", true)], meta)
      const second = readFileSync(reportFile, "utf8")
      // Timestamps differ — but the knobs section must be byte-identical.
      const a = JSON.parse(first) as { knobs: BenchReportKnobs }
      const b = JSON.parse(second) as { knobs: BenchReportKnobs }
      expect(JSON.stringify(a.knobs)).toBe(JSON.stringify(b.knobs))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("empty results + report file ⇒ totals all zero, knobs section still present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-hg-"))
    try {
      const reportFile = join(dir, "report.json")
      await writeArtifacts(undefined, reportFile, [], { model: "m", provider: "p", n: 0 })
      const parsed = JSON.parse(readFileSync(reportFile, "utf8")) as {
        knobs: BenchReportKnobs
        totals: { total: number; resolved: number; resolvedPct: number }
      }
      expect(parsed.totals).toEqual({ total: 0, resolved: 0, resolvedPct: 0 })
      expect(parsed.knobs).toEqual({ resolved: {}, inactive: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
