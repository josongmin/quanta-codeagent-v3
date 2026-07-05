/**
 * static-owner SHADOW scorer HELLGATE (jul-6 S2, design P1).
 *
 * `scoreStaticOwnerShadow(providerOwners, successPatchTouchedFiles)` is the
 * PRE-INJECTION precision gate: it measures, OFFLINE and OBSERVE-ONLY, how well
 * the provider's owners match the files the actual success patch touched. NO
 * injection, NO model exposure — this is what decides whether static-owner is
 * even worth showing (design P1: "precision 낮으면 주입 자체를 안 함").
 *
 * HARD invariants:
 *   - PURE: (owners × gold-files) → score. Deterministic. No IO/env/llm.
 *   - precision = |predicted ∩ gold| / |predicted (distinct files)|
 *   - recall    = |predicted ∩ gold| / |gold (distinct files)|
 *   - handles empty predicted, empty gold, partial overlap, duplicates.
 *   - NO numeric confidence is consumed from owners (only file identity).
 *   - the gate value (threshold) is NOT baked in — the scorer REPORTS ratios;
 *     no arbitrary precision threshold lives here (no-heuristic).
 */
import { describe, expect, test } from "bun:test"
import type { OwnerHint } from "@/agent/observation/fragment"
import {
  type ShadowScore,
  scoreStaticOwnerShadow,
} from "@/agent/observation/providers/static-owner/shadow"

const owner = (file: string, strength: OwnerHint["strength"] = "high"): OwnerHint => ({
  file,
  strength,
  evidence: "def-use",
  source: "static-owner",
})

describe("scoreStaticOwnerShadow — arithmetic", () => {
  test("perfect match ⇒ precision 1, recall 1", () => {
    const s = scoreStaticOwnerShadow([owner("a.py"), owner("b.py")], ["a.py", "b.py"])
    expect(s.precision).toBe(1)
    expect(s.recall).toBe(1)
    expect(s.truePositives).toBe(2)
    expect(s.predictedCount).toBe(2)
    expect(s.goldCount).toBe(2)
  })

  test("partial overlap ⇒ fractional precision & recall", () => {
    // predicted {a,b,c}; gold {a,b,d} → TP {a,b}=2
    const s = scoreStaticOwnerShadow(
      [owner("a.py"), owner("b.py"), owner("c.py")],
      ["a.py", "b.py", "d.py"],
    )
    expect(s.truePositives).toBe(2)
    expect(s.precision).toBeCloseTo(2 / 3, 12)
    expect(s.recall).toBeCloseTo(2 / 3, 12)
  })

  test("disjoint ⇒ precision 0, recall 0", () => {
    const s = scoreStaticOwnerShadow([owner("x.py")], ["y.py"])
    expect(s.precision).toBe(0)
    expect(s.recall).toBe(0)
    expect(s.truePositives).toBe(0)
  })
})

describe("scoreStaticOwnerShadow — empty / degenerate handling", () => {
  test("empty predicted (no signal) ⇒ precision 0 (convention), recall 0", () => {
    const s = scoreStaticOwnerShadow([], ["a.py"])
    // No prediction to be right about → precision defined as 0 (nothing correct),
    // recall 0 (found none of gold). Must NOT be NaN.
    expect(s.precision).toBe(0)
    expect(s.recall).toBe(0)
    expect(Number.isNaN(s.precision)).toBe(false)
    expect(Number.isNaN(s.recall)).toBe(false)
    expect(s.predictedCount).toBe(0)
  })

  test("empty gold ⇒ recall 0 (nothing to recall), precision 0, no NaN", () => {
    const s = scoreStaticOwnerShadow([owner("a.py")], [])
    expect(s.recall).toBe(0)
    expect(s.precision).toBe(0)
    expect(Number.isNaN(s.precision)).toBe(false)
    expect(s.goldCount).toBe(0)
  })

  test("both empty ⇒ all zero, no NaN", () => {
    const s = scoreStaticOwnerShadow([], [])
    expect(s.precision).toBe(0)
    expect(s.recall).toBe(0)
    expect(s.truePositives).toBe(0)
    expect(s.predictedCount).toBe(0)
    expect(s.goldCount).toBe(0)
  })
})

describe("scoreStaticOwnerShadow — dedup + purity", () => {
  test("duplicate predicted files count once (distinct-file precision)", () => {
    // predicted a,a,b (dup a) vs gold a → TP=1, predictedCount(distinct)=2, recall=1
    const s = scoreStaticOwnerShadow([owner("a.py"), owner("a.py"), owner("b.py")], ["a.py"])
    expect(s.predictedCount).toBe(2)
    expect(s.truePositives).toBe(1)
    expect(s.precision).toBe(1 / 2)
    expect(s.recall).toBe(1)
  })

  test("duplicate gold files count once", () => {
    const s = scoreStaticOwnerShadow([owner("a.py")], ["a.py", "a.py"])
    expect(s.goldCount).toBe(1)
    expect(s.recall).toBe(1)
  })

  test("pure/deterministic — same inputs ⇒ identical score, inputs not mutated", () => {
    const owners = [owner("a.py"), owner("b.py")]
    const gold = ["a.py", "c.py"]
    const s1 = scoreStaticOwnerShadow(owners, gold)
    const s2 = scoreStaticOwnerShadow(owners, gold)
    expect(s1).toEqual(s2)
    // no mutation
    expect(owners.map((o) => o.file)).toEqual(["a.py", "b.py"])
    expect(gold).toEqual(["a.py", "c.py"])
  })

  test("owner STRENGTH does not affect the score (only file identity matters)", () => {
    const hi = scoreStaticOwnerShadow([owner("a.py", "high")], ["a.py"])
    const lo = scoreStaticOwnerShadow([owner("a.py", "low")], ["a.py"])
    expect(hi).toEqual(lo)
  })

  test("empty-string / whitespace file paths are ignored (not counted)", () => {
    const s = scoreStaticOwnerShadow([owner("a.py"), owner("")], ["a.py", "  "])
    expect(s.predictedCount).toBe(1)
    expect(s.goldCount).toBe(1)
    expect(s.precision).toBe(1)
    expect(s.recall).toBe(1)
  })

  test("result carries no numeric confidence field — only precision/recall/counts", () => {
    const s: ShadowScore = scoreStaticOwnerShadow([owner("a.py")], ["a.py"])
    expect(Object.keys(s).sort()).toEqual(
      ["goldCount", "precision", "predictedCount", "recall", "truePositives"].sort(),
    )
    expect((s as Record<string, unknown>).confidence).toBeUndefined()
    expect((s as Record<string, unknown>).threshold).toBeUndefined() // no baked-in gate
  })
})

describe("scoreStaticOwnerShadow — source fence (no-heuristic)", () => {
  test("scorer module has no baked precision threshold literal", async () => {
    const src = await Bun.file(
      new URL(
        "../../../../../../src/agent/observation/providers/static-owner/shadow.ts",
        import.meta.url,
      ),
    ).text()
    // No hard-coded gate like `precision > 0.7` — the scorer only REPORTS.
    expect(src).not.toMatch(/precision\s*[<>]=?\s*0?\.\d/)
    // No numeric literal used as a decision gate (a `>= 0.NN` comparison in code).
    expect(src).not.toMatch(/[<>]=?\s*0\.\d/)
  })
})
