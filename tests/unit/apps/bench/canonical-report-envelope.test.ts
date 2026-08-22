/**
 * BFND-02 — canonical report envelope union + ONE writer (RED-first hellgate).
 *
 * The report boundary becomes a discriminated union
 *   CanonicalBenchReport = SweBenchReport | TerminalBenchReport
 * that shares the SAME writer (writeReport → mirrorReportToSsot) WITHOUT forcing
 * SWE official-grade dispositions and Harbor trial receipts into one semantic
 * payload type: the two branches stay separate interfaces and their receipt
 * semantics stay lossless.
 *
 * The persisted SWE encoding stays BYTE-IDENTICAL (the landed R4 rule: a verified
 * report carries no `datasetFamily`, and no report gains a suite key), so the
 * identity is materialised at exactly ONE read boundary
 * (`decodeCanonicalReport`). New Terminal artifacts carry EXPLICIT identity —
 * never inferred from a filename, a field, or a dataset string.
 *
 * Every payload assertion below observes REAL effects (bytes produced by the real
 * builder, bytes actually written to disk, a real decode). Only the ownership
 * rails are source-scans — the ticket mandates them — and each one carries a
 * non-vacuity self-check plus a proven red-on-injection.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import {
  buildReport,
  type CanonicalBenchReport,
  type DatasetFamily,
  decodeCanonicalReport,
  encodeCanonicalReport,
  mirrorReportToSsot,
  type PerInstanceReport,
  type SweBenchReport,
  TERMINAL_ONLY_KEYS,
  type TerminalBenchReport,
  type TerminalTrialReceipt,
  toCanonicalSweReport,
  writeReport,
} from "../../../../src/runner/batch/report"
import { buildTerminalBenchReport } from "../../../../src/runner/batch/report-terminal"
import type { InstanceResult } from "../../../../src/runner/batch/types"
import { __resetRuntimeConfig } from "../../../../src/shared/runtime-config"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8")

const mkResult = (id: string, passed: boolean, patch: string): InstanceResult => ({
  id,
  passed,
  patch,
  turns: 1,
})

const RESULTS: InstanceResult[] = [mkResult("a", true, "diff-a"), mkResult("b", false, "")]

/** Test isolation: `writeReport` fans out to `mirrorReportToSsot`, whose default
 *  sink is the operator's LIVE `~/.quanta/bench/results` SSOT. Without this the
 *  fixtures below mirror into that trove — an earlier run of this file left 80
 *  `tmp__bfnd02-*` artifacts there, 32 of them carrying
 *  `benchmarkSuite:"terminal-bench"`, i.e. synthetic runs sitting in the real
 *  leaderboard corpus. Point the mirror at the per-test temp dir (and reset the
 *  memoised runtime config on both edges) so the canonical writer is still
 *  exercised end-to-end while nothing escapes the sandbox. */
const withTmp = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "bfnd02-"))
  const priorResultsDir = process.env.QUANTA_BENCH_RESULTS_DIR
  process.env.QUANTA_BENCH_RESULTS_DIR = join(dir, "ssot-mirror")
  __resetRuntimeConfig()
  try {
    await fn(dir)
  } finally {
    if (priorResultsDir === undefined) delete process.env.QUANTA_BENCH_RESULTS_DIR
    else process.env.QUANTA_BENCH_RESULTS_DIR = priorResultsDir
    __resetRuntimeConfig()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Every source file under the given roots, minus tests. */
const sourceFiles = (roots: readonly string[]): string[] => {
  const out: string[] = []
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue
      const p = join(abs, entry)
      if (statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      if (!p.endsWith(".ts") || p.endsWith(".test.ts")) continue
      out.push(relative(REPO_ROOT, p))
    }
  }
  for (const root of roots) walk(join(REPO_ROOT, root))
  return out.sort()
}

// ───────────────────────── SWE branch: lift + byte-identical encoding ────────

