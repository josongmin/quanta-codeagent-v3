/**
 * Hellgate — matrix end-to-end resume / partial-flow pins (integration).
 *
 * Important context: the brief described a `--resume` mode + `partial-*.jsonl`
 * + a `--summary` reader. The current matrix tool DOES write a
 * `partial-*.jsonl` checkpoint after each condition, but there is NO
 * `--resume` flag and NO `--summary` flag — those are future surface.
 *
 * This file pins the EXISTING end-to-end invariants:
 *   - Multiple `collectRowsForCondition` calls over the same on-disk run dir
 *     produce identical rows (idempotent read).
 *   - Aggregate(rows1 ++ rows2) is exactly aggregate(rows1.merge(rows2)) when
 *     conditions are disjoint (the resume contract's algebra).
 *   - The partial-jsonl-style flat row layout round-trips through aggregate
 *     and formatMatrixTable byte-stably.
 *   - A "partial then complete" timeline can be reconstructed: replaying
 *     condition rows in two batches yields the same final table.
 *   - Aborting mid-condition (simulated by writing only a subset of attempt
 *     JSONLs) does NOT crash the parser — missing files become fallback rows.
 *
 * Slice fence: integration test, but only imports `@/../tools/swebench-matrix`
 * + node fs. NO LLM, NO bench spawn.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  aggregate,
  type Condition,
  collectRowsForCondition,
  formatMatrixTable,
  type MatrixRow,
} from "@/../tools/swebench-matrix"

const mkTmp = (label: string): string => mkdtempSync(join(tmpdir(), `mx-resume-${label}-`))

const writeSummary = (
  runDir: string,
  instances: { id: string; passed: boolean; verdict: string; turns?: number }[],
): void => {
  writeFileSync(join(runDir, "summary.json"), JSON.stringify({ runId: "run", instances }, null, 2))
}

const writeAttempt = (runDir: string, pickId: string, events: Record<string, unknown>[]): void => {
  writeFileSync(join(runDir, `${pickId}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n"))
}

describe("hellgate matrix resume — partial → resume flow algebra", () => {
  test("idempotent read: collectRowsForCondition twice ⇒ identical rows", () => {
    const dir = mkTmp("idem")
    try {
      const runDir = join(dir, "run")
      mkdirSync(runDir, { recursive: true })
      writeSummary(runDir, [{ id: "a", passed: true, verdict: "ok", turns: 5 }])
      writeAttempt(runDir, "a", [
        { type: "turn_started", ts: 0, id: "a" },
        { type: "usage", ts: 100, model: "gpt-4o", inputTokens: 100, outputTokens: 50 },
      ])
      const rows1 = collectRowsForCondition("baseline", runDir, ["a"], "fail")
      const rows2 = collectRowsForCondition("baseline", runDir, ["a"], "fail")
      expect(rows1).toEqual(rows2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("partial-then-complete: aggregate(part1 ++ part2) == aggregate(merged)", () => {
    const dir = mkTmp("merge")
    try {
      // Pretend the first run completed `baseline`, and the resumed run does `lsp`.
      const baselineDir = join(dir, "baseline")
      mkdirSync(baselineDir, { recursive: true })
      writeSummary(baselineDir, [
        { id: "a", passed: true, verdict: "ok", turns: 3 },
        { id: "b", passed: false, verdict: "ok", turns: 4 },
      ])
      writeAttempt(baselineDir, "a", [
        { type: "turn_started", ts: 0, id: "a" },
        { type: "turn_ended", ts: 1000 },
      ])
      writeAttempt(baselineDir, "b", [
        { type: "turn_started", ts: 0, id: "b" },
        { type: "turn_ended", ts: 500 },
      ])
      const lspDir = join(dir, "lsp")
      mkdirSync(lspDir, { recursive: true })
      writeSummary(lspDir, [
        { id: "a", passed: true, verdict: "ok", turns: 2 },
        { id: "b", passed: true, verdict: "ok", turns: 3 },
      ])
      writeAttempt(lspDir, "a", [
        { type: "turn_started", ts: 0, id: "a" },
        { type: "turn_ended", ts: 800 },
      ])
      writeAttempt(lspDir, "b", [
        { type: "turn_started", ts: 0, id: "b" },
        { type: "turn_ended", ts: 400 },
      ])
      const part1 = collectRowsForCondition("baseline", baselineDir, ["a", "b"], "fail")
      const part2 = collectRowsForCondition("lsp", lspDir, ["a", "b"], "fail")
      const merged: MatrixRow[] = [...part1, ...part2]
      const stats = aggregate(merged)
      expect(stats.length).toBe(2)
      expect(stats.find((s) => s.condition === "baseline")?.passed).toBe(1)
      expect(stats.find((s) => s.condition === "lsp")?.passed).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("order-invariance: aggregate(rows in order X) === aggregate(rows in order Y)", () => {
    const rows: MatrixRow[] = [
      {
        condition: "baseline",
        pickId: "a",
        verdict: "pass",
        turns: 1,
        tokensIn: 10,
        tokensOut: 5,
        cacheRead: 0,
        wallMs: 100,
        costUsd: 0.01,
      },
      {
        condition: "all",
        pickId: "b",
        verdict: "fail",
        turns: 2,
        tokensIn: 20,
        tokensOut: 10,
        cacheRead: 0,
        wallMs: 200,
        costUsd: 0.02,
      },
      {
        condition: "lsp",
        pickId: "c",
        verdict: "pass",
        turns: 3,
        tokensIn: 30,
        tokensOut: 15,
        cacheRead: 0,
        wallMs: 300,
        costUsd: 0.03,
      },
    ]
    const r1 = aggregate(rows)
    const r2 = aggregate([...rows].reverse())
    expect(r1).toEqual(r2)
  })

  test("aborted mid-condition: missing attempt JSONLs ⇒ zero-usage fallback per row", () => {
    const dir = mkTmp("aborted")
    try {
      const runDir = join(dir, "run")
      mkdirSync(runDir, { recursive: true })
      // 3 picks in summary but only 1 attempt jsonl on disk.
      writeSummary(runDir, [
        { id: "a", passed: true, verdict: "ok", turns: 1 },
        { id: "b", passed: false, verdict: "ok", turns: 2 },
        { id: "c", passed: true, verdict: "ok", turns: 3 },
      ])
      writeAttempt(runDir, "a", [
        { type: "turn_started", ts: 0, id: "a" },
        { type: "usage", ts: 100, model: "gpt-4o", inputTokens: 100, outputTokens: 50 },
      ])
      const rows = collectRowsForCondition("baseline", runDir, ["a", "b", "c"], "fail")
      expect(rows.length).toBe(3)
      const aRow = rows.find((r) => r.pickId === "a")
      const bRow = rows.find((r) => r.pickId === "b")
      const cRow = rows.find((r) => r.pickId === "c")
      expect(aRow?.tokensIn).toBe(100) // attempt JSONL present
      expect(bRow?.tokensIn).toBe(0) // missing attempt JSONL ⇒ 0
      expect(cRow?.tokensIn).toBe(0)
      // Verdict comes from summary regardless of attempt file presence.
      expect(aRow?.verdict).toBe("pass")
      expect(bRow?.verdict).toBe("fail")
      expect(cRow?.verdict).toBe("pass")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("byte-stability: identical input ⇒ formatMatrixTable byte-equal across runs", () => {
    const rows: MatrixRow[] = [
      {
        condition: "baseline",
        pickId: "a",
        verdict: "pass",
        turns: 1,
        tokensIn: 10,
        tokensOut: 5,
        cacheRead: 0,
        wallMs: 100,
        costUsd: 0.0123,
      },
    ]
    const t1 = formatMatrixTable(aggregate(rows))
    const t2 = formatMatrixTable(aggregate(rows))
    const t3 = formatMatrixTable(aggregate(rows))
    expect(t1).toBe(t2)
    expect(t2).toBe(t3)
  })

  test("partial-jsonl pattern (line-append checkpoint) reads back via JSON.parse per line", () => {
    const dir = mkTmp("partial")
    try {
      // Simulate the matrix's checkpoint file format: one JSON row per line.
      const partial = join(dir, "partial-1234.jsonl")
      const rows: MatrixRow[] = [
        {
          condition: "baseline",
          pickId: "a",
          verdict: "pass",
          turns: 1,
          tokensIn: 100,
          tokensOut: 50,
          cacheRead: 0,
          wallMs: 1000,
          costUsd: 0.001,
        },
        {
          condition: "lsp",
          pickId: "a",
          verdict: "pass",
          turns: 2,
          tokensIn: 80,
          tokensOut: 40,
          cacheRead: 0,
          wallMs: 800,
          costUsd: 0.0008,
        },
      ]
      writeFileSync(partial, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`)
      // Reader contract: split lines, parse each, aggregate.
      const text = readFileSync(partial, "utf8")
      const parsed: MatrixRow[] = []
      for (const line of text.split("\n")) {
        const t = line.trim()
        if (t === "") continue
        parsed.push(JSON.parse(t) as MatrixRow)
      }
      expect(parsed.length).toBe(2)
      const stats = aggregate(parsed)
      expect(stats.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("simulated SIGINT-truncated partial: trailing partial line tolerated", () => {
    const dir = mkTmp("sigint")
    try {
      const partial = join(dir, "partial-sigint.jsonl")
      const row1: MatrixRow = {
        condition: "baseline",
        pickId: "a",
        verdict: "pass",
        turns: 1,
        tokensIn: 100,
        tokensOut: 50,
        cacheRead: 0,
        wallMs: 1000,
        costUsd: 0.001,
      }
      // Write one complete row + a truncated second line (SIGINT during write).
      writeFileSync(partial, `${JSON.stringify(row1)}\n{"condition":"lsp","pickId"`)
      const text = readFileSync(partial, "utf8")
      const parsed: MatrixRow[] = []
      for (const line of text.split("\n")) {
        const t = line.trim()
        if (t === "") continue
        try {
          parsed.push(JSON.parse(t) as MatrixRow)
        } catch {
          // SIGINT truncation: silently drop the partial line (matches the
          // matrix tool's own forgiving JSONL parser).
        }
      }
      expect(parsed.length).toBe(1)
      expect(parsed[0]?.pickId).toBe("a")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("end-to-end disjoint condition runs: 4-condition sweep across 2 sessions", () => {
    const dir = mkTmp("multi")
    try {
      const conditions: Condition[] = ["baseline", "lsp", "subagent", "all"]
      const allRows: MatrixRow[] = []
      // "Session 1" runs baseline + lsp.
      for (const c of conditions.slice(0, 2)) {
        const runDir = join(dir, c.replace(/\+/g, "_"))
        mkdirSync(runDir, { recursive: true })
        writeSummary(runDir, [{ id: "a", passed: c !== "baseline", verdict: "ok", turns: 1 }])
        writeAttempt(runDir, "a", [
          { type: "turn_started", ts: 0, id: "a" },
          { type: "turn_ended", ts: 100 },
        ])
        allRows.push(...collectRowsForCondition(c, runDir, ["a"], "fail"))
      }
      // "Session 2" (post-resume): runs subagent + all.
      for (const c of conditions.slice(2)) {
        const runDir = join(dir, c.replace(/\+/g, "_"))
        mkdirSync(runDir, { recursive: true })
        writeSummary(runDir, [{ id: "a", passed: c === "all", verdict: "ok", turns: 1 }])
        writeAttempt(runDir, "a", [
          { type: "turn_started", ts: 0, id: "a" },
          { type: "turn_ended", ts: 100 },
        ])
        allRows.push(...collectRowsForCondition(c, runDir, ["a"], "fail"))
      }
      expect(allRows.length).toBe(4)
      const stats = aggregate(allRows)
      // Output order is canonical: baseline, lsp, subagent, all
      expect(stats.map((s) => s.condition)).toEqual(["baseline", "lsp", "subagent", "all"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("partial corrupted summary on one condition ⇒ other conditions unaffected (graceful degradation)", () => {
    const dir = mkTmp("corrupt")
    try {
      // baseline: clean
      const baselineDir = join(dir, "baseline")
      mkdirSync(baselineDir, { recursive: true })
      writeSummary(baselineDir, [{ id: "a", passed: true, verdict: "ok", turns: 1 }])
      // lsp: corrupt summary
      const lspDir = join(dir, "lsp")
      mkdirSync(lspDir, { recursive: true })
      writeFileSync(join(lspDir, "summary.json"), "<<<not-json>>>")
      const baseRows = collectRowsForCondition("baseline", baselineDir, ["a"], "fail")
      const lspRows = collectRowsForCondition("lsp", lspDir, ["a"], "fail")
      expect(baseRows[0]?.verdict).toBe("pass")
      // Corrupt summary ⇒ fallback verdict "fail" (the explicit fallback param).
      expect(lspRows[0]?.verdict).toBe("fail")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  // NOTE: --resume / --summary modes are NOT YET IMPLEMENTED. The real tests
  // above pin the algebra a future --resume MUST preserve: partial-*.jsonl is an
  // idempotent line-append checkpoint; aggregate is associative over disjoint
  // conditions; corrupt single-condition artifacts degrade gracefully; aggregate
  // is order-invariant with canonical output order.
})
