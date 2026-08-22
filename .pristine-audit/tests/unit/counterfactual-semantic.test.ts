import { describe, expect, it } from "bun:test"
import { analyzePatchBudget } from "@/agent/patch-budget"
import {
  deriveSemanticCounterfactualContracts,
  evaluateCounterfactualContracts,
  type FailedSelectionContract,
} from "@/runner/batch/eval/counterfactual-contract"
import type { CandidateRiskFacts } from "@/runner/batch/eval/counterfactual-risk"
import { buildCounterfactualSeed } from "@/runner/batch/eval/counterfactual-seed"

const inPlaceDiff = (file: string): string =>
  `diff --git a/${file} b/${file}\n` +
  `--- a/${file}\n` +
  `+++ b/${file}\n` +
  "@@ -1,3 +1,3 @@\n" +
  " def existing():\n" +
  "-    return 1\n" +
  "+    return 2\n"

const baseFacts = (over: Partial<CandidateRiskFacts> = {}): CandidateRiskFacts => ({
  touchedSourceFiles: 1,
  ownerFiles: ["pkg/symptom.py"],
  filesOutsideOwner: [],
  newFiles: 0,
  newDefs: 0,
  runtimeExpandingCalls: 0,
  crossFile: false,
  emptyPatch: false,
  applyClean: null,
  declaredExpectedMatch: null,
  structuralReasons: [],
  ...over,
})

describe("deriveSemanticCounterfactualContracts — opposite side of failed contract", () => {
  it("HELLGATE: symptom-owner cand0 that missed a lifecycle-owner contract targets the lifecycle family", () => {
    const failed: FailedSelectionContract = {
      kind: "lifecycle-owner",
      subjectFiles: ["pkg/lifecycle.py"],
    }
    const d = deriveSemanticCounterfactualContracts({
      failedContracts: [failed],
      candidateFamily: "symptom-owner",
    })
    expect(d.targetFamily).toBe("lifecycle-owner")
    expect(d.contracts).toEqual(["mustFixLifecycleOwner"])
    expect(d.targetFiles).toEqual(["pkg/lifecycle.py"])
  })

  it("maps each public-contract kind to its semantic counterfactual + family", () => {
    const cases: Array<[string, string, string]> = [
      ["owner-must-touch", "mustTouchOwnerFamily", "root-owner"],
      ["api-surface", "mustImplementApiSurface", "api-owner"],
      ["lifecycle-owner", "mustFixLifecycleOwner", "lifecycle-owner"],
      ["state-reset-semantics", "mustPreserveResetSemantics", "lifecycle-owner"],
      ["multi-site-family", "mustCoverContractFamily", "multi-site"],
    ]
    for (const [kind, contract, family] of cases) {
      const d = deriveSemanticCounterfactualContracts({
        failedContracts: [{ kind }],
        candidateFamily: "symptom-owner",
      })
      expect(d.contracts).toEqual([contract] as never)
      expect(d.targetFamily).toBe(family as never)
    }
  })

  it("OPPOSITE-SIDE GUARD: a cand0 already IN the demanded family produces no semantic counterfactual", () => {
    // cand0 is already a lifecycle-owner patch ⇒ no opposite side to steer to.
    const d = deriveSemanticCounterfactualContracts({
      failedContracts: [{ kind: "lifecycle-owner" }],
      candidateFamily: "lifecycle-owner",
    })
    expect(d.contracts).toEqual([])
    expect(d.targetFamily).toBeUndefined()
  })

  it("unknown / non-semantic contract kinds derive nothing (no instance matching)", () => {
    const d = deriveSemanticCounterfactualContracts({
      failedContracts: [{ kind: "exact-output" }, { kind: "totally-made-up" }],
      candidateFamily: "symptom-owner",
    })
    expect(d.contracts).toEqual([])
    expect(d.targetFamily).toBeUndefined()
  })

  it("honors a bundle-declared targetFamily over the kind-default when it is a known family", () => {
    const d = deriveSemanticCounterfactualContracts({
      failedContracts: [{ kind: "owner-must-touch", targetFamily: "api-owner" }],
      candidateFamily: "symptom-owner",
    })
    expect(d.contracts).toEqual(["mustTouchOwnerFamily"])
    expect(d.targetFamily).toBe("api-owner")
  })

  it("still steers when cand0 family is unknown (never silently drops the counterfactual)", () => {
    const d = deriveSemanticCounterfactualContracts({
      failedContracts: [{ kind: "lifecycle-owner" }],
      // no candidateFamily
    })
    expect(d.targetFamily).toBe("lifecycle-owner")
    expect(d.contracts).toEqual(["mustFixLifecycleOwner"])
  })
})

