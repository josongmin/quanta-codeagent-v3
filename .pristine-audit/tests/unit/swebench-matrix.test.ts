/**
 * Unit tests for `tools/swebench-matrix.ts`:
 *   1) condition CSV → ENV mapping (8 conditions × 3 axes)
 *   2) pure aggregation (pass@1, averages) and markdown table rendering
 *   3) synthetic JSONL/`summary.json` → MatrixRow[] round-trip (no real bench)
 *
 * The bench spawn itself is NOT exercised here (it would require an LLM);
 * instead we drop the same artifacts on disk that bench would write and call
 * the pure `collectRowsForCondition` parser.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AXES,
  AXIS_ENV,
  aggregate,
  axesOf,
  CONDITIONS,
  collectRowsForCondition,
  conditionToEnv,
  formatMatrixTable,
  type MatrixRow,
  parseArgs,
  parseConditions,
  readPickIds,
} from "@/../tools/swebench-matrix"

describe("condition → ENV mapping", () => {
  test("CONDITIONS has exactly 8 entries in canonical order", () => {
    expect(CONDITIONS).toEqual([
      "baseline",
      "lsp",
      "subagent",
      "skills",
      "lsp+subagent",
      "lsp+skills",
      "subagent+skills",
      "all",
    ])
    expect(CONDITIONS.length).toBe(8)
  })

  test("AXIS_ENV has exactly 3 axes mapped to QUANTA_BENCH_*", () => {
    expect(Object.keys(AXIS_ENV).sort()).toEqual(["lsp", "skills", "subagent"])
    expect(AXIS_ENV.lsp).toBe("QUANTA_BENCH_LSP")
    expect(AXIS_ENV.subagent).toBe("QUANTA_BENCH_SUBAGENT")
    expect(AXIS_ENV.skills).toBe("QUANTA_BENCH_SKILLS")
  })

  test("baseline yields empty env overlay (default-OFF preservation)", () => {
    expect(conditionToEnv("baseline")).toEqual({})
    expect(axesOf("baseline")).toEqual([])
  })

  test("single-axis conditions set exactly one env var", () => {
    expect(conditionToEnv("lsp")).toEqual({ QUANTA_BENCH_LSP: "1" })
    expect(conditionToEnv("subagent")).toEqual({ QUANTA_BENCH_SUBAGENT: "1" })
    expect(conditionToEnv("skills")).toEqual({ QUANTA_BENCH_SKILLS: "1" })
  })

  test("2-axis combos set exactly two env vars", () => {
    expect(conditionToEnv("lsp+subagent")).toEqual({
      QUANTA_BENCH_LSP: "1",
      QUANTA_BENCH_SUBAGENT: "1",
    })
    expect(conditionToEnv("lsp+skills")).toEqual({
      QUANTA_BENCH_LSP: "1",
      QUANTA_BENCH_SKILLS: "1",
    })
    expect(conditionToEnv("subagent+skills")).toEqual({
      QUANTA_BENCH_SUBAGENT: "1",
      QUANTA_BENCH_SKILLS: "1",
    })
  })

  test("'all' sets every axis (3 env vars)", () => {
    expect(conditionToEnv("all")).toEqual({
      QUANTA_BENCH_LSP: "1",
      QUANTA_BENCH_SUBAGENT: "1",
      QUANTA_BENCH_SKILLS: "1",
    })
  })

  test("8 × 3 matrix: each (condition, axis) is ON iff axis ∈ axesOf(condition)", () => {
    for (const c of CONDITIONS) {
      const env = conditionToEnv(c)
      const expectedOn = new Set<string>(axesOf(c).map((a) => AXIS_ENV[a]))
      for (const a of AXES) {
        const key = AXIS_ENV[a]
        if (expectedOn.has(key)) {
          expect(env[key]).toBe("1")
        } else {
          // Strict: OFF axes MUST NOT appear in the overlay (no =0 either).
          expect(Object.hasOwn(env, key)).toBe(false)
        }
      }
    }
  })
})

describe("parseConditions", () => {
  test("undefined / empty defaults to all 8 in canonical order", () => {
    expect(parseConditions(undefined)).toEqual(CONDITIONS)
    expect(parseConditions("")).toEqual(CONDITIONS)
    expect(parseConditions("   ")).toEqual(CONDITIONS)
  })

  test("CSV with valid conditions preserves caller order (not canonical)", () => {
    expect(parseConditions("all,baseline,lsp")).toEqual(["all", "baseline", "lsp"])
  })

  test("unknown condition throws with the valid list in the message", () => {
    expect(() => parseConditions("baseline,bogus")).toThrow(/unknown condition "bogus"/)
    expect(() => parseConditions("baseline,bogus")).toThrow(/baseline/)
  })

  test("ignores blank tokens between commas", () => {
    expect(parseConditions("baseline,,lsp,")).toEqual(["baseline", "lsp"])
  })
})

// ── pure aggregation ───────────────────────────────────────────────────────

const mkRow = (over: Partial<MatrixRow>): MatrixRow => ({
  condition: "baseline",
  pickId: "x__y-1",
  verdict: "pass",
  turns: 1,
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  wallMs: 0,
  costUsd: 0,
  ...over,
})

describe("aggregate", () => {
  test("pass@1 counts only verdict=='pass' over non-degraded total", () => {
    const rows: MatrixRow[] = [
      mkRow({ condition: "baseline", pickId: "a", verdict: "pass" }),
      mkRow({ condition: "baseline", pickId: "b", verdict: "fail" }),
      mkRow({ condition: "baseline", pickId: "c", verdict: "degraded" }),
      mkRow({ condition: "baseline", pickId: "d", verdict: "error" }),
    ]
    const stats = aggregate(rows)
    expect(stats).toHaveLength(1)
    const s = stats[0]
    if (s === undefined) throw new Error("expected one row")
    expect(s.condition).toBe("baseline")
    expect(s.passed).toBe(1)
    // 'degraded' EXCLUDED; 'error' INCLUDED in denominator (fail-to-deliver).
    expect(s.total).toBe(3)
    expect(s.passAt1Pct).toBeCloseTo(33.3, 1)
  })

  test("averages compute over non-degraded only", () => {
    const rows: MatrixRow[] = [
      mkRow({
        pickId: "a",
        verdict: "pass",
        turns: 10,
        tokensIn: 1000,
        tokensOut: 200,
        wallMs: 5000,
      }),
      mkRow({
        pickId: "b",
        verdict: "fail",
        turns: 30,
        tokensIn: 3000,
        tokensOut: 600,
        wallMs: 15000,
      }),
      mkRow({
        pickId: "c",
        verdict: "degraded",
        turns: 999,
        tokensIn: 999999,
        tokensOut: 9999,
        wallMs: 9_000_000,
      }),
    ]
    const stats = aggregate(rows)
    const s = stats[0]
    if (s === undefined) throw new Error("expected one row")
    expect(s.avgTurns).toBe(20) // (10+30)/2 — degraded excluded
    expect(s.avgTokensIn).toBe(2000)
    expect(s.avgTokensOut).toBe(400)
    expect(s.avgWallMs).toBe(10000)
  })

  test("output rows are emitted in CONDITIONS canonical order regardless of input order", () => {
    const rows: MatrixRow[] = [
      mkRow({ condition: "all", pickId: "a" }),
      mkRow({ condition: "baseline", pickId: "b" }),
      mkRow({ condition: "lsp+skills", pickId: "c" }),
    ]
    const stats = aggregate(rows)
    expect(stats.map((s) => s.condition)).toEqual(["baseline", "lsp+skills", "all"])
  })

  test("empty input → empty stats", () => {
    expect(aggregate([])).toEqual([])
  })
})

describe("formatMatrixTable", () => {
  test("emits markdown header + separator + one row per condition", () => {
    const rows: MatrixRow[] = [
      mkRow({ condition: "baseline", pickId: "a", verdict: "pass" }),
      mkRow({ condition: "all", pickId: "b", verdict: "fail" }),
    ]
    const table = formatMatrixTable(aggregate(rows))
    const lines = table.split("\n")
    expect(lines[0]).toContain("condition")
    expect(lines[0]).toContain("pass@1")
    expect(lines[1]).toMatch(/^\| --- \|/)
    expect(lines).toHaveLength(4) // header + sep + 2 data rows
    expect(lines[2]).toContain("baseline")
    expect(lines[3]).toContain("all")
  })
})

// ── parseArgs ──────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  test("requires --dataset, --corpus, --out", () => {
    expect(() => parseArgs([])).toThrow(/--dataset/)
    expect(() => parseArgs(["--dataset", "d"])).toThrow(/--corpus/)
    expect(() => parseArgs(["--dataset", "d", "--corpus", "c"])).toThrow(/--out/)
  })

  test("defaults: model=gpt-5, max-turns=30, timeout-ms=600000, all 8 conditions, no python-grade", () => {
    const a = parseArgs(["--dataset", "d", "--corpus", "c", "--out", "o"])
    expect(a.model).toBe("gpt-5")
    expect(a.maxTurns).toBe(30)
    expect(a.timeoutMs).toBe(600_000)
    expect(a.conditions).toEqual(CONDITIONS)
    expect(a.pythonGrade).toBe(false)
  })

  test("--python-grade flag is captured; --conditions narrows the sweep", () => {
    const a = parseArgs([
      "--dataset",
      "d",
      "--corpus",
      "c",
      "--out",
      "o",
      "--conditions",
      "baseline,all",
      "--python-grade",
    ])
    expect(a.pythonGrade).toBe(true)
    expect(a.conditions).toEqual(["baseline", "all"])
  })
})

// ── synthetic on-disk round-trip ────────────────────────────────────────────

describe("collectRowsForCondition (mocked bench artifacts)", () => {
  test("parses summary.json + JSONL stream into MatrixRow[]", () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-roundtrip-"))
    try {
      const runDir = join(dir, "run-x")
      mkdirSync(runDir, { recursive: true })
      // bench summary.json — picks one pass, one fail, one degraded.
      const summary = {
        runId: "run-x",
        resolved: 1,
        total: 2,
        degraded: 1,
        instances: [
          { id: "psf__requests-5414", passed: true, verdict: "ok", turns: 12 },
          { id: "pallets__flask-5014", passed: false, verdict: "ok", turns: 30 },
          { id: "sympy__sympy-12345", passed: false, verdict: "degraded", turns: 0 },
        ],
      }
      writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary))
      // JSONL attempts — one per instance. The matcher uses substring on id.
      const ts0 = 1_000_000_000_000
      writeFileSync(
        join(runDir, "psf__requests-5414.0.jsonl"),
        [
          JSON.stringify({ type: "turn_started", ts: ts0, id: "psf__requests-5414" }),
          JSON.stringify({
            type: "usage",
            ts: ts0 + 1000,
            model: "gpt-4o",
            inputTokens: 1500,
            outputTokens: 200,
            cacheReadTokens: 100,
          }),
          JSON.stringify({ type: "turn_ended", ts: ts0 + 8000 }),
        ].join("\n"),
      )
      writeFileSync(
        join(runDir, "pallets__flask-5014.0.jsonl"),
        [
          JSON.stringify({ type: "turn_started", ts: ts0, id: "pallets__flask-5014" }),
          JSON.stringify({
            type: "usage",
            ts: ts0 + 500,
            model: "gpt-4o",
            inputTokens: 4000,
            outputTokens: 800,
          }),
          JSON.stringify({ type: "turn_ended", ts: ts0 + 20_000 }),
        ].join("\n"),
      )
      const rows = collectRowsForCondition(
        "lsp",
        runDir,
        ["psf__requests-5414", "pallets__flask-5014", "sympy__sympy-12345"],
        "fail",
      )
      expect(rows).toHaveLength(3)
      const pass = rows.find((r) => r.pickId === "psf__requests-5414")
      if (pass === undefined) throw new Error("missing pass row")
      expect(pass.condition).toBe("lsp")
      expect(pass.verdict).toBe("pass")
      expect(pass.turns).toBe(12)
      expect(pass.tokensIn).toBe(1500)
      expect(pass.tokensOut).toBe(200)
      expect(pass.cacheRead).toBe(100)
      expect(pass.wallMs).toBe(8000)
      // costUsd: gpt-4o is in the price table → must be > 0.
      expect(pass.costUsd).toBeGreaterThan(0)
      const fail = rows.find((r) => r.pickId === "pallets__flask-5014")
      if (fail === undefined) throw new Error("missing fail row")
      expect(fail.verdict).toBe("fail")
      // wall = last ts (ts0+20000) − first ts (ts0+0) = 20000ms.
      expect(fail.wallMs).toBe(20_000)
      const deg = rows.find((r) => r.pickId === "sympy__sympy-12345")
      if (deg === undefined) throw new Error("missing degraded row")
      expect(deg.verdict).toBe("degraded")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("missing summary.json → every pick reported with fallback verdict", () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-nosummary-"))
    try {
      const runDir = join(dir, "run-y")
      mkdirSync(runDir, { recursive: true })
      const rows = collectRowsForCondition("baseline", runDir, ["a", "b"], "error")
      expect(rows).toHaveLength(2)
      expect(rows.every((r) => r.verdict === "error")).toBe(true)
      expect(rows.every((r) => r.costUsd === 0)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("unknown model in usage event ⇒ costUsd === 0 (no invented price)", () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-unkmodel-"))
    try {
      const runDir = join(dir, "run-z")
      mkdirSync(runDir, { recursive: true })
      const summary = {
        runId: "run-z",
        resolved: 0,
        total: 1,
        degraded: 0,
        instances: [{ id: "foo__bar-1", passed: false, verdict: "ok", turns: 5 }],
      }
      writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary))
      writeFileSync(
        join(runDir, "foo__bar-1.0.jsonl"),
        [
          JSON.stringify({ type: "turn_started", ts: 0, id: "foo__bar-1" }),
          JSON.stringify({
            type: "usage",
            ts: 1000,
            model: "some-unknown-model-vNext",
            inputTokens: 999,
            outputTokens: 111,
          }),
        ].join("\n"),
      )
      const rows = collectRowsForCondition("baseline", runDir, ["foo__bar-1"], "fail")
      expect(rows).toHaveLength(1)
      const r = rows[0]
      if (r === undefined) throw new Error("missing row")
      expect(r.tokensIn).toBe(999)
      expect(r.costUsd).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("readPickIds", () => {
  test("extracts instance_id lines from SWE-bench JSONL, skipping blanks", () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-picks-"))
    try {
      const file = join(dir, "picks.jsonl")
      writeFileSync(
        file,
        [
          JSON.stringify({ instance_id: "a__x-1", repo: "a/x" }),
          "",
          JSON.stringify({ instance_id: "b__y-2", repo: "b/y" }),
          "# comment",
          "not-json-not-counted",
        ].join("\n"),
      )
      expect(readPickIds(file)).toEqual(["a__x-1", "b__y-2"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
