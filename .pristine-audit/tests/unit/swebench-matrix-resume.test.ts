/**
 * Unit tests for `tools/swebench-matrix/state.ts`.
 *
 * Scope: pure load/save/clean state file behavior + structural validation
 * + mismatch detection + atomic-write semantics. The matrix tool itself
 * is exercised end-to-end in `tests/integration/matrix-resume-flow.test.ts`.
 */
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MatrixRow } from "@/../tools/swebench-matrix"
import {
  cleanSweepState,
  detectMismatch,
  flattenPartialRows,
  formatMismatch,
  loadSweepState,
  newSweepState,
  recordConditionComplete,
  remainingConditions,
  STATE_FILE,
  STATE_VERSION,
  type SweepState,
  saveSweepState,
  stateFilePath,
} from "@/../tools/swebench-matrix/state"

const mkTmp = (label: string): string => mkdtempSync(join(tmpdir(), `matrix-state-${label}-`))

const mkRow = (over: Partial<MatrixRow> = {}): MatrixRow => ({
  condition: "baseline",
  pickId: "p__q-1",
  verdict: "pass",
  turns: 5,
  tokensIn: 100,
  tokensOut: 20,
  cacheRead: 0,
  wallMs: 5000,
  costUsd: 0.0123,
  ...over,
})

const baseInit = (outDir: string) =>
  ({
    dataset: "/d/picks.jsonl",
    outDir,
    model: "gpt-5",
    mode: "conditions" as const,
    conditions: ["baseline", "lsp", "subagent"],
    now: () => 1_700_000_000_000,
  }) as const

describe("STATE_VERSION + STATE_FILE constants", () => {
  test("file name is '.matrix-state.json' (hidden, single source of truth)", () => {
    expect(STATE_FILE).toBe(".matrix-state.json")
  })
  test("version is 1 (initial schema)", () => {
    expect(STATE_VERSION).toBe(1)
  })
  test("stateFilePath joins outDir + STATE_FILE", () => {
    expect(stateFilePath("/tmp/foo")).toBe("/tmp/foo/.matrix-state.json")
  })
})

