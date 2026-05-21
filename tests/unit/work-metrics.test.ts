import { describe, expect, test } from "bun:test"
import { workMetricsAttrs } from "@/observability/attrs"
import { QUANTA_ATTRS } from "@/observability/vocabulary"
import {
  accumulateWorkMetrics,
  buildWorkMetrics,
  type FileDiffStat,
  parseNumstat,
  summarizeWorkMetrics,
  type WorkMetrics,
} from "@/observability/work-metrics"

describe("parseNumstat", () => {
  test("parses added/removed/path rows", () => {
    const out = parseNumstat("12\t3\tsrc/a.ts\n0\t5\tsrc/b.ts\n")
    expect(out).toEqual([
      { file: "src/a.ts", addedLines: 12, removedLines: 3 },
      { file: "src/b.ts", addedLines: 0, removedLines: 5 },
    ])
  })

  test("binary files (`-`) collapse to 0/0", () => {
    const out = parseNumstat("-\t-\tassets/logo.png\n")
    expect(out).toEqual([{ file: "assets/logo.png", addedLines: 0, removedLines: 0 }])
  })

  test("skips blank and malformed rows", () => {
    const out = parseNumstat("\n10\t2\tok.ts\ngarbage line\n\n")
    expect(out).toEqual([{ file: "ok.ts", addedLines: 10, removedLines: 2 }])
  })

  test("preserves paths containing spaces", () => {
    const out = parseNumstat("1\t1\tdir/file with space.ts\n")
    expect(out[0]?.file).toBe("dir/file with space.ts")
  })

  test("empty input → empty list", () => {
    expect(parseNumstat("")).toEqual([])
  })
})

describe("summarizeWorkMetrics", () => {
  const base: WorkMetrics = {
    diffMap: [
      { file: "a.ts", addedLines: 40, removedLines: 5 },
      { file: "b.ts", addedLines: 2, removedLines: 2 },
      { file: "c.ts", addedLines: 0, removedLines: 0 },
    ],
    agentActions: 5,
    linesRead: 312,
    tokensInput: 1200,
    tokensOutput: 800,
    estimatedCostUsd: 0.03,
  }

  test("compact one-block summary with cost", () => {
    expect(summarizeWorkMetrics(base)).toBe(
      "3 files (+42 -7) · 5 actions · 312 lines read · 1.2k in / 0.8k out · ~$0.03",
    )
  })

  test("omits cost segment when undefined", () => {
    const noCost: WorkMetrics = { ...base, estimatedCostUsd: undefined }
    const s = summarizeWorkMetrics(noCost)
    expect(s).not.toContain("$")
    expect(s.endsWith("1.2k in / 0.8k out")).toBe(true)
  })

  test("singular file/action wording", () => {
    const one: WorkMetrics = {
      diffMap: [{ file: "x.ts", addedLines: 1, removedLines: 0 }],
      agentActions: 1,
      linesRead: 0,
      tokensInput: 10,
      tokensOutput: 20,
    }
    const s = summarizeWorkMetrics(one)
    expect(s).toContain("1 file (+1 -0)")
    expect(s).toContain("1 action")
  })
})

describe("accumulateWorkMetrics", () => {
  const turn1: WorkMetrics = {
    diffMap: [{ file: "a.ts", addedLines: 10, removedLines: 1 }],
    agentActions: 2,
    linesRead: 50,
    tokensInput: 100,
    tokensOutput: 40,
    cacheReadTokens: 5,
    estimatedCostUsd: 0.01,
  }
  const turn2: WorkMetrics = {
    diffMap: [
      { file: "a.ts", addedLines: 3, removedLines: 2 },
      { file: "b.ts", addedLines: 7, removedLines: 0 },
    ],
    agentActions: 1,
    linesRead: 20,
    tokensInput: 60,
    tokensOutput: 30,
    cacheReadTokens: 10,
    estimatedCostUsd: 0.02,
  }

  test("folds scalars and sums per-file diffs by path", () => {
    const out = accumulateWorkMetrics(turn1, turn2)
    expect(out.agentActions).toBe(3)
    expect(out.linesRead).toBe(70)
    expect(out.tokensInput).toBe(160)
    expect(out.tokensOutput).toBe(70)
    expect(out.cacheReadTokens).toBe(15)
    expect(out.estimatedCostUsd).toBeCloseTo(0.03, 10)
    const a = out.diffMap.find((d) => d.file === "a.ts")
    const b = out.diffMap.find((d) => d.file === "b.ts")
    expect(a).toEqual({ file: "a.ts", addedLines: 13, removedLines: 3 })
    expect(b).toEqual({ file: "b.ts", addedLines: 7, removedLines: 0 })
  })

  test("is pure — inputs are not mutated", () => {
    const t1Copy = structuredClone(turn1)
    const t2Copy = structuredClone(turn2)
    accumulateWorkMetrics(turn1, turn2)
    expect(turn1).toEqual(t1Copy)
    expect(turn2).toEqual(t2Copy)
  })

  test("leaves optionals undefined when neither side has them", () => {
    const bare: WorkMetrics = {
      diffMap: [],
      agentActions: 0,
      linesRead: 0,
      tokensInput: 0,
      tokensOutput: 0,
    }
    const out = accumulateWorkMetrics(bare, bare)
    expect(out.cacheReadTokens).toBeUndefined()
    expect(out.estimatedCostUsd).toBeUndefined()
  })
})

describe("buildWorkMetrics", () => {
  test("derives cost for a known model", () => {
    const m = buildWorkMetrics({
      diffMap: [],
      agentActions: 1,
      linesRead: 0,
      model: "claude-opus-4-7",
      tokensInput: 1_000_000,
      tokensOutput: 0,
    })
    expect(m.estimatedCostUsd).toBe(15)
  })

  test("leaves cost undefined for an unknown model", () => {
    const m = buildWorkMetrics({
      diffMap: [],
      agentActions: 1,
      linesRead: 0,
      model: "mystery-model",
      tokensInput: 100,
      tokensOutput: 100,
    })
    expect(m.estimatedCostUsd).toBeUndefined()
  })
})

describe("workMetricsAttrs", () => {
  test("builds valid attrs with canonical work.* keys", () => {
    const diffMap: FileDiffStat[] = [
      { file: "a.ts", addedLines: 10, removedLines: 2 },
      { file: "b.ts", addedLines: 5, removedLines: 0 },
    ]
    const a = workMetricsAttrs({
      filesChanged: diffMap.length,
      linesAdded: 15,
      linesRemoved: 2,
      actions: 4,
      linesRead: 99,
      costUsd: 0.05,
    })
    expect(a[QUANTA_ATTRS.work.filesChanged]).toBe(2)
    expect(a[QUANTA_ATTRS.work.linesAdded]).toBe(15)
    expect(a[QUANTA_ATTRS.work.linesRemoved]).toBe(2)
    expect(a[QUANTA_ATTRS.work.actions]).toBe(4)
    expect(a[QUANTA_ATTRS.work.linesRead]).toBe(99)
    expect(a[QUANTA_ATTRS.work.costUsd]).toBe(0.05)
  })

  test("omits costUsd when undefined", () => {
    const a = workMetricsAttrs({
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      actions: 0,
      linesRead: 0,
    })
    expect(QUANTA_ATTRS.work.costUsd in a).toBe(false)
  })
})
