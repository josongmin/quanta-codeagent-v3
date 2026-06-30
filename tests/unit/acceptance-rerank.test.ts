/**
 * Phase A — Agentless-faithful patch acceptance + rerank selector (SOTA++).
 *
 * Pure reimplementation of agentless/repair/rerank.py `majority_voting`:
 * select among best-of-N candidate patches, each scored ONCE by an acceptance
 * oracle (reproduction = boolean, regression = failure count). This REPLACES the
 * per-round repro re-voting: the reproduction test is a per-candidate boolean, the
 * VOTE is over normalized PATCHES, and a 3-tier fallback ladder degrades gracefully.
 *
 * Faithful to rerank.py:156-289:
 *  - regression "pass" = candidate's regressionFailures == min over all candidates
 *  - tier 1: regression-pass AND reproPass → vote
 *  - tier 2 (no tier-1 winner): drop repro, regression-pass → vote
 *  - tier 3 (still none / repro+reg off): vote over ALL non-empty patches
 *  - vote: Counter over patchKey; winner = max(votes, then earliest first-appearance)
 *  - all-empty ⇒ no selection
 */

import { describe, expect, test } from "bun:test"
import { type RerankCandidate, rerankSelect } from "../../src/runner/batch/eval/acceptance-rerank"

const c = (over: Partial<RerankCandidate>): RerankCandidate => ({
  patch: "P",
  patchKey: "K",
  regressionFailures: 0,
  reproPass: false,
  ...over,
})

const OPTS = { regression: true, reproduction: true }

describe("rerankSelect — Agentless-faithful acceptance + vote", () => {
  test("tier 1: picks the majority patch among repro-pass + min-regression candidates", () => {
    const r = rerankSelect(
      [
        c({ patch: "A", patchKey: "ka", regressionFailures: 0, reproPass: true }),
        c({ patch: "A", patchKey: "ka", regressionFailures: 0, reproPass: true }),
        c({ patch: "B", patchKey: "kb", regressionFailures: 0, reproPass: true }),
      ],
      OPTS,
    )
    expect(r.patch).toBe("A") // ka has 2 votes vs kb 1
    expect(r.tier).toBe("repro_and_regression")
    expect(r.votes).toBe(2)
  })

  test("regression is RELATIVE (min failures), not absolute zero", () => {
    // every candidate has >0 failures; the minimum (1) qualifies, higher excluded.
    const r = rerankSelect(
      [
        c({ patch: "A", patchKey: "ka", regressionFailures: 1, reproPass: true }),
        c({ patch: "B", patchKey: "kb", regressionFailures: 3, reproPass: true }),
      ],
      OPTS,
    )
    expect(r.patch).toBe("A")
    expect(r.tier).toBe("repro_and_regression")
  })

  test("repro gates: a min-regression candidate that FAILS repro is excluded at tier 1", () => {
    const r = rerankSelect(
      [
        c({ patch: "A", patchKey: "ka", regressionFailures: 0, reproPass: false }),
        c({ patch: "A", patchKey: "ka", regressionFailures: 0, reproPass: false }),
        c({ patch: "B", patchKey: "kb", regressionFailures: 0, reproPass: true }),
      ],
      OPTS,
    )
    // only B passes repro+regression ⇒ B wins despite A having more raw copies.
    expect(r.patch).toBe("B")
    expect(r.tier).toBe("repro_and_regression")
  })

  test("tier 2 fallback: NO candidate passes repro ⇒ drop repro, vote min-regression", () => {
    const r = rerankSelect(
      [
        c({ patch: "A", patchKey: "ka", regressionFailures: 0, reproPass: false }),
        c({ patch: "A", patchKey: "ka", regressionFailures: 0, reproPass: false }),
        c({ patch: "B", patchKey: "kb", regressionFailures: 2, reproPass: false }),
      ],
      OPTS,
    )
    // repro empty ⇒ fallback to min-regression (A: 0 fails, 2 votes) ⇒ A
    expect(r.patch).toBe("A")
    expect(r.tier).toBe("regression_only")
  })

  test("tier 3 fallback: all patches empty-key after filters ⇒ vote over all non-empty", () => {
    // reproduction+regression OFF ⇒ no filter ⇒ pure patch majority.
    const r = rerankSelect(
      [
        c({ patch: "A", patchKey: "ka" }),
        c({ patch: "B", patchKey: "kb" }),
        c({ patch: "B", patchKey: "kb" }),
      ],
      { regression: false, reproduction: false },
    )
    expect(r.patch).toBe("B")
    expect(r.tier).toBe("all_patches")
    expect(r.votes).toBe(2)
  })

  test("tie-break: equal votes ⇒ earliest first-appearance wins", () => {
    const r = rerankSelect(
      [
        c({ patch: "A", patchKey: "ka", reproPass: true }),
        c({ patch: "B", patchKey: "kb", reproPass: true }),
      ],
      OPTS,
    )
    expect(r.patch).toBe("A") // both 1 vote, ka appeared first
  })

  test("structural tie-break: equal votes ⇒ higher structuralPriority beats earlier appearance", () => {
    const r = rerankSelect(
      [
        c({ patch: "A", patchKey: "ka", reproPass: true, structuralPriority: 0 }),
        c({ patch: "B", patchKey: "kb", reproPass: true, structuralPriority: 2 }),
      ],
      OPTS,
    )
    expect(r.patch).toBe("B")
  })

  test("empty / whitespace patchKeys are not votable; all-empty ⇒ tier none, empty patch", () => {
    const r = rerankSelect(
      [c({ patch: "", patchKey: "" }), c({ patch: "  ", patchKey: "   " })],
      OPTS,
    )
    expect(r.patch).toBe("")
    expect(r.tier).toBe("none")
  })

  test("MUTATION GUARD: repro-pass must be REQUIRED at tier 1 (not ignored)", () => {
    // If the impl forgot the reproPass filter, A (3 copies, repro=false) would win.
    // Correct impl: only B passes ⇒ B.
    const r = rerankSelect(
      [
        c({ patch: "A", patchKey: "ka", reproPass: false }),
        c({ patch: "A", patchKey: "ka", reproPass: false }),
        c({ patch: "A", patchKey: "ka", reproPass: false }),
        c({ patch: "B", patchKey: "kb", reproPass: true }),
      ],
      OPTS,
    )
    expect(r.patch).toBe("B")
  })
})