describe("newSweepState", () => {
  test("freshly minted state has empty completed + zero spent", () => {
    const dir = mkTmp("new")
    try {
      const s = newSweepState(baseInit(dir))
      expect(s.version).toBe(STATE_VERSION)
      expect(s.completed).toEqual([])
      expect(s.partialResults).toEqual({})
      expect(s.spentUsd).toBe(0)
      expect(s.startedAt).toBe(1_700_000_000_000)
      expect(s.conditions).toEqual(["baseline", "lsp", "subagent"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("axes-mode includes axes; legacy excludes them", () => {
    const dir = mkTmp("axes")
    try {
      const legacy = newSweepState(baseInit(dir))
      expect(legacy.axes).toBeUndefined()
      const axes = newSweepState({ ...baseInit(dir), mode: "axes", axes: ["lsp", "subagent"] })
      expect(axes.axes).toEqual(["lsp", "subagent"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("totalEstCostUsd preserved when provided", () => {
    const dir = mkTmp("estcost")
    try {
      const s = newSweepState({ ...baseInit(dir), totalEstCostUsd: 12.5 })
      expect(s.totalEstCostUsd).toBe(12.5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("saveSweepState / loadSweepState round-trip", () => {
  test("save then load returns equivalent SweepState", () => {
    const dir = mkTmp("rt")
    try {
      const original = newSweepState(baseInit(dir))
      saveSweepState(dir, original)
      const loaded = loadSweepState(dir)
      expect(loaded).toBeDefined()
      if (loaded === undefined) throw new Error("loaded must be defined")
      expect(loaded.startedAt).toBe(original.startedAt)
      expect(loaded.dataset).toBe(original.dataset)
      expect(loaded.conditions).toEqual(original.conditions)
      expect(loaded.completed).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("save uses atomic write — no .tmp file lingers after success", () => {
    const dir = mkTmp("atomic")
    try {
      saveSweepState(dir, newSweepState(baseInit(dir)))
      expect(existsSync(stateFilePath(dir))).toBe(true)
      expect(existsSync(`${stateFilePath(dir)}.tmp`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("save persists partialResults with full MatrixRow shape", () => {
    const dir = mkTmp("partial")
    try {
      const s = newSweepState(baseInit(dir))
      const rows: MatrixRow[] = [
        mkRow({ condition: "baseline", pickId: "a", costUsd: 0.5 }),
        mkRow({ condition: "baseline", pickId: "b", verdict: "fail", costUsd: 0.4 }),
      ]
      const next = recordConditionComplete(s, "baseline", rows)
      saveSweepState(dir, next)
      const loaded = loadSweepState(dir)
      if (loaded === undefined) throw new Error("expected loaded state")
      expect(loaded.completed).toEqual(["baseline"])
      expect(loaded.partialResults.baseline?.length).toBe(2)
      expect(loaded.partialResults.baseline?.[0]?.pickId).toBe("a")
      expect(loaded.spentUsd).toBeCloseTo(0.9, 4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("loadSweepState — error paths", () => {
  test("file does not exist → undefined", () => {
    const dir = mkTmp("noent")
    try {
      expect(loadSweepState(dir)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("corrupt JSON → undefined (NOT throw)", () => {
    const dir = mkTmp("corrupt")
    try {
      writeFileSync(stateFilePath(dir), "not valid json {[")
      expect(loadSweepState(dir)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("malformed shape (missing fields) → undefined", () => {
    const dir = mkTmp("shape")
    try {
      writeFileSync(stateFilePath(dir), JSON.stringify({ version: 1, foo: "bar" }))
      expect(loadSweepState(dir)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("wrong version → undefined (forward-compat reject)", () => {
    const dir = mkTmp("ver")
    try {
      const s = newSweepState(baseInit(dir))
      saveSweepState(dir, s)
      // Tamper with the version field.
      const text = readFileSync(stateFilePath(dir), "utf8")
      const obj = JSON.parse(text)
      obj.version = 999
      writeFileSync(stateFilePath(dir), JSON.stringify(obj))
      expect(loadSweepState(dir)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("invalid mode value → undefined", () => {
    const dir = mkTmp("mode")
    try {
      const s = newSweepState(baseInit(dir))
      saveSweepState(dir, s)
      const text = readFileSync(stateFilePath(dir), "utf8")
      const obj = JSON.parse(text)
      obj.mode = "neither-conditions-nor-axes"
      writeFileSync(stateFilePath(dir), JSON.stringify(obj))
      expect(loadSweepState(dir)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("malformed partialResults (non-array value) → undefined", () => {
    const dir = mkTmp("partialbad")
    try {
      const s = newSweepState(baseInit(dir))
      saveSweepState(dir, s)
      const obj = JSON.parse(readFileSync(stateFilePath(dir), "utf8"))
      obj.partialResults = { baseline: "not-an-array" }
      writeFileSync(stateFilePath(dir), JSON.stringify(obj))
      expect(loadSweepState(dir)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("cleanSweepState", () => {
  test("removes the state file when it exists", () => {
    const dir = mkTmp("clean")
    try {
      saveSweepState(dir, newSweepState(baseInit(dir)))
      expect(existsSync(stateFilePath(dir))).toBe(true)
      cleanSweepState(dir)
      expect(existsSync(stateFilePath(dir))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("safe to call when no state file exists (idempotent)", () => {
    const dir = mkTmp("cleanempty")
    try {
      expect(() => cleanSweepState(dir)).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("also sweeps orphaned .tmp from a crashed write", () => {
    const dir = mkTmp("cleantmp")
    try {
      writeFileSync(`${stateFilePath(dir)}.tmp`, "{}")
      saveSweepState(dir, newSweepState(baseInit(dir)))
      // saveSweepState's atomic rename should consume the tmp; create a NEW
      // orphan to simulate a half-failed write.
      writeFileSync(`${stateFilePath(dir)}.tmp`, "{}")
      cleanSweepState(dir)
      expect(existsSync(`${stateFilePath(dir)}.tmp`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("detectMismatch", () => {
  test("identical request returns undefined (compatible)", () => {
    const dir = mkTmp("match")
    try {
      const s = newSweepState(baseInit(dir))
      expect(
        detectMismatch(s, {
          mode: "conditions",
          dataset: "/d/picks.jsonl",
          model: "gpt-5",
          conditions: ["baseline", "lsp", "subagent"],
        }),
      ).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("mode mismatch reported (conditions → axes)", () => {
    const dir = mkTmp("mmm")
    try {
      const s = newSweepState(baseInit(dir))
      const m = detectMismatch(s, {
        mode: "axes",
        dataset: "/d/picks.jsonl",
        model: "gpt-5",
        conditions: ["baseline", "lsp", "subagent"],
      })
      expect(m?.kind).toBe("mode")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("dataset / model / conditions / axes mismatches each detected", () => {
    const dir = mkTmp("mmd")
    try {
      const s = newSweepState({ ...baseInit(dir), mode: "axes", axes: ["lsp"] })
      const d = detectMismatch(s, {
        mode: "axes",
        dataset: "/different/picks.jsonl",
        model: "gpt-5",
        axes: ["lsp"],
        conditions: ["baseline", "lsp", "subagent"],
      })
      expect(d?.kind).toBe("dataset")
      const model = detectMismatch(s, {
        mode: "axes",
        dataset: "/d/picks.jsonl",
        model: "gpt-4o",
        axes: ["lsp"],
        conditions: ["baseline", "lsp", "subagent"],
      })
      expect(model?.kind).toBe("model")
      const ax = detectMismatch(s, {
        mode: "axes",
        dataset: "/d/picks.jsonl",
        model: "gpt-5",
        axes: ["lsp", "subagent"],
        conditions: ["baseline", "lsp", "subagent"],
      })
      expect(ax?.kind).toBe("axes")
      const cond = detectMismatch(s, {
        mode: "axes",
        dataset: "/d/picks.jsonl",
        model: "gpt-5",
        axes: ["lsp"],
        conditions: ["all"],
      })
      expect(cond?.kind).toBe("conditions")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("formatMismatch produces operator-readable single-line message", () => {
    expect(formatMismatch({ kind: "mode", stored: "conditions", requested: "axes" })).toMatch(
      /mode mismatch.*conditions.*axes/,
    )
    expect(
      formatMismatch({ kind: "axes", stored: ["lsp"], requested: ["lsp", "subagent"] }),
    ).toMatch(/axes mismatch.*lsp.*subagent/)
  })
})

describe("recordConditionComplete + flattenPartialRows", () => {
  test("appends a NEW condition to completed + records rows", () => {
    const dir = mkTmp("rec")
    try {
      const s = newSweepState(baseInit(dir))
      const rows = [mkRow({ condition: "baseline", pickId: "a", costUsd: 0.1 })]
      const next = recordConditionComplete(s, "baseline", rows)
      expect(next.completed).toEqual(["baseline"])
      expect(next.partialResults.baseline).toEqual(rows)
      expect(next.spentUsd).toBeCloseTo(0.1, 4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("does NOT duplicate a condition already in completed (idempotent)", () => {
    const dir = mkTmp("recdup")
    try {
      const s = newSweepState(baseInit(dir))
      const first = recordConditionComplete(s, "baseline", [mkRow({ pickId: "a", costUsd: 0.1 })])
      const second = recordConditionComplete(first, "baseline", [
        mkRow({ pickId: "b", costUsd: 0.2 }),
      ])
      expect(second.completed).toEqual(["baseline"])
      // The newer rows overwrite the bucket (caller responsibility — we replay).
      expect(second.partialResults.baseline?.length).toBe(1)
      expect(second.partialResults.baseline?.[0]?.pickId).toBe("b")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("flattenPartialRows orders rows by `conditions` list order", () => {
    const dir = mkTmp("flat")
    try {
      const s = newSweepState(baseInit(dir))
      const withLsp = recordConditionComplete(s, "lsp", [mkRow({ condition: "lsp", pickId: "x" })])
      const withBaseline = recordConditionComplete(withLsp, "baseline", [
        mkRow({ condition: "baseline", pickId: "y" }),
      ])
      const flat = flattenPartialRows(withBaseline)
      // conditions order: baseline, lsp, subagent — baseline rows first.
      expect(flat[0]?.pickId).toBe("y")
      expect(flat[1]?.pickId).toBe("x")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("flattenPartialRows includes buckets not in conditions order (defensive)", () => {
    const dir = mkTmp("flatdef")
    try {
      const s = newSweepState(baseInit(dir))
      // Forge an out-of-order bucket (simulate axes-mode label not in conditions list).
      const tampered: SweepState = {
        ...s,
        partialResults: { "axes-lsp": [mkRow({ pickId: "z" })] },
      }
      const flat = flattenPartialRows(tampered)
      expect(flat.map((r) => r.pickId)).toEqual(["z"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("remainingConditions", () => {
  test("returns conditions not in completed (preserves order)", () => {
    expect(remainingConditions(["a", "b", "c", "d"], ["b", "d"])).toEqual(["a", "c"])
  })

  test("empty completed → returns all conditions", () => {
    expect(remainingConditions(["a", "b"], [])).toEqual(["a", "b"])
  })

  test("all completed → returns empty list", () => {
    expect(remainingConditions(["a"], ["a"])).toEqual([])
  })
})

describe("partial completion → resume from next condition", () => {
  test("scenario: 2/4 done, save → load → 2 remaining", () => {
    const dir = mkTmp("scenario")
    try {
      const fresh = newSweepState({
        ...baseInit(dir),
        conditions: ["baseline", "lsp", "subagent", "all"],
      })
      const after1 = recordConditionComplete(fresh, "baseline", [
        mkRow({ condition: "baseline", costUsd: 0.1 }),
      ])
      const after2 = recordConditionComplete(after1, "lsp", [
        mkRow({ condition: "lsp", costUsd: 0.2 }),
      ])
      saveSweepState(dir, after2)
      // Simulate a fresh process: load + compute remaining
      const reloaded = loadSweepState(dir)
      if (reloaded === undefined) throw new Error("expected reload")
      const remaining = remainingConditions(reloaded.conditions, reloaded.completed)
      expect(remaining).toEqual(["subagent", "all"])
      expect(reloaded.spentUsd).toBeCloseTo(0.3, 4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("unwritable directory does not crash atomic write callers", () => {
  test("read-only directory throws on save (caller decides recovery)", () => {
    const dir = mkTmp("ro")
    try {
      const s = newSweepState(baseInit(dir))
      // Make directory read-only — atomic write should fail loudly.
      chmodSync(dir, 0o500)
      expect(() => saveSweepState(dir, s)).toThrow()
    } finally {
      chmodSync(dir, 0o700)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