describe("BFND-02 SWE branch — canonical identity in memory, legacy bytes on disk", () => {
  test("toCanonicalSweReport materialises the FULL family union (verified/live/pro)", () => {
    // Non-vacuous: every member of the union flows through, and each keeps its
    // OWN value (a single-literal fixture would let a hardcoded return pass).
    const families: readonly DatasetFamily[] = ["verified", "live", "pro"]
    const seen = families.map((family) => {
      const canonical: SweBenchReport = toCanonicalSweReport(
        buildReport({ model: "m", provider: "openai", n: 2, datasetFamily: family }, RESULTS),
      )
      expect(canonical.benchmarkSuite).toBe("swe-bench")
      return canonical.datasetFamily
    })
    expect(seen).toEqual(["verified", "live", "pro"])
    // An ABSENT selector lifts to verified (the byte-identical legacy default).
    expect(
      toCanonicalSweReport(buildReport({ model: "m", provider: "o", n: 1 }, RESULTS)).datasetFamily,
    ).toBe("verified")
  })

  test("encode(lift(x)) is byte-identical to the legacy report for EVERY family", () => {
    // The strongest persisted-shape guard: exact JSON bytes, so a key-order drift
    // (e.g. an encoder that re-spreads datasetFamily to the tail) fails too.
    for (const family of ["verified", "live", "pro"] as const) {
      const legacy = buildReport(
        { model: "m", provider: "openai", n: 2, datasetFamily: family, timestamp: "T" },
        RESULTS,
      )
      const encoded = encodeCanonicalReport(toCanonicalSweReport(legacy))
      expect(JSON.stringify(encoded, null, 2)).toBe(JSON.stringify(legacy, null, 2))
    }
  })

  test("a non-verified family survives the round trip in its ORIGINAL key position", () => {
    const legacy = buildReport(
      { model: "m", provider: "openai", n: 1, datasetFamily: "pro", timestamp: "T" },
      RESULTS,
    )
    const encoded = encodeCanonicalReport(toCanonicalSweReport(legacy))
    expect(encoded.datasetFamily).toBe("pro")
    expect("benchmarkSuite" in encoded).toBe(false)
    expect(Object.keys(encoded)).toEqual(Object.keys(legacy))
  })

  test("writeReport lands the legacy SWE bytes verbatim on disk", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "report.json")
      const legacy = buildReport(
        { model: "m", provider: "openai", n: 2, datasetFamily: "pro", timestamp: "T" },
        RESULTS,
      )
      await writeReport(file, toCanonicalSweReport(legacy))
      expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify(legacy, null, 2)}\n`)
    })
  })
})

// ───────────────────────── Terminal branch: separate lossless receipts ───────

describe("BFND-02 Terminal branch — a SEPARATE lossless receipt, explicit identity", () => {
  const trials = [
    { id: "kv-store-grpc", passed: true, durationMs: 200_000 },
    { id: "compile-compcert", passed: false, durationMs: 30_000 },
    { id: "flaky-infra", passed: false, durationMs: 25_000, error: { kind: "agent-crash" } },
    { id: "slow-task", passed: false, durationMs: 1_200_000, error: { kind: "agent-timeout" } },
  ] as const

  const report = (): TerminalBenchReport =>
    buildTerminalBenchReport(trials, {
      datasetRef: "harbor/terminal-bench@2.1.0",
      timestamp: "T",
      model: "gpt-5.5",
      preset: "TB +levers",
      arm: "levers",
    })

  test("carries explicit suite/version/datasetRef and NO family axis", () => {
    const r = report() as unknown as Record<string, unknown>
    expect(r.benchmarkSuite).toBe("terminal-bench")
    expect(r.benchmarkVersion).toBe("2.1")
    expect(r.datasetRef).toBe("harbor/terminal-bench@2.1.0")
    expect("datasetFamily" in r).toBe(false)
  })

  test("trial receipts stay LOSSLESS — every trial verbatim, none folded away", () => {
    const r = report()
    expect(r.perInstance.map((t) => t.id)).toEqual([
      "kv-store-grpc",
      "compile-compcert",
      "flaky-infra",
      "slow-task",
    ])
    expect(r.perInstance[2]?.error).toEqual({ kind: "agent-crash" })
    expect(r.perInstance[3]?.error).toEqual({ kind: "agent-timeout" })
    expect(r.perInstance[0]?.durationMs).toBe(200_000)
  })

  test("official-shaped metrics keep EVERY trial in the denominator — a crash is a zero, not a hole", () => {
    // CONTRACT CHANGE (aug-22). This previously encoded quanta's internal D1
    // convention (RFC jul-3): an agent-CRASH was dropped from the denominator as
    // a "re-runnable measurement hole". That inflated the headline — a run that
    // crashed on half its tasks reported the accuracy of the surviving half —
    // and it contradicts upstream Terminal-Bench 2.1, verified in TB21-04 by
    // executing the pinned `leaderboard/core/metrics.py` as a live oracle: a
    // trial with no reward is `is_success(null) === false`, so it scores zero
    // and STAYS in the denominator. The ticket says the same thing as a
    // non-negotiable: "errored trials carry reward 0; they are not removed from
    // the denominator. Diagnostic taxonomy does not authorize denominator
    // removal." The D1 view is not lost — `perInstance[].error.kind` is
    // persisted on every receipt, so a consumer can still derive it.
    const r = report()
    // 4 trials, NONE excluded ⇒ total 4; 1 pass ⇒ 25%.
    expect(r.totals).toEqual({ total: 4, resolved: 1, resolvedPct: 25 })
    // Paired control #1: dropping the crash from the INPUT now DOES move the
    // denominator — proving the crash was genuinely counted, not coincidence.
    const withoutCrash = buildTerminalBenchReport(
      trials.filter((t) => t.id !== "flaky-infra"),
      { datasetRef: "d", timestamp: "T", model: "m", preset: "p" },
    )
    expect(withoutCrash.totals).toEqual({ total: 3, resolved: 1, resolvedPct: 33 })
    // Paired control #2: a genuine timeout FAIL moves it the same way — crash and
    // timeout are treated identically by the official metric.
    const withoutTimeout = buildTerminalBenchReport(
      trials.filter((t) => t.id !== "slow-task"),
      { datasetRef: "d", timestamp: "T", model: "m", preset: "p" },
    )
    expect(withoutTimeout.totals).toEqual({ total: 3, resolved: 1, resolvedPct: 33 })
    // The diagnostic survives the change: the crash is still identifiable on the
    // persisted receipt, so the D1 infra-hole view remains derivable.
    expect(r.perInstance.filter((p) => p.error?.kind === "agent-crash")).toHaveLength(1)
  })

  test("identity is fail-closed: a blank datasetRef is refused, never fabricated", () => {
    expect(() =>
      buildTerminalBenchReport(trials, {
        datasetRef: "  ",
        timestamp: "T",
        model: "m",
        preset: "p",
      }),
    ).toThrow(/datasetRef/)
  })

  test("model:undefined is preserved (never fabricated) and arm is exact-optional", () => {
    const r = buildTerminalBenchReport(trials, {
      datasetRef: "d",
      timestamp: "T",
      model: undefined,
      preset: "p",
    })
    expect(r.model).toBeUndefined()
    expect("arm" in r).toBe(false)
    expect(report().arm).toBe("levers")
  })

  test("BOTH branches serialize through the SAME writer to real bytes", async () => {
    await withTmp(async (dir) => {
      const sweFile = join(dir, "swe.json")
      const tbFile = join(dir, "tb.json")
      const swe = toCanonicalSweReport(
        buildReport({ model: "m", provider: "o", n: 1, datasetFamily: "pro" }, RESULTS),
      )
      await writeReport(sweFile, swe)
      await writeReport(tbFile, report())
      expect(existsSync(sweFile)).toBe(true)
      const sweBytes = JSON.parse(readFileSync(sweFile, "utf8")) as Record<string, unknown>
      const tbBytes = JSON.parse(readFileSync(tbFile, "utf8")) as Record<string, unknown>
      expect(sweBytes.datasetFamily).toBe("pro")
      expect("benchmarkSuite" in sweBytes).toBe(false)
      expect(tbBytes.benchmarkSuite).toBe("terminal-bench")
      expect(tbBytes.benchmarkVersion).toBe("2.1")
      expect("datasetFamily" in tbBytes).toBe(false)
    })
  })
})

// ───────────────────────── the ONE read-normalization boundary ───────────────

describe("BFND-02 decodeCanonicalReport — the single read boundary", () => {
  test("legacy SWE (no suite key, no family) normalizes to swe-bench/verified", () => {
    const decoded: CanonicalBenchReport = decodeCanonicalReport({
      timestamp: "t",
      model: "m",
      provider: "o",
      n: 1,
    })
    expect(decoded.benchmarkSuite).toBe("swe-bench")
    if (decoded.benchmarkSuite === "swe-bench") expect(decoded.datasetFamily).toBe("verified")
  })

  test("legacy SWE with an explicit family preserves it (whole union, both directions)", () => {
    for (const family of ["live", "pro"] as const) {
      const decoded = decodeCanonicalReport({ timestamp: "t", model: "m", datasetFamily: family })
      expect(decoded.benchmarkSuite).toBe("swe-bench")
      if (decoded.benchmarkSuite === "swe-bench") expect(decoded.datasetFamily).toBe(family)
    }
  })

  test("real disk round trip: write → read → decode recovers BOTH branches", async () => {
    await withTmp(async (dir) => {
      const sweFile = join(dir, "swe.json")
      const tbFile = join(dir, "tb.json")
      const swe = toCanonicalSweReport(
        buildReport(
          { model: "m", provider: "o", n: 1, datasetFamily: "live", timestamp: "T" },
          RESULTS,
        ),
      )
      const tb = buildTerminalBenchReport([{ id: "t1", passed: true, durationMs: 5 }], {
        datasetRef: "harbor@2.1.0",
        timestamp: "T",
        model: "m",
        preset: "p",
      })
      await writeReport(sweFile, swe)
      await writeReport(tbFile, tb)
      const sweBack = decodeCanonicalReport(JSON.parse(readFileSync(sweFile, "utf8")))
      const tbBack = decodeCanonicalReport(JSON.parse(readFileSync(tbFile, "utf8")))
      expect(sweBack).toEqual(swe)
      expect(tbBack).toEqual(tb)
    })
  })

  test("RED rail: a terminal report carrying datasetFamily fails", () => {
    expect(() =>
      decodeCanonicalReport({
        benchmarkSuite: "terminal-bench",
        benchmarkVersion: "2.1",
        datasetRef: "harbor@2.1.0",
        datasetFamily: "pro",
      }),
    ).toThrow(/datasetFamily/)
  })

  test("RED rail: ProMax as a TOP-LEVEL suite fails (it is a SWE family, not a suite)", () => {
    expect(() => decodeCanonicalReport({ benchmarkSuite: "promax", totals: {} })).toThrow()
    // PMX-05 landed the FAMILY-axis registration, so the family form now decodes…
    const decoded = decodeCanonicalReport({
      benchmarkSuite: "swe-bench",
      datasetFamily: "promax",
    })
    expect(decoded.benchmarkSuite).toBe("swe-bench")
    if (decoded.benchmarkSuite === "swe-bench") expect(decoded.datasetFamily).toBe("promax")
    // …while an unregistered family is STILL refused (fail-closed, never a silent
    // verified fallback) — the admission rail is a registry, not an amnesty.
    expect(() =>
      decodeCanonicalReport({ benchmarkSuite: "swe-bench", datasetFamily: "promaxx" }),
    ).toThrow(/datasetFamily/)
  })

  test("RED rail: an unknown / missing-typed suite identity on a new report fails", () => {
    expect(() => decodeCanonicalReport({ benchmarkSuite: "mystery-suite" })).toThrow()
    expect(() => decodeCanonicalReport({ benchmarkSuite: 7 })).toThrow()
    expect(() => decodeCanonicalReport(null)).toThrow()
    expect(() => decodeCanonicalReport("report")).toThrow()
  })

  test("RED rail: NO inference from fields — terminal-shaped payload without identity fails", () => {
    // The legacy fallback normalizes ONLY to swe-bench. A payload that smells
    // terminal (datasetRef / benchmarkVersion) but declares no suite must NOT be
    // guessed into either branch.
    expect(() => decodeCanonicalReport({ datasetRef: "harbor@2.1.0", perInstance: [] })).toThrow()
    expect(() => decodeCanonicalReport({ benchmarkVersion: "2.1", perInstance: [] })).toThrow()
  })

  test("RED rail: a swe-bench report carrying terminal identity fields fails", () => {
    expect(() =>
      decodeCanonicalReport({ benchmarkSuite: "swe-bench", datasetRef: "harbor@2.1.0" }),
    ).toThrow()
  })

  test("HIGH-A: a STRUCTURALLY malformed terminal artifact is refused at the boundary", () => {
    // The control: the real builder's bytes decode. Every mutation below keeps the
    // three identity fields intact — so anything that still passes proves the decode
    // is a cast, not a decode.
    const wellFormed = JSON.parse(
      JSON.stringify(
        encodeCanonicalReport(
          buildTerminalBenchReport([{ id: "t", passed: true, durationMs: 5, turns: 2 }], {
            datasetRef: "harbor@2.1.0",
            timestamp: "T",
            model: "m",
            preset: "p",
          }),
        ),
      ),
    ) as Record<string, unknown>
    expect(decodeCanonicalReport(wellFormed).benchmarkSuite).toBe("terminal-bench")

    const mutated = (patch: Record<string, unknown>): Record<string, unknown> => ({
      ...wellFormed,
      ...patch,
    })
    const rows = (row: Record<string, unknown>): Record<string, unknown> =>
      mutated({ perInstance: [row] })

    // totals — the Terminal branch's OFFICIAL-metric channel (what the dashboard reads).
    expect(() => decodeCanonicalReport(mutated({ totals: undefined }))).toThrow(/totals/)
    expect(() => decodeCanonicalReport(mutated({ totals: "3/4" }))).toThrow(/totals/)
    expect(() =>
      decodeCanonicalReport(mutated({ totals: { total: "3", resolved: 1, resolvedPct: 33 } })),
    ).toThrow(/totals\.total/)
    expect(() =>
      decodeCanonicalReport(
        mutated({ totals: { total: 3, resolved: Number.NaN, resolvedPct: 0 } }),
      ),
    ).toThrow(/totals\.resolved/)
    // per-trial receipts
    expect(() => decodeCanonicalReport(mutated({ perInstance: "nope" }))).toThrow(/perInstance/)
    expect(() => decodeCanonicalReport(mutated({ perInstance: undefined }))).toThrow(/perInstance/)
    expect(() => decodeCanonicalReport(rows({ passed: true, turns: 0, durationMs: 0 }))).toThrow(
      /perInstance\[0\]\.id/,
    )
    expect(() =>
      decodeCanonicalReport(rows({ id: "t", passed: "yes", turns: 0, durationMs: 0 })),
    ).toThrow(/perInstance\[0\]\.passed/)
    expect(() =>
      decodeCanonicalReport(rows({ id: "t", passed: true, turns: "3", durationMs: 0 })),
    ).toThrow(/perInstance\[0\]\.turns/)
    // provenance
    expect(() => decodeCanonicalReport(mutated({ knobs: undefined }))).toThrow(/knobs/)
    expect(() =>
      decodeCanonicalReport(mutated({ knobs: { preset: 7, resolved: {}, inactive: [] } })),
    ).toThrow(/knobs\.preset/)
    expect(() => decodeCanonicalReport(mutated({ timestamp: 5 }))).toThrow(/timestamp/)
    expect(() => decodeCanonicalReport(mutated({ model: 5 }))).toThrow(/model/)
    expect(() => decodeCanonicalReport(mutated({ source: undefined }))).toThrow(/source/)
    expect(() => decodeCanonicalReport(mutated({ arm: "control" }))).toThrow(/arm/)
  })

  test("HIGH-A: the decoded terminal report is a real typed value, not the raw object", () => {
    // A cast returns the SAME object identity and carries whatever junk rode along.
    const raw = JSON.parse(
      JSON.stringify(
        encodeCanonicalReport(
          buildTerminalBenchReport([{ id: "t", passed: true, durationMs: 5 }], {
            datasetRef: "harbor@2.1.0",
            timestamp: "T",
            model: "m",
            preset: "p",
          }),
        ),
      ),
    ) as Record<string, unknown>
    raw.smuggled = { exec: "rm -rf /" }
    const decoded = decodeCanonicalReport(raw)
    expect(decoded).not.toBe(raw)
    expect("smuggled" in decoded).toBe(false)
  })

  test("MED-B: the two branches' same-named `error` channel cannot cross (both ways)", () => {
    const tb = JSON.parse(
      JSON.stringify(
        encodeCanonicalReport(
          buildTerminalBenchReport([{ id: "t", passed: false, durationMs: 5 }], {
            datasetRef: "harbor@2.1.0",
            timestamp: "T",
            model: "m",
            preset: "p",
          }),
        ),
      ),
    ) as Record<string, unknown>
    const withTrialError = (error: unknown): Record<string, unknown> => ({
      ...tb,
      perInstance: [{ id: "t", passed: false, turns: 0, durationMs: 5, error }],
    })
    // A terminal receipt must NOT accept the SWE branch's `error: string`.
    expect(() => decodeCanonicalReport(withTrialError("boom"))).toThrow(/error/)
    expect(() => decodeCanonicalReport(withTrialError({ kind: "boom" }))).toThrow(/error/)
    // ...and the terminal kinds still decode (non-vacuity: it is not refusing everything).
    for (const kind of ["agent-timeout", "agent-crash"] as const) {
      const decoded = decodeCanonicalReport(withTrialError({ kind }))
      expect(decoded.benchmarkSuite).toBe("terminal-bench")
      if (decoded.benchmarkSuite === "terminal-bench") {
        expect(decoded.perInstance[0]?.error).toEqual({ kind })
      }
    }
    // Symmetrically: a SWE receipt must NOT accept the Terminal branch's `{kind}`.
    const swe = (error: unknown): Record<string, unknown> => ({
      timestamp: "t",
      model: "m",
      perInstance: [{ id: "django__django-1", passed: false, turns: 1, error }],
    })
    expect(() => decodeCanonicalReport(swe({ kind: "agent-crash" }))).toThrow(/error/)
    // ...and the SWE string form still decodes (900 live artifacts carry it).
    const okSwe = decodeCanonicalReport(swe("Error: boom"))
    expect(okSwe.benchmarkSuite).toBe("swe-bench")
    if (okSwe.benchmarkSuite === "swe-bench") {
      expect(okSwe.perInstance[0]?.error).toBe("Error: boom")
    }
  })

  test("MED-E: EVERY terminal-only key trips the branch-exclusion guard (red per key)", () => {
    // The set is type-derived (see report-envelope.ts) so a new Terminal field
    // cannot be added without listing it here.
    expect([...TERMINAL_ONLY_KEYS].sort()).toEqual(["arm", "benchmarkVersion", "datasetRef"])
    const sample: Record<string, unknown> = {
      arm: "levers",
      benchmarkVersion: "2.1",
      datasetRef: "harbor@2.1.0",
    }
    for (const key of TERMINAL_ONLY_KEYS) {
      const value = sample[key]
      // ...on an EXPLICIT swe-bench report
      expect(() =>
        decodeCanonicalReport({ benchmarkSuite: "swe-bench", timestamp: "t", [key]: value }),
      ).toThrow(new RegExp(key))
      // ...and on a LEGACY suite-less one
      expect(() => decodeCanonicalReport({ timestamp: "t", [key]: value })).toThrow(new RegExp(key))
    }
    // CONTROL — `totals` and `source` are NOT terminal-only: BenchReport declares
    // `totals` as REQUIRED and 3994/4018 live artifacts carry it, while `source`
    // rides 5 real pre-canonical SWE artifacts (report-campaign-recovered-*).
    // Listing either would refuse the entire live SWE corpus.
    const withShared = decodeCanonicalReport({
      timestamp: "t",
      model: "m",
      totals: { total: 2, resolved: 1, resolvedPct: 50 },
      source: "recovered-from-campaign-log",
    })
    expect(withShared.benchmarkSuite).toBe("swe-bench")
  })

  test("MED-E: a REAL built SWE report carries none of the terminal-only keys", () => {
    // Ratchet from the other side: if a terminal-only key ever became a SWE field,
    // this fails instead of silently refusing every SWE report at the boundary.
    const encoded = encodeCanonicalReport(
      toCanonicalSweReport(
        buildReport({ model: "m", provider: "o", n: 2, datasetFamily: "pro" }, RESULTS),
      ),
    )
    for (const key of TERMINAL_ONLY_KEYS) expect(key in encoded).toBe(false)
  })

  test("terminal identity is validated, not trusted: bad version / blank ref fail", () => {
    expect(() =>
      decodeCanonicalReport({
        benchmarkSuite: "terminal-bench",
        benchmarkVersion: "9.9",
        datasetRef: "d",
      }),
    ).toThrow(/benchmarkVersion/)
    expect(() =>
      decodeCanonicalReport({
        benchmarkSuite: "terminal-bench",
        benchmarkVersion: "2.1",
        datasetRef: "",
      }),
    ).toThrow(/datasetRef/)
  })
})

// ───────────────────── MED-B: the branches' receipt types are disjoint ───────

/**
 * TYPE-LEVEL proof (checked by `bun run typecheck:tests`, not by `bun test`).
 *
 * `[A] extends [B]` is the assignability question written as a value, so a
 * regression flips a `false` literal to `true` and fails to compile. Each
 * assertion is PAIRED with a control that must be `true`, so the helper cannot
 * be silently broken into always answering `false` (the vacuity failure mode).
 */
type Assignable<A, B> = [A] extends [B] ? true : false
type ErrorChannelOf<T> = T extends { error?: infer E } ? NonNullable<E> : never

// Controls: the helper CAN answer true, and each branch is assignable to itself.
const _selfTerminal: Assignable<TerminalTrialReceipt, TerminalTrialReceipt> = true
const _selfSwe: Assignable<PerInstanceReport, PerInstanceReport> = true

// A Terminal trial receipt is not a SWE per-instance report, and vice versa.
const _terminalIsNotSwe: Assignable<TerminalTrialReceipt, PerInstanceReport> = false
const _sweIsNotTerminal: Assignable<PerInstanceReport, TerminalTrialReceipt> = false

// ...and specifically the same-named `error` CHANNEL cannot cross either way.
const _terminalErrorIsNotSweError: Assignable<
  ErrorChannelOf<TerminalTrialReceipt>,
  ErrorChannelOf<PerInstanceReport>
> = false
const _sweErrorIsNotTerminalError: Assignable<
  ErrorChannelOf<PerInstanceReport>,
  ErrorChannelOf<TerminalTrialReceipt>
> = false
// Control for the extractor itself — it really does pull a non-never type out.
const _errorChannelIsReal: Assignable<
  { kind: "agent-crash" },
  ErrorChannelOf<TerminalTrialReceipt>
> = true

test("MED-B type-level disjointness assertions are LOADED (not dead code)", () => {
  // Keeps the compile-time assertions above referenced at runtime so a linter or
  // a bundler cannot drop them, and makes the rail visible in the test report.
  expect([
    _selfTerminal,
    _selfSwe,
    _terminalIsNotSwe,
    _sweIsNotTerminal,
    _terminalErrorIsNotSweError,
    _sweErrorIsNotTerminalError,
    _errorChannelIsReal,
  ]).toEqual([true, true, false, false, false, false, true])
})

// ───────────────────────── one canonical mirror sink ─────────────────────────

describe("BFND-02 canonical mirror — one sink, no duplicate scatter", () => {
  test("writeReport mirrors into QUANTA_BENCH_RESULTS_DIR (real fs)", async () => {
    await withTmp(async (dir) => {
      const results = join(dir, "ssot")
      const prev = process.env.QUANTA_BENCH_RESULTS_DIR
      process.env.QUANTA_BENCH_RESULTS_DIR = results
      __resetRuntimeConfig()
      try {
        const file = join(dir, "run", "report.json")
        await writeReport(
          file,
          toCanonicalSweReport(buildReport({ model: "m", provider: "o", n: 1 }, RESULTS)),
        )
        const mirrored = readdirSync(results)
        expect(mirrored).toHaveLength(1)
        // The mirror carries the SAME bytes as the primary write.
        expect(readFileSync(join(results, mirrored[0] ?? ""), "utf8")).toBe(
          readFileSync(file, "utf8"),
        )
      } finally {
        if (prev === undefined) delete process.env.QUANTA_BENCH_RESULTS_DIR
        else process.env.QUANTA_BENCH_RESULTS_DIR = prev
        __resetRuntimeConfig()
      }
    })
  })

  test("a report ALREADY written into the canonical dir is not re-mirrored as a mangled twin", async () => {
    // The TB emitter writes straight into the results dir. Without this guard the
    // mirror would drop a second `*.report.json` beside it and the dashboard would
    // scan the SAME run twice.
    await withTmp(async (dir) => {
      const prev = process.env.QUANTA_BENCH_RESULTS_DIR
      process.env.QUANTA_BENCH_RESULTS_DIR = dir
      __resetRuntimeConfig()
      try {
        const file = join(dir, "report-terminal-bench-tb.report.json")
        await writeReport(
          file,
          buildTerminalBenchReport([{ id: "t", passed: true, durationMs: 1 }], {
            datasetRef: "harbor@2.1.0",
            timestamp: "T",
            model: "m",
            preset: "p",
          }),
        )
        expect(readdirSync(dir)).toEqual(["report-terminal-bench-tb.report.json"])
      } finally {
        if (prev === undefined) delete process.env.QUANTA_BENCH_RESULTS_DIR
        else process.env.QUANTA_BENCH_RESULTS_DIR = prev
        __resetRuntimeConfig()
      }
    })
  })

  test("mirrorReportToSsot stays best-effort (a broken sink never throws)", async () => {
    const prev = process.env.QUANTA_BENCH_RESULTS_DIR
    process.env.QUANTA_BENCH_RESULTS_DIR = "off"
    __resetRuntimeConfig()
    try {
      await mirrorReportToSsot("/tmp/whatever/report.json", "{}")
    } finally {
      if (prev === undefined) delete process.env.QUANTA_BENCH_RESULTS_DIR
      else process.env.QUANTA_BENCH_RESULTS_DIR = prev
      __resetRuntimeConfig()
    }
  })
})

// ───────────────────────── ownership rails (source-scan, mandated) ───────────

describe("BFND-02 writer ownership — one writer, one results-dir owner", () => {
  /** The module that DEFINES the canonical writer (excluded from caller scans). */
  const WRITER_MODULE = "src/runner/batch/report-envelope.ts"
  /** Every product module allowed to invoke the canonical writer. */
  const KNOWN_WRITE_REPORT_CALLERS = [
    "src/runner/batch/core.ts",
    "tools/leaderboard-dashboard/tb-report-emit.ts",
  ]
  /**
   * Pre-canonical raw report writers that BFND-02 did not convert. Ratchet, not
   * amnesty: a NEW raw writer fails here, and converting this one fails too
   * (forcing the list to shrink deliberately).
   */
  const KNOWN_RAW_REPORT_WRITERS = ["tools/leaderboard-dashboard/campaign-log-to-report.ts"]

  // A LIVE call, not an import and not a `.writeReport(` port invocation (the
  // terminal brain surface injects its OWN unrelated writeReport port).
  const liveWriteReport = /(?<![.\w$])writeReport\s*\(/
  // A raw serialization of a `report` value straight to disk.
  const rawReportWrite = /(?:writeFileSync|Bun\.write)\s*\([^;]*JSON\.stringify\(\s*report\b/

  test("detectors are non-vacuous (they fire on the real thing, not on look-alikes)", () => {
    expect(liveWriteReport.test("await writeReport(file, report)")).toBe(true)
    expect(liveWriteReport.test('import { writeReport } from "./report-envelope"')).toBe(false)
    expect(liveWriteReport.test("opts.writeReport(opts.reportOut, report)")).toBe(false)
    expect(liveWriteReport.test("export { writeReport } from './report-envelope'")).toBe(false)
    expect(rawReportWrite.test("writeFileSync(dest, JSON.stringify(report, null, 2))")).toBe(true)
    expect(rawReportWrite.test("await Bun.write(dest, JSON.stringify(report))")).toBe(true)
    // The terminal BRAIN surface writes its own per-task harbor artifact (a trial
    // receipt, not a bench report). It must NOT be swept up by this ratchet.
    const brainModeWrite = [
      "writeFileSync(path, `",
      "${JSON.stringify(obj, null, 2)}",
      "\\n`)",
    ].join("")
    expect(rawReportWrite.test(brainModeWrite)).toBe(false)
    expect(read("src/apps/terminal/brain-mode.ts")).toContain(brainModeWrite)
  })

  test("every live writeReport( caller is a KNOWN product caller", () => {
    const callers = sourceFiles(["src", "tools"]).filter(
      (f) => f !== WRITER_MODULE && liveWriteReport.test(read(f)),
    )
    expect(callers).toEqual([...KNOWN_WRITE_REPORT_CALLERS].sort())
  })

  test("no product module serializes a report itself (single-writer ratchet)", () => {
    const rawWriters = sourceFiles(["src", "tools"]).filter((f) => rawReportWrite.test(read(f)))
    expect(rawWriters).toEqual([...KNOWN_RAW_REPORT_WRITERS].sort())
    // Every canonical caller in particular must be clean.
    for (const caller of KNOWN_WRITE_REPORT_CALLERS) {
      expect(rawReportWrite.test(read(caller))).toBe(false)
    }
  })

  test("exactly ONE canonical results-dir owner; canonical writers never re-derive it", () => {
    const owners = sourceFiles(["src", "tools"]).filter((f) =>
      /const\s+benchResultsDir\s*=\s*\(/.test(read(f)),
    )
    expect(owners).toEqual([WRITER_MODULE])
    // A module that persists through the canonical writer must not hand-roll the
    // QUANTA_BENCH_RESULTS_DIR fallback chain a second time.
    for (const caller of KNOWN_WRITE_REPORT_CALLERS) {
      expect(read(caller).includes("QUANTA_BENCH_RESULTS_DIR")).toBe(false)
    }
    // The full-remote sidecar reuses the SAME sink rather than opening its own.
    const box = read("src/apps/bench/remote/box-session.ts")
    expect(box).toContain("mirrorReportToSsot")
    expect(/const\s+benchResultsDir\s*=\s*\(/.test(box)).toBe(false)
  })
})
