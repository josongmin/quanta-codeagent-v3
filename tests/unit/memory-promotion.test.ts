/**
 * ADR-0131 Phase D — phase2 promotion gate tests.
 *
 * Contract under test (selectForPhase2Promotion):
 *   1. Score = (outcomeEvidence ? 2 : 0) + (preferenceSignals.length > 0 ? 1 : 0)
 *   2. outcome === 'fail' is excluded unconditionally
 *   3. Cap = floor(sampleRate * entries.length); rate defaults to 0.1
 *   4. Ordering: score DESC, then sourceUpdatedAt DESC tiebreak
 *   5. Deterministic: same input → same output
 *   6. Edge cases: empty input, sampleRate 0, sampleRate 1, invalid rate
 */

import { describe, expect, test } from "bun:test"
import { selectForPhase2Promotion } from "../../src/memory/consolidate"
import type { MemoryOutcome, Stage1Output } from "../../src/memory/consolidate/types"
import { nth } from "../_helpers/expect-present"

const mk = (over: Partial<Stage1Output>): Stage1Output => ({
  threadId: over.threadId ?? "thr-?",
  rolloutSlug: "slug",
  rolloutSummary: "summary",
  rawMemory: "raw",
  preferenceSignals: over.preferenceSignals ?? [],
  sourceUpdatedAt: over.sourceUpdatedAt ?? 1_000_000,
  selectedForPhase2: false,
  selectedForPhase2SourceUpdatedAt: null,
  lastUsage: null,
  usageCount: 0,
  ...over,
})

describe("ADR-0131 — selectForPhase2Promotion: 10% default sample rate", () => {
  test("100 entries → exactly 10 selected by default (matches Codex stat)", () => {
    const entries: Stage1Output[] = []
    for (let i = 0; i < 100; i++) {
      entries.push(
        mk({
          threadId: `thr-${i}`,
          // Half have evidence, all have preference signals → score variance.
          ...(i % 2 === 0 ? { outcomeEvidence: "src/x.ts:1" } : {}),
          preferenceSignals: ["p"],
          sourceUpdatedAt: i * 1000,
          outcome: "partial",
        }),
      )
    }
    const out = selectForPhase2Promotion(entries)
    expect(out).toHaveLength(10)
  })

  test("9 entries with default rate → 0 selected (floor(0.9) = 0)", () => {
    const entries: Stage1Output[] = []
    for (let i = 0; i < 9; i++) {
      entries.push(mk({ threadId: `thr-${i}`, preferenceSignals: ["p"] }))
    }
    expect(selectForPhase2Promotion(entries)).toHaveLength(0)
  })

  test("10 entries with default rate → exactly 1 selected", () => {
    const entries: Stage1Output[] = []
    for (let i = 0; i < 10; i++) {
      entries.push(mk({ threadId: `thr-${i}` }))
    }
    expect(selectForPhase2Promotion(entries)).toHaveLength(1)
  })
})

