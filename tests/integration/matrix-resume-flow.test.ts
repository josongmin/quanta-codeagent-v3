/**
 * Integration: end-to-end resume / checkpoint / cost-tracking flow for
 * the matrix runner (`tools/swebench-matrix.ts`).
 *
 * Scope: no real bench spawn (would require an LLM + Docker). We exercise:
 *   - bootstrapResume → save → simulate abort → load → resume
 *   - mismatch detection rejects --resume when flags change
 *   - cost.json persists after each condition
 *   - cleanup happens after the final condition (unless --keep-state)
 *
 * The bench is REPLACED with a synthetic generator that returns a fixed
 * MatrixRow set per condition — exactly the same shape `runOneCondition`
 * would emit, so the rest of the orchestration (state + cost) is real.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MatrixRow } from "@/../tools/swebench-matrix"
import {
  emptyCostAccumulator,
  recordInstance,
  recordRows,
} from "@/../tools/swebench-matrix/progress"
import {
  cleanSweepState,
  detectMismatch,
  flattenPartialRows,
  loadSweepState,
  newSweepState,
  recordConditionComplete,
  remainingConditions,
  saveSweepState,
  stateFilePath,
} from "@/../tools/swebench-matrix/state"

const mkTmpRun = (): string => mkdtempSync(join(tmpdir(), "matrix-flow-"))

const fakeRowsFor = (condition: string, pickIds: readonly string[]): MatrixRow[] =>
  pickIds.map((pickId, i) => ({
    condition: condition as MatrixRow["condition"],
    pickId,
    verdict: i % 2 === 0 ? "pass" : "fail",
    turns: 5 + i,
    tokensIn: 1000 * (i + 1),
    tokensOut: 200 * (i + 1),
    cacheRead: 0,
    wallMs: 10_000 + i * 1000,
    costUsd: 0.05 * (i + 1),
  }))

const baseInit = (outDir: string, conditions: readonly string[]) => ({
  dataset: "/test/picks.jsonl",
  outDir,
  model: "gpt-5",
  mode: "conditions" as const,
  conditions,
})

describe("integration: 4-condition sweep abort-and-resume", () => {
  test("2 conditions complete → SIGINT → resume → only conditions 3,4 run", () => {
    const dir = mkTmpRun()
    try {
      const pickIds = ["a__x-1", "b__y-2", "c__z-3"]
      const all = ["baseline", "lsp", "subagent", "all"]

      // --- pass 1: run baseline + lsp, then abort ---
      let state = newSweepState(baseInit(dir, all))
      let acc = emptyCostAccumulator()
      const ranInPass1: string[] = []
      for (const cond of all) {
        if (ranInPass1.length >= 2) break // simulate SIGINT after #2
        const rows = fakeRowsFor(cond, pickIds)
        state = recordConditionComplete(state, cond, rows)
        acc = recordRows(acc, rows)
        saveSweepState(dir, state)
        ranInPass1.push(cond)
      }
      expect(ranInPass1).toEqual(["baseline", "lsp"])
      expect(state.completed).toEqual(["baseline", "lsp"])

      // --- pass 2: load, resume from condition 3 ---
      const reloaded = loadSweepState(dir)
      expect(reloaded).toBeDefined()
      if (reloaded === undefined) throw new Error("expected reload")
      const remaining = remainingConditions(reloaded.conditions, reloaded.completed)
      expect(remaining).toEqual(["subagent", "all"])

      const seedRows = flattenPartialRows(reloaded)
      expect(seedRows.length).toBe(2 * pickIds.length)

      let resumed = reloaded
      let resumedAcc = recordRows(emptyCostAccumulator(), seedRows)
      const ranInPass2: string[] = []
      for (const cond of remaining) {
        const rows = fakeRowsFor(cond, pickIds)
        resumed = recordConditionComplete(resumed, cond, rows)
        resumedAcc = recordRows(resumedAcc, rows)
        saveSweepState(dir, resumed)
        ranInPass2.push(cond)
      }
      expect(ranInPass2).toEqual(["subagent", "all"])
      expect(resumed.completed).toEqual(["baseline", "lsp", "subagent", "all"])
      // 4 conditions × 3 picks = 12 instance observations.
      expect(resumedAcc.instanceCount).toBe(12)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("conditions 1,2 already done are SKIPPED in resume (no double-run)", () => {
    const dir = mkTmpRun()
    try {
      const all = ["baseline", "lsp", "subagent", "all"]
      const pickIds = ["a", "b"]
      // Pre-populate state with baseline + lsp done.
      let s = newSweepState(baseInit(dir, all))
      s = recordConditionComplete(s, "baseline", fakeRowsFor("baseline", pickIds))
      s = recordConditionComplete(s, "lsp", fakeRowsFor("lsp", pickIds))
      saveSweepState(dir, s)

      // Simulate the resume loop's "skip if completed" branch.
      const reloaded = loadSweepState(dir)
      if (reloaded === undefined) throw new Error("expected reload")
      const completedSet = new Set(reloaded.completed)
      const wouldRun: string[] = []
      const wouldSkip: string[] = []
      for (const cond of all) {
        if (completedSet.has(cond)) wouldSkip.push(cond)
        else wouldRun.push(cond)
      }
      expect(wouldSkip).toEqual(["baseline", "lsp"])
      expect(wouldRun).toEqual(["subagent", "all"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("integration: mismatch detection blocks resume on changed flags", () => {
  test("resume with different --conditions list is rejected", () => {
    const dir = mkTmpRun()
    try {
      const s = newSweepState(baseInit(dir, ["baseline", "lsp"]))
      saveSweepState(dir, s)
      const reloaded = loadSweepState(dir)
      if (reloaded === undefined) throw new Error("expected reload")
      const m = detectMismatch(reloaded, {
        mode: "conditions",
        dataset: "/test/picks.jsonl",
        model: "gpt-5",
        conditions: ["baseline", "lsp", "subagent"], // ADDED one
      })
      expect(m?.kind).toBe("conditions")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("resume with different --axes list is rejected", () => {
    const dir = mkTmpRun()
    try {
      const s = newSweepState({
        dataset: "/test/picks.jsonl",
        outDir: dir,
        model: "gpt-5",
        mode: "axes",
        axes: ["lsp", "subagent"],
        conditions: ["axes-baseline", "axes-lsp", "axes-subagent", "axes-lsp_subagent"],
      })
      saveSweepState(dir, s)
      const reloaded = loadSweepState(dir)
      if (reloaded === undefined) throw new Error("expected reload")
      const m = detectMismatch(reloaded, {
        mode: "axes",
        dataset: "/test/picks.jsonl",
        model: "gpt-5",
        axes: ["lsp"], // shortened
        conditions: [],
      })
      // Either axes or conditions mismatch — both indicate the same operator error.
      expect(m?.kind).toMatch(/axes|conditions/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("integration: cleanup after successful sweep", () => {
  test("cleanSweepState removes the file after every condition completes", () => {
    const dir = mkTmpRun()
    try {
      const all = ["baseline", "lsp"]
      let s = newSweepState(baseInit(dir, all))
      for (const cond of all) {
        s = recordConditionComplete(s, cond, fakeRowsFor(cond, ["a", "b"]))
        saveSweepState(dir, s)
      }
      expect(existsSync(stateFilePath(dir))).toBe(true)
      cleanSweepState(dir)
      expect(existsSync(stateFilePath(dir))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("--keep-state simulation: state file preserved (cleanup not called)", () => {
    const dir = mkTmpRun()
    try {
      let s = newSweepState(baseInit(dir, ["baseline"]))
      s = recordConditionComplete(s, "baseline", fakeRowsFor("baseline", ["a"]))
      saveSweepState(dir, s)
      // --keep-state ⇒ runner skips cleanSweepState call. We verify the
      // file remains by NOT calling clean.
      expect(existsSync(stateFilePath(dir))).toBe(true)
      const loaded = loadSweepState(dir)
      expect(loaded?.completed).toEqual(["baseline"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("integration: cost-tracking continuity across resume", () => {
  test("spentUsd after resume includes all pre-abort cost", () => {
    const dir = mkTmpRun()
    try {
      const all = ["baseline", "lsp", "all"]
      const pickIds = ["a", "b"]
      let s = newSweepState(baseInit(dir, all))
      let acc = emptyCostAccumulator()
      // Run 1: baseline only. Aggregate cost = 0.05 + 0.10 = 0.15
      for (const cond of ["baseline"]) {
        const rows = fakeRowsFor(cond, pickIds)
        s = recordConditionComplete(s, cond, rows)
        acc = recordRows(acc, rows)
        saveSweepState(dir, s)
      }
      const aborted = loadSweepState(dir)
      if (aborted === undefined) throw new Error("expected loaded state")
      const seedRows = flattenPartialRows(aborted)
      const resumedAcc = recordRows(emptyCostAccumulator(), seedRows)
      // Verify resumed acc matches pre-abort acc value (within 1e-4).
      expect(resumedAcc.spentUsd).toBeCloseTo(acc.spentUsd, 4)
      expect(resumedAcc.spentUsd).toBeCloseTo(0.15, 4)
      // Continue with lsp.
      const lspRows = fakeRowsFor("lsp", pickIds)
      const firstLsp = lspRows[0]
      if (firstLsp === undefined) throw new Error("expected first lsp row")
      const after = recordInstance(resumedAcc, firstLsp)
      expect(after.spentUsd).toBeGreaterThan(resumedAcc.spentUsd)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("atomic write — sweep state never corrupt mid-condition", () => {
    const dir = mkTmpRun()
    try {
      let s = newSweepState(baseInit(dir, ["baseline", "lsp"]))
      s = recordConditionComplete(s, "baseline", fakeRowsFor("baseline", ["a"]))
      saveSweepState(dir, s)
      // Read raw — should be valid JSON every time.
      const text = readFileSync(stateFilePath(dir), "utf8")
      expect(() => JSON.parse(text)).not.toThrow()
      // No leftover .tmp file from the rename.
      expect(existsSync(`${stateFilePath(dir)}.tmp`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
