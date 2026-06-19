/**
 * Bench-report knobs section tests.
 *
 * Pins the user-explicit requirement: every benchmark report MUST carry the
 * exact knob posture used for the run, so two runs are comparable from the
 * JSON alone.
 *
 * Contract (see `BenchReport.knobs` in `src/runner/batch/report.ts`):
 *   - Empty registry (current worktree) ⇒ `{ resolved: {}, inactive: [] }` —
 *     a safe baseline marker. Always emitted; never absent.
 *   - Registered + active knob ⇒ `resolved[<id>] = { value, source }`.
 *   - Registered + inactive knob ⇒ id in `inactive[]`.
 *   - `QUANTA_KNOBS_PRESET=<name>` ⇒ `preset` field present.
 *
 * Also pins `collectBenchKnobsTelemetry` (the writeArtifacts seam) — it
 * builds the same shape the report consumes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { collectBenchKnobsTelemetry, writeArtifacts } from "@/runner/batch/core"
import { type BenchReportKnobs, buildReport } from "@/runner/batch/report"
import type { InstanceResult } from "@/runner/batch/types"
import {
  __resetRegistry,
  __restoreRegistry,
  __snapshotRegistry,
  type Knob,
  registerKnob,
  type Surface,
} from "@/runner/knobs"
// Side-effect: register all real knobs at module-load so the beforeAll snapshot
// below is COMPLETE regardless of suite file order (otherwise an empty snapshot
// would be restored in afterAll and wipe the registry for sibling files).
import "@/runner/knobs/knobs"

const BENCH: readonly Surface[] = ["bench"]
const mkResult = (id: string, passed: boolean): InstanceResult => ({
  id,
  passed,
  patch: "",
  turns: 1,
})

const envSnapshot = (keys: readonly string[]): Map<string, string | undefined> => {
  const m = new Map<string, string | undefined>()
  for (const k of keys) m.set(k, process.env[k])
  return m
}

const envRestore = (m: Map<string, string | undefined>): void => {
  for (const [k, v] of m) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

const ENV_KEYS = ["QUANTA_KNOBS_PRESET", "QUANTA_BENCH_TEST_ONE", "QUANTA_BENCH_TEST_TWO"] as const

let savedEnv: Map<string, string | undefined>

const mkBoolKnob = (id: string, envKey: string): Knob<true> => ({
  id,
  envKey,
  category: "agent",
  surfaces: BENCH,
  parse: (raw: string | undefined): true | undefined => (raw === "1" ? true : undefined),
  apply: (cfg: AgentConfig): AgentConfig => cfg,
  describe: `test knob ${id}`,
})

// Snapshot the populated global registry once so the per-test `__resetRegistry()`
// churn below cannot leak an EMPTY registry to sibling test files that run after
// this one in the single-process suite (their knob modules are already
// import-cached and will NOT re-fire `registerKnob`). Restore it in `afterAll`.
let registrySnapshot: ReturnType<typeof __snapshotRegistry>
beforeAll(() => {
  registrySnapshot = __snapshotRegistry()
})
afterAll(() => {
  __restoreRegistry(registrySnapshot)
})

beforeEach(() => {
  savedEnv = envSnapshot(ENV_KEYS)
  for (const k of ENV_KEYS) delete process.env[k]
  __resetRegistry()
})

afterEach(() => {
  envRestore(savedEnv)
  __resetRegistry()
})

// ── buildReport: knobs section is ALWAYS present ────────────────────────────

describe("buildReport — knobs section", () => {
  test("absent meta.knobs ⇒ empty marker { resolved:{}, inactive:[] }, no preset", () => {
    const report = buildReport(
      { model: "m", provider: "p", n: 1, timestamp: "2026-01-01T00:00:00Z" },
      [mkResult("a", true)],
    )
    expect(report.knobs).toEqual({ resolved: {}, inactive: [] })
    expect("preset" in report.knobs).toBe(false)
  })

  test("explicit meta.knobs ⇒ embedded verbatim into report.knobs", () => {
    const knobs: BenchReportKnobs = {
      resolved: { "issue-hint": { value: "agentless", source: "env" } },
      preset: "agentless-full",
      inactive: ["subagent"],
    }
    const report = buildReport({ model: "m", provider: "p", n: 1, timestamp: "t", knobs }, [
      mkResult("a", true),
    ])
    expect(report.knobs).toEqual(knobs)
    expect(report.knobs.preset).toBe("agentless-full")
    expect(report.knobs.resolved["issue-hint"]).toEqual({
      value: "agentless",
      source: "env",
    })
  })

  test("knobs section round-trips through JSON.stringify ⇒ JSON.parse", () => {
    const knobs: BenchReportKnobs = {
      resolved: {
        "branch-search": { value: 3, source: "env" },
        "repro-test": { value: { samples: 5 }, source: "preset" },
      },
      preset: "agentless-full",
      inactive: ["subagent", "skills"],
    }
    const report = buildReport({ model: "m", provider: "p", n: 1, knobs }, [])
    const round = JSON.parse(JSON.stringify(report)) as typeof report
    expect(round.knobs).toEqual(knobs)
  })

  test("per-instance repro-test telemetry is emitted when present", () => {
    const report = buildReport({ model: "m", provider: "p", n: 1, timestamp: "t" }, [
      {
        ...mkResult("a", false),
        reproTest: {
          installed: false,
          reason: "execution_failed",
          samples: 3,
          reproducedCount: 0,
        },
      },
    ])
    expect(report.perInstance[0]?.reproTest).toEqual({
      installed: false,
      reason: "execution_failed",
      samples: 3,
      reproducedCount: 0,
    })
  })
})

// ── collectBenchKnobsTelemetry: env → BenchReportKnobs adapter ──────────────

describe("collectBenchKnobsTelemetry — env adapter", () => {
  test("empty registry ⇒ empty marker", () => {
    const k = collectBenchKnobsTelemetry()
    expect(k.resolved).toEqual({})
    expect(k.inactive).toEqual([])
    expect(k.preset).toBeUndefined()
  })

  test("registered + active knob ⇒ resolved entry with source=env", () => {
    registerKnob(mkBoolKnob("test-one", "QUANTA_BENCH_TEST_ONE"))
    process.env.QUANTA_BENCH_TEST_ONE = "1"
    const k = collectBenchKnobsTelemetry()
    expect(k.resolved).toEqual({
      "test-one": { value: true, unit: undefined, display: "on", source: "env" },
    })
    expect(k.inactive).toEqual([])
  })

  test("registered + inactive knob ⇒ listed under inactive", () => {
    registerKnob(mkBoolKnob("test-one", "QUANTA_BENCH_TEST_ONE"))
    const k = collectBenchKnobsTelemetry()
    expect(k.resolved).toEqual({})
    expect(k.inactive).toEqual(["test-one"])
  })

  test("preset env propagates into report shape", () => {
    process.env.QUANTA_KNOBS_PRESET = "baseline"
    const k = collectBenchKnobsTelemetry()
    expect(k.preset).toBe("baseline")
  })
})

// ── writeArtifacts: report file carries the knobs section ───────────────────

describe("writeArtifacts — report file embeds knobs section", () => {
  test("default (no meta.knobs) ⇒ writes empty knobs marker into file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-report-knobs-"))
    try {
      const reportFile = join(dir, "report.json")
      const predFile = join(dir, "preds.jsonl")
      await writeArtifacts(predFile, reportFile, [mkResult("a", true)], {
        model: "m",
        provider: "p",
        n: 1,
      })
      expect(existsSync(reportFile)).toBe(true)
      const parsed = JSON.parse(readFileSync(reportFile, "utf8")) as {
        knobs: BenchReportKnobs
      }
      expect(parsed.knobs).toEqual({ resolved: {}, inactive: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("explicit meta.knobs ⇒ pass-through into written file (test seam)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-report-knobs-"))
    try {
      const reportFile = join(dir, "report.json")
      const predFile = join(dir, "preds.jsonl")
      const knobs: BenchReportKnobs = {
        resolved: { foo: { value: 42, source: "cli" } },
        preset: "experimental",
        inactive: ["bar"],
      }
      await writeArtifacts(predFile, reportFile, [mkResult("a", true)], {
        model: "m",
        provider: "p",
        n: 1,
        knobs,
      })
      const parsed = JSON.parse(readFileSync(reportFile, "utf8")) as {
        knobs: BenchReportKnobs
      }
      expect(parsed.knobs).toEqual(knobs)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("registered knob + env ⇒ written file reflects resolved state without explicit meta.knobs", async () => {
    // Default path (no caller-supplied knobs) ⇒ writeArtifacts calls
    // collectBenchKnobsTelemetry, which resolves from process.env. This is
    // the production path: the bench harness doesn't pass `knobs` itself.
    registerKnob(mkBoolKnob("test-one", "QUANTA_BENCH_TEST_ONE"))
    registerKnob(mkBoolKnob("test-two", "QUANTA_BENCH_TEST_TWO"))
    process.env.QUANTA_BENCH_TEST_ONE = "1"
    process.env.QUANTA_KNOBS_PRESET = "baseline"
    const dir = mkdtempSync(join(tmpdir(), "bench-report-knobs-"))
    try {
      const reportFile = join(dir, "report.json")
      const predFile = join(dir, "preds.jsonl")
      await writeArtifacts(predFile, reportFile, [mkResult("a", true)], {
        model: "m",
        provider: "p",
        n: 1,
      })
      const parsed = JSON.parse(readFileSync(reportFile, "utf8")) as {
        knobs: BenchReportKnobs
      }
      expect(parsed.knobs.resolved).toEqual({
        "test-one": { value: true, unit: undefined, display: "on", source: "env" },
      })
      expect(parsed.knobs.preset).toBe("baseline")
      expect(parsed.knobs.inactive).toEqual(["test-two"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