describe("ADR-0131 — selectForPhase2Promotion: score ranking", () => {
  test("score 3 (evidence + prefs) beats score 1 (prefs only)", () => {
    const entries: Stage1Output[] = [
      mk({ threadId: "thr-low", preferenceSignals: ["p"] }),
      mk({
        threadId: "thr-high",
        outcomeEvidence: "src/x.ts:1",
        preferenceSignals: ["p"],
      }),
    ]
    const out = selectForPhase2Promotion(entries, { sampleRate: 0.5 })
    expect(out).toHaveLength(1)
    expect(nth(out, 0, "out").threadId).toBe("thr-high")
  })

  test("score 2 (evidence only) beats score 1 (prefs only)", () => {
    const entries: Stage1Output[] = [
      mk({ threadId: "thr-prefs", preferenceSignals: ["p"] }),
      mk({ threadId: "thr-evid", outcomeEvidence: "src/x.ts:1" }),
    ]
    const out = selectForPhase2Promotion(entries, { sampleRate: 0.5 })
    expect(out).toHaveLength(1)
    expect(nth(out, 0, "out").threadId).toBe("thr-evid")
  })

  test("score 0 entries are still eligible but rank last", () => {
    const entries: Stage1Output[] = [
      mk({ threadId: "thr-zero-a", sourceUpdatedAt: 100 }),
      mk({ threadId: "thr-zero-b", sourceUpdatedAt: 200 }),
      mk({ threadId: "thr-one", preferenceSignals: ["p"], sourceUpdatedAt: 50 }),
    ]
    const out = selectForPhase2Promotion(entries, { sampleRate: 1 })
    expect(out).toHaveLength(3)
    expect(nth(out, 0, "out").threadId).toBe("thr-one") // score 1
    // Within score=0, sourceUpdatedAt DESC (200 before 100)
    expect(nth(out, 1, "out").threadId).toBe("thr-zero-b")
    expect(nth(out, 2, "out").threadId).toBe("thr-zero-a")
  })

  test("tiebreak: same score → younger sourceUpdatedAt first", () => {
    const entries: Stage1Output[] = [
      mk({ threadId: "thr-older", preferenceSignals: ["p"], sourceUpdatedAt: 100 }),
      mk({ threadId: "thr-newer", preferenceSignals: ["p"], sourceUpdatedAt: 200 }),
    ]
    const out = selectForPhase2Promotion(entries, { sampleRate: 0.5 })
    expect(out).toHaveLength(1)
    expect(nth(out, 0, "out").threadId).toBe("thr-newer")
  })

  test("empty outcomeEvidence string scores 0 for evidence (must be non-empty)", () => {
    const entries: Stage1Output[] = [
      mk({ threadId: "thr-empty-ev", outcomeEvidence: "", preferenceSignals: ["p"] }),
      mk({ threadId: "thr-real-ev", outcomeEvidence: "x", preferenceSignals: ["p"] }),
    ]
    const out = selectForPhase2Promotion(entries, { sampleRate: 0.5 })
    expect(out).toHaveLength(1)
    expect(nth(out, 0, "out").threadId).toBe("thr-real-ev")
  })
})

describe("ADR-0131 — selectForPhase2Promotion: 'fail' exclusion", () => {
  test("outcome='fail' with score 3 still excluded", () => {
    const entries: Stage1Output[] = [
      mk({
        threadId: "thr-best-fail",
        outcome: "fail",
        outcomeEvidence: "src/x.ts:1",
        preferenceSignals: ["p"],
      }),
      mk({ threadId: "thr-zero", outcome: "partial" }),
    ]
    const out = selectForPhase2Promotion(entries, { sampleRate: 1 })
    expect(out.map((e) => e.threadId)).toEqual(["thr-zero"])
  })

  test("undefined outcome is NOT 'fail' → entry remains eligible", () => {
    const entries: Stage1Output[] = [
      mk({ threadId: "thr-noout", preferenceSignals: ["p"] }), // no outcome field
    ]
    const out = selectForPhase2Promotion(entries, { sampleRate: 1 })
    expect(out).toHaveLength(1)
    expect(nth(out, 0, "out").threadId).toBe("thr-noout")
  })

  test("mix of all 4 outcomes — only 'fail' is excluded", () => {
    const outs: MemoryOutcome[] = ["partial", "success", "uncertain", "fail"]
    const entries = outs.map((oc, i) =>
      mk({
        threadId: `thr-${oc}`,
        outcome: oc,
        sourceUpdatedAt: 1000 * (4 - i),
      }),
    )
    const out = selectForPhase2Promotion(entries, { sampleRate: 1 })
    const ids = out.map((e) => e.threadId)
    expect(ids).not.toContain("thr-fail")
    expect(ids).toContain("thr-partial")
    expect(ids).toContain("thr-success")
    expect(ids).toContain("thr-uncertain")
  })
})