describe("evaluateCounterfactualContracts — semantic violations", () => {
  it("HELLGATE: a structurally-SMALLER patch that misses the demanded family STILL violates", () => {
    const d = deriveSemanticCounterfactualContracts({
      failedContracts: [{ kind: "lifecycle-owner", subjectFiles: ["pkg/lifecycle.py"] }],
      candidateFamily: "symptom-owner",
    })
    // cand1 is a tiny single-file in-place edit (structurally minimal) but it
    // edits the SYMPTOM file, not the lifecycle owner ⇒ semantic violation.
    const verdict = analyzePatchBudget(inPlaceDiff("pkg/symptom.py"), {
      ownerFiles: ["pkg/symptom.py"],
    })
    expect(verdict.budget.sourceFiles).toBe(1)
    expect(verdict.budget.newDefs).toBe(0)
    const ev = evaluateCounterfactualContracts({
      contracts: d.contracts,
      verdict,
      emptyPatch: false,
      candidateFiles: ["pkg/symptom.py"],
      semanticTargetFiles: d.targetFiles,
    })
    expect(ev.satisfied).toBe(false)
    expect(ev.semanticViolations).toEqual(["mustFixLifecycleOwner"])
    expect(ev.structuralViolations).toEqual([])
  })

  it("a candidate that TOUCHES the demanded family satisfies the semantic contract", () => {
    const d = deriveSemanticCounterfactualContracts({
      failedContracts: [{ kind: "lifecycle-owner", subjectFiles: ["pkg/lifecycle.py"] }],
      candidateFamily: "symptom-owner",
    })
    const verdict = analyzePatchBudget(inPlaceDiff("pkg/lifecycle.py"), {
      ownerFiles: ["pkg/lifecycle.py"],
    })
    const ev = evaluateCounterfactualContracts({
      contracts: d.contracts,
      verdict,
      emptyPatch: false,
      candidateFiles: ["pkg/lifecycle.py"],
      semanticTargetFiles: d.targetFiles,
    })
    expect(ev.satisfied).toBe(true)
    expect(ev.semanticViolations).toEqual([])
  })

  it("TELEMETRY: structural and semantic violations are reported on SEPARATE channels", () => {
    // Mix a structural contract (singleOwnerFile) with a semantic one and a
    // candidate that breaks BOTH: two files (neither the lifecycle subject).
    const twoFile = inPlaceDiff("pkg/a.py") + inPlaceDiff("pkg/b.py")
    const verdict = analyzePatchBudget(twoFile, { ownerFiles: ["pkg/a.py"] })
    expect(verdict.budget.sourceFiles).toBe(2)
    const ev = evaluateCounterfactualContracts({
      contracts: ["singleOwnerFile", "mustFixLifecycleOwner"],
      verdict,
      emptyPatch: false,
      candidateFiles: ["pkg/a.py", "pkg/b.py"],
      targetOwnerFile: "pkg/a.py",
      semanticTargetFiles: ["pkg/lifecycle.py"],
    })
    expect(ev.satisfied).toBe(false)
    expect(ev.structuralViolations).toEqual(["singleOwnerFile"])
    expect(ev.semanticViolations).toEqual(["mustFixLifecycleOwner"])
    // ordered: structural first, then semantic.
    expect(ev.violations).toEqual(["singleOwnerFile", "mustFixLifecycleOwner"])
  })

  it("NO GLOBAL REJECT: empty contract list ⇒ ANY patch is satisfied (non-counterfactual candidates untouched)", () => {
    const big = inPlaceDiff("pkg/a.py") + inPlaceDiff("pkg/b.py")
    const verdict = analyzePatchBudget(big, { ownerFiles: ["pkg/a.py"] })
    const ev = evaluateCounterfactualContracts({
      contracts: [],
      verdict,
      emptyPatch: false,
      candidateFiles: ["pkg/a.py", "pkg/b.py"],
      semanticTargetFiles: ["pkg/lifecycle.py"],
    })
    expect(ev.satisfied).toBe(true)
    expect(ev.violations).toEqual([])
    expect(ev.semanticViolations).toEqual([])
  })

  it("a semantic contract with NO known subject files cannot be falsified structurally (no invented reject)", () => {
    const verdict = analyzePatchBudget(inPlaceDiff("pkg/symptom.py"), {
      ownerFiles: ["pkg/symptom.py"],
    })
    const ev = evaluateCounterfactualContracts({
      contracts: ["mustFixLifecycleOwner"],
      verdict,
      emptyPatch: false,
      candidateFiles: ["pkg/symptom.py"],
      // no semanticTargetFiles ⇒ cannot prove the family was missed.
      semanticTargetFiles: [],
    })
    expect(ev.satisfied).toBe(true)
    expect(ev.semanticViolations).toEqual([])
  })
})

