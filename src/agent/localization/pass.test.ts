/**
 * LocalizationPass — deterministic narrowing hellgate.
 * Pins: deterministic ids, add, exclude drops from active, select drops from active,
 * confidence sort, evidenceRefs default [], snapshot shape.
 */
import { describe, expect, test } from "bun:test"
import { nth } from "../../../tests/_helpers/expect-present"
import { createLocalizationTracker } from "./pass"
import type { CandidateInput } from "./types"

const cand = (over: Partial<CandidateInput> = {}): CandidateInput => ({
  kind: "file",
  ref: "src/fib.py",
  confidence: 0.5,
  ...over,
})

describe("createLocalizationTracker — deterministic ids + add", () => {
  test("assigns cand-0001… deterministically; two fresh trackers agree", () => {
    const ids = () => {
      const t = createLocalizationTracker()
      return [t.addCandidate(cand()).id, t.addCandidate(cand({ ref: "x" })).id]
    }
    expect(ids()).toEqual(["cand-0001", "cand-0002"])
    expect(ids()).toEqual(ids())
  })

  test("evidenceRefs defaults to []; caller id respected", () => {
    const t = createLocalizationTracker()
    const c = t.addCandidate(cand({ id: "pinned" }))
    expect(c.id).toBe("pinned")
    expect(c.evidenceRefs).toEqual([])
  })
})

describe("narrowing — exclude / select drop from active", () => {
  test("exclude removes a candidate from active(), records reason+evidence", () => {
    const t = createLocalizationTracker()
    const a = t.addCandidate(cand({ ref: "a.py" }))
    t.addCandidate(cand({ ref: "b.py" }))
    t.exclude(a.id, "no call path to symptom", ["ev-0003"])
    expect(t.active().map((c) => c.ref)).toEqual(["b.py"])
    expect(t.snapshot().excluded).toEqual([
      { candidateId: a.id, reason: "no call path to symptom", evidenceRefs: ["ev-0003"] },
    ])
  })

  test("selectPatchTarget removes from active (already chosen) + records rationale", () => {
    const t = createLocalizationTracker()
    const a = t.addCandidate(cand({ ref: "a.py" }))
    t.addCandidate(cand({ ref: "b.py" }))
    t.selectPatchTarget(a.id, "owner of the failing assertion", ["ev-1"])
    expect(t.active().map((c) => c.ref)).toEqual(["b.py"])
    expect(t.snapshot().selectedPatchTargets[0]).toMatchObject({
      candidateId: a.id,
      rationale: "owner of the failing assertion",
    })
  })
})

describe("active() ranks by confidence desc", () => {
  test("highest confidence first, excluded/selected omitted", () => {
    const t = createLocalizationTracker()
    t.addCandidate(cand({ ref: "low", confidence: 0.2 }))
    t.addCandidate(cand({ ref: "high", confidence: 0.9 }))
    const mid = t.addCandidate(cand({ ref: "mid", confidence: 0.5 }))
    t.addCandidate(cand({ ref: "excluded", confidence: 0.99 }))
    t.exclude(nth(t.snapshot().candidates, 3, "snapshot().candidates").id, "ruled out")
    void mid
    expect(t.active().map((c) => c.ref)).toEqual(["high", "mid", "low"]) // excluded(0.99) gone
  })
})

describe("snapshot", () => {
  test("returns copies (mutating tracker after snapshot doesn't change it)", () => {
    const t = createLocalizationTracker()
    t.addCandidate(cand())
    const snap = t.snapshot()
    t.addCandidate(cand({ ref: "second" }))
    expect(snap.candidates.length).toBe(1) // frozen at snapshot time
  })
})