describe("ADR-0131 — selectForPhase2Promotion: determinism", () => {
  test("same input shuffled order → same output (sort is stable across runs)", () => {
    const entries: Stage1Output[] = [
      mk({
        threadId: "thr-a",
        outcomeEvidence: "src/a.ts:1",
        preferenceSignals: ["p"],
        sourceUpdatedAt: 100,
      }),
      mk({
        threadId: "thr-b",
        outcomeEvidence: "src/b.ts:1",
        preferenceSignals: ["p"],
        sourceUpdatedAt: 200,
      }),
      mk({
        threadId: "thr-c",
        outcomeEvidence: "src/c.ts:1",
        preferenceSignals: ["p"],
        sourceUpdatedAt: 300,
      }),
    ]
    const a = selectForPhase2Promotion(entries, { sampleRate: 1 }).map((e) => e.threadId)
    const b = selectForPhase2Promotion(entries, { sampleRate: 1 }).map((e) => e.threadId)
    expect(a).toEqual(b)
    expect(a).toEqual(["thr-c", "thr-b", "thr-a"])
  })

  test("calling selectForPhase2Promotion does NOT mutate input array", () => {
    const entries: Stage1Output[] = [
      mk({ threadId: "thr-x", preferenceSignals: ["p"], sourceUpdatedAt: 100 }),
      mk({ threadId: "thr-y", preferenceSignals: ["p"], sourceUpdatedAt: 200 }),
    ]
    const snapshot = entries.map((e) => e.threadId)
    selectForPhase2Promotion(entries, { sampleRate: 1 })
    expect(entries.map((e) => e.threadId)).toEqual(snapshot)
  })
})

describe("ADR-0131 — selectForPhase2Promotion: rate edge cases", () => {
  test("sampleRate=0 → empty result", () => {
    const entries = Array.from({ length: 100 }, (_, i) =>
      mk({ threadId: `t-${i}`, preferenceSignals: ["p"] }),
    )
    expect(selectForPhase2Promotion(entries, { sampleRate: 0 })).toEqual([])
  })

  test("sampleRate=1 → all eligible entries returned", () => {
    const entries = [
      mk({ threadId: "t-1", outcome: "partial" }),
      mk({ threadId: "t-2", outcome: "fail" }),
      mk({ threadId: "t-3", outcome: "success" }),
    ]
    const out = selectForPhase2Promotion(entries, { sampleRate: 1 })
    const ids = out.map((e) => e.threadId).sort()
    // Cap = floor(1 * 3) = 3; eligible after exclusion = 2; result clipped to 2.
    expect(ids).toEqual(["t-1", "t-3"])
  })

  test("empty input → empty output", () => {
    expect(selectForPhase2Promotion([])).toEqual([])
  })

  test("invalid sampleRate (negative) → falls back to default 0.1", () => {
    const entries = Array.from({ length: 100 }, (_, i) =>
      mk({ threadId: `t-${i}`, preferenceSignals: ["p"] }),
    )
    expect(selectForPhase2Promotion(entries, { sampleRate: -1 })).toHaveLength(10)
  })

  test("invalid sampleRate (>1) → falls back to default 0.1", () => {
    const entries = Array.from({ length: 100 }, (_, i) =>
      mk({ threadId: `t-${i}`, preferenceSignals: ["p"] }),
    )
    expect(selectForPhase2Promotion(entries, { sampleRate: 5 })).toHaveLength(10)
  })

  test("invalid sampleRate (NaN) → falls back to default 0.1", () => {
    const entries = Array.from({ length: 100 }, (_, i) =>
      mk({ threadId: `t-${i}`, preferenceSignals: ["p"] }),
    )
    expect(selectForPhase2Promotion(entries, { sampleRate: Number.NaN })).toHaveLength(10)
  })

  test("returned array is a fresh copy (mutation does not leak)", () => {
    const entries = [mk({ threadId: "t-1", preferenceSignals: ["p"] }), mk({ threadId: "t-2" })]
    const out = selectForPhase2Promotion(entries, { sampleRate: 1 })
    out.pop()
    // Calling again should still return both entries (we didn't mutate state).
    expect(selectForPhase2Promotion(entries, { sampleRate: 1 })).toHaveLength(2)
  })
})