describe("buildCounterfactualSeed — semantic composition (T-CF-11)", () => {
  it("HELLGATE: symptom→lifecycle seed targets the lifecycle family, not merely 'smaller patch'", () => {
    const d = deriveSemanticCounterfactualContracts({
      failedContracts: [{ kind: "lifecycle-owner", subjectFiles: ["pkg/lifecycle.py"] }],
      candidateFamily: "symptom-owner",
    })
    const seed = buildCounterfactualSeed({
      facts: baseFacts({ touchedSourceFiles: 2, crossFile: true }),
      ownerFile: "pkg/symptom.py",
      semantic: d,
    })
    expect(seed).toBeDefined()
    // structural body preserved (now evidential)…
    expect(seed).toContain("Consider whether a smaller in-place alternative fully fixes the issue")
    // …AND it now surfaces the opposite (lifecycle) side as an advisory observation.
    expect(seed).toContain("a public contract for the lifecycle-owner family was not satisfied")
    expect(seed).toContain("`pkg/lifecycle.py`")
    // No categorical "fixed the wrong side" assertion.
    expect(seed).not.toContain("fixed the wrong side")
  })

  it("semantic-only (no structural breach) still produces a family-targeting seed", () => {
    const d = deriveSemanticCounterfactualContracts({
      failedContracts: [{ kind: "api-surface", subjectFiles: ["pkg/api.py"] }],
      candidateFamily: "symptom-owner",
    })
    const seed = buildCounterfactualSeed({
      facts: baseFacts(), // within budget ⇒ no structural seed
      ownerFile: "pkg/symptom.py",
      semantic: d,
    })
    expect(seed).toBeDefined()
    expect(seed).toContain("a public contract for the api-owner family was not satisfied")
    // semantic-only ⇒ no structural body.
    expect(seed).not.toContain("Consider whether a smaller in-place alternative")
    expect(seed).not.toContain("Facts about its patch")
  })

  it("RED-ON-INJECTION: omitting `semantic` preserves the pure structural seed verbatim", () => {
    const withSemantic = buildCounterfactualSeed({
      facts: baseFacts({ touchedSourceFiles: 2, crossFile: true }),
      ownerFile: "pkg/symptom.py",
    })
    expect(withSemantic).toBeDefined()
    // No semantic body when `semantic` is omitted: the advisory family
    // observation must not appear.
    expect(withSemantic).not.toContain("public contract for the")
    expect(withSemantic).not.toContain("was not satisfied by candidate 0")
    // structural body present + evidential.
    expect(withSemantic).toContain("Consider whether a smaller in-place alternative")
  })

  it("within-budget facts AND no semantic target ⇒ undefined (self-guard intact)", () => {
    const seed = buildCounterfactualSeed({
      facts: baseFacts(),
      ownerFile: "pkg/symptom.py",
      semantic: deriveSemanticCounterfactualContracts({
        failedContracts: [{ kind: "lifecycle-owner" }],
        candidateFamily: "lifecycle-owner", // same side ⇒ no target
      }),
    })
    expect(seed).toBeUndefined()
  })
})
