/**
 * Localization INVARIANTS (adversarial-audit R1 closeout) — referential integrity,
 * mutual exclusivity, idempotency-rejection, domain validation, deterministic ties.
 */
import { describe, expect, test } from "bun:test"
import { createLocalizationTracker } from "./pass"
import type { CandidateInput } from "./types"

const cand = (over: Partial<CandidateInput> = {}): CandidateInput => ({
  kind: "file",
  ref: "a.py",
  confidence: 0.5,
  ...over,
})

describe("addCandidate — domain", () => {
  test("unknown kind throws", () => {
    const t = createLocalizationTracker()
    expect(() => t.addCandidate(cand({ kind: "module" as never }))).toThrow(/unknown candidate kind/)
  })
  test("confidence outside [0,1] or non-finite throws", () => {
    const t = createLocalizationTracker()
    for (const bad of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => t.addCandidate(cand({ confidence: bad }))).toThrow(/confidence/)
    }
  })
  test("duplicate id throws", () => {
    const t = createLocalizationTracker()
    t.addCandidate(cand({ id: "x" }))
    expect(() => t.addCandidate(cand({ id: "x" }))).toThrow(/duplicate/)
  })
})

describe("exclude / select — referential integrity + mutual exclusivity", () => {
  test("exclude/select an unknown candidate throws", () => {
    const t = createLocalizationTracker()
    expect(() => t.exclude("cand-9999", "nope")).toThrow(/unknown candidate/)
    expect(() => t.selectPatchTarget("cand-9999", "nope")).toThrow(/unknown candidate/)
  })
  test("exclude then select the SAME candidate throws (contradiction)", () => {
    const t = createLocalizationTracker()
    const a = t.addCandidate(cand())
    t.exclude(a.id, "risky")
    expect(() => t.selectPatchTarget(a.id, "actually fix")).toThrow(/already excluded/)
  })
  test("select then exclude the SAME candidate throws (contradiction)", () => {
    const t = createLocalizationTracker()
    const a = t.addCandidate(cand())
    t.selectPatchTarget(a.id, "fix here")
    expect(() => t.exclude(a.id, "no")).toThrow(/already selected/)
  })
  test("duplicate exclude / duplicate select throws (no double records)", () => {
    const t = createLocalizationTracker()
    const a = t.addCandidate(cand())
    const b = t.addCandidate(cand({ ref: "b.py" }))
    t.exclude(a.id, "one")
    expect(() => t.exclude(a.id, "two")).toThrow(/already excluded/)
    t.selectPatchTarget(b.id, "one")
    expect(() => t.selectPatchTarget(b.id, "two")).toThrow(/already selected/)
  })
})

describe("active() — deterministic order under ties", () => {
  test("equal confidence breaks by insertion order (id)", () => {
    const t = createLocalizationTracker()
    t.addCandidate(cand({ ref: "first", confidence: 0.8 }))
    t.addCandidate(cand({ ref: "second", confidence: 0.8 }))
    t.addCandidate(cand({ ref: "third", confidence: 0.8 }))
    expect(t.active().map((c) => c.ref)).toEqual(["first", "second", "third"])
  })
  test("confidence is finite by construction ⇒ sort is well-defined (no NaN holes)", () => {
    const t = createLocalizationTracker()
    t.addCandidate(cand({ ref: "lo", confidence: 0.1 }))
    t.addCandidate(cand({ ref: "hi", confidence: 0.9 }))
    expect(t.active().map((c) => c.ref)).toEqual(["hi", "lo"])
  })
})
