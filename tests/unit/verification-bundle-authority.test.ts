import { describe, expect, it } from "bun:test"
import type { HardGateSignals, SoftScoreSignals } from "@/agent/verification-bundle"
import {
  isCleanHardVeto,
  isKnownSignal,
  SIGNAL_AUTHORITY,
  scoreCandidate,
} from "@/agent/verification-bundle"

const hard = (over: Partial<HardGateSignals> = {}): HardGateSignals => ({
  baseValidatedRed: null,
  patchProduced: true,
  patchedResolvedKofN: null,
  regressionGreen: null,
  smokeGreen: null,
  applyClean: null,
  ...over,
})

const soft = (over: Partial<SoftScoreSignals> = {}): SoftScoreSignals => ({
  declaredExpectedMatch: null,
  rubricScore: null,
  voterQuorum: null,
  minimality: null,
  ownerCoverage: null,
  ...over,
})

describe("T-AUTH-01 — authority taxonomy completeness", () => {
  it("classifies EVERY hard + soft signal (no unclassified signal can reach the selector)", () => {
    const hardKeys = Object.keys(hard())
    const softKeys = Object.keys(soft())
    for (const k of [...hardKeys, ...softKeys]) {
      expect(isKnownSignal(k)).toBe(true)
      expect(SIGNAL_AUTHORITY[k]).toBeDefined()
    }
  })

  it("an unknown signal is not classified (selector must refuse it as a hard gate)", () => {
    expect(isKnownSignal("totallyNewHeuristic")).toBe(false)
    expect(isCleanHardVeto("totallyNewHeuristic", "clean")).toBe(false)
  })

  it("pins the authority class of the heuristic signals as researchOnly", () => {
    expect(SIGNAL_AUTHORITY.smokeGreen).toBe("researchOnly")
    expect(SIGNAL_AUTHORITY.declaredExpectedMatch).toBe("researchOnly")
    expect(SIGNAL_AUTHORITY.rubricScore).toBe("researchOnly")
  })

  it("pins executable/structural authority for the clean-veto signals", () => {
    expect(SIGNAL_AUTHORITY.applyClean).toBe("hardStructural")
    expect(SIGNAL_AUTHORITY.patchProduced).toBe("hardStructural")
    expect(SIGNAL_AUTHORITY.regressionGreen).toBe("hardExecutable")
    expect(SIGNAL_AUTHORITY.patchedResolvedKofN).toBe("hardExecutable")
  })

  // FIX 2 — voterQuorum is a SoftScoreSignals member consumed ONLY in the soft
  // weighted loop; it is never a hard gate. Misclassifying it `hardExecutable`
  // lied about the channel it flows on and (per the taxonomy doc) would let it
  // veto a clean candidate. Its true role is a final tie-break.
  it("classifies voterQuorum as softTieBreak (its actual role), NOT a hard gate", () => {
    expect(SIGNAL_AUTHORITY.voterQuorum).toBe("softTieBreak")
    // It must not be admitted as a clean-mode hard veto.
    expect(isCleanHardVeto("voterQuorum", "clean")).toBe(false)
  })
})

describe("T-AUTH-01 — clean vs research veto", () => {
  it("RESEARCH mode: smokeGreen=false rejects (byte-identical legacy behavior)", () => {
    const v = scoreCandidate(hard({ smokeGreen: false }), soft())
    expect(v.admissible).toBe(false)
    expect(v.reasons.some((r) => r.startsWith("hard:smokeGreen=false"))).toBe(true)
  })

  it("CLEAN mode: smokeGreen=false CANNOT reject (researchOnly has no clean veto)", () => {
    const v = scoreCandidate(hard({ smokeGreen: false }), soft(), { mode: "clean" })
    expect(v.admissible).toBe(true)
    // it is still observed, but only as a non-veto research note.
    expect(v.reasons.some((r) => r.startsWith("research:smokeGreen=false"))).toBe(true)
    expect(v.reasons.some((r) => r.startsWith("hard:smokeGreen"))).toBe(false)
  })

  it("CLEAN mode: structural + executable signals STILL veto", () => {
    expect(scoreCandidate(hard({ applyClean: false }), soft(), { mode: "clean" }).admissible).toBe(
      false,
    )
    expect(
      scoreCandidate(hard({ patchProduced: false }), soft(), { mode: "clean" }).admissible,
    ).toBe(false)
    expect(
      scoreCandidate(hard({ regressionGreen: false }), soft(), { mode: "clean" }).admissible,
    ).toBe(false)
    expect(
      scoreCandidate(hard({ patchedResolvedKofN: { votes: 0, k: 1 } }), soft(), { mode: "clean" })
        .admissible,
    ).toBe(false)
  })

  it("default mode is research (no opts ⇒ legacy hard gates intact)", () => {
    expect(scoreCandidate(hard({ smokeGreen: false }), soft()).admissible).toBe(false)
  })
})

describe("T-AUTH-01 — clean-mode ranking excludes researchOnly soft signals", () => {
  it("declaredExpectedMatch/rubric do NOT add to the clean score; softTieBreak still counts", () => {
    // research: declaredExpectedMatch=true (0.25) + minimality=1 (0.15) contribute.
    const research = scoreCandidate(hard(), soft({ declaredExpectedMatch: true, minimality: 1 }))
    // clean: declaredExpectedMatch excluded (researchOnly); only minimality (softTieBreak) counts.
    const clean = scoreCandidate(hard(), soft({ declaredExpectedMatch: true, minimality: 1 }), {
      mode: "clean",
    })
    expect(research.score).toBeGreaterThan(clean.score)
    expect(clean.reasons.some((r) => r.startsWith("soft:declaredExpectedMatch"))).toBe(false)
    expect(clean.reasons.some((r) => r.startsWith("soft:minimality"))).toBe(true)
  })

  it("RED-ON-INJECTION: a clean candidate cannot be ranked up by declaredExpected alone", () => {
    const clean = scoreCandidate(hard(), soft({ declaredExpectedMatch: true }), { mode: "clean" })
    expect(clean.score).toBe(0)
  })

  // FIX 2 — voterQuorum is softTieBreak, so it STILL contributes to the clean
  // ranking (only researchOnly/observeOnly are excluded), and it is NEVER a hard
  // gate: a present voterQuorum does not change admissibility.
  it("voterQuorum (softTieBreak) still ranks in clean mode and never gates admissibility", () => {
    const clean = scoreCandidate(hard(), soft({ voterQuorum: 1 }), { mode: "clean" })
    expect(clean.admissible).toBe(true)
    expect(clean.reasons.some((r) => r.startsWith("soft:voterQuorum"))).toBe(true)
    expect(clean.score).toBeGreaterThan(0)
  })
})
