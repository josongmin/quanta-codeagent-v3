import { describe, expect, it } from "bun:test"
import { analyzePatchBudget } from "@/agent/patch-budget"
import {
  type CounterfactualContractKind,
  deriveCounterfactualContracts,
  evaluateCounterfactualContracts,
} from "@/runner/batch/eval/counterfactual-contract"
import type { CandidateRiskFacts } from "@/runner/batch/eval/counterfactual-risk"

/** Minimal in-place-edit hunk for a single file (no new def, no new file). */
const inPlaceDiff = (file: string): string =>
  `diff --git a/${file} b/${file}\n` +
  `--- a/${file}\n` +
  `+++ b/${file}\n` +
  "@@ -1,3 +1,3 @@\n" +
  " def existing():\n" +
  "-    return 1\n" +
  "+    return 2\n"

/** Diff that ADDS a brand-new def (genuinely new helper). */
const newDefDiff = (file: string): string =>
  `diff --git a/${file} b/${file}\n` +
  `--- a/${file}\n` +
  `+++ b/${file}\n` +
  "@@ -1,2 +1,5 @@\n" +
  " x = 1\n" +
  "+def brand_new_helper():\n" +
  "+    return 7\n"

/** Diff adding a runtime-expanding call the analyzer flags (get_compiler). */
const runtimeExpandDiff = (file: string): string =>
  `diff --git a/${file} b/${file}\n` +
  `--- a/${file}\n` +
  `+++ b/${file}\n` +
  "@@ -1,2 +1,3 @@\n" +
  " x = 1\n" +
  "+    self.query.get_compiler(using).execute_sql()\n"

const baseFacts: CandidateRiskFacts = {
  touchedSourceFiles: 1,
  ownerFiles: ["pkg/owner.py"],
  filesOutsideOwner: [],
  newFiles: 0,
  newDefs: 0,
  runtimeExpandingCalls: 0,
  crossFile: false,
  emptyPatch: false,
  applyClean: null,
  declaredExpectedMatch: null,
  structuralReasons: [],
}
const facts = (over: Partial<CandidateRiskFacts>): CandidateRiskFacts => ({ ...baseFacts, ...over })

describe("deriveCounterfactualContracts", () => {
  it("derives singleOwnerFile from cross-file / multi-file / outside-owner facts", () => {
    expect(deriveCounterfactualContracts(facts({ crossFile: true }))).toContain("singleOwnerFile")
    expect(deriveCounterfactualContracts(facts({ touchedSourceFiles: 2 }))).toContain(
      "singleOwnerFile",
    )
    expect(
      deriveCounterfactualContracts(facts({ filesOutsideOwner: ["pkg/other.py"] })),
    ).toContain("singleOwnerFile")
  })

  it("derives a contract per violated dimension and nothing for clean dimensions", () => {
    expect(deriveCounterfactualContracts(facts({ newDefs: 2 }))).toEqual(["noNewDefs"])
    expect(deriveCounterfactualContracts(facts({ newFiles: 1 }))).toEqual(["noNewFiles"])
    expect(deriveCounterfactualContracts(facts({ emptyPatch: true }))).toEqual(["nonEmptyPatch"])
  })

  it("derives [] when cand0 violated nothing (within-budget) — key no-hard-reject invariant", () => {
    expect(deriveCounterfactualContracts(baseFacts)).toEqual([])
  })

  it("does NOT derive singleOwnerFile for a single owner-only file", () => {
    // mutation teeth: flip any of the three OR-clauses to fire and this breaks.
    expect(deriveCounterfactualContracts(baseFacts)).not.toContain("singleOwnerFile")
  })
})

describe("evaluateCounterfactualContracts (real diffs via analyzePatchBudget)", () => {
  it("singleOwnerFile: cand1 touching 2 source files violates; owner-only satisfies", () => {
    const contracts = deriveCounterfactualContracts(facts({ crossFile: true, touchedSourceFiles: 2 }))
    expect(contracts).toEqual(["singleOwnerFile"])

    const twoFileDiff = inPlaceDiff("pkg/owner.py") + inPlaceDiff("pkg/elsewhere.py")
    const overVerdict = analyzePatchBudget(twoFileDiff, { ownerFiles: ["pkg/owner.py"] })
    // prove the real analyzer actually saw two source files (test has teeth).
    expect(overVerdict.budget.sourceFiles).toBe(2)
    const over = evaluateCounterfactualContracts({
      contracts,
      verdict: overVerdict,
      emptyPatch: false,
      candidateFiles: ["pkg/owner.py", "pkg/elsewhere.py"],
      targetOwnerFile: "pkg/owner.py",
    })
    expect(over.satisfied).toBe(false)
    expect(over.violations).toEqual(["singleOwnerFile"])

    const ownerVerdict = analyzePatchBudget(inPlaceDiff("pkg/owner.py"), {
      ownerFiles: ["pkg/owner.py"],
    })
    expect(ownerVerdict.budget.sourceFiles).toBe(1)
    const ok = evaluateCounterfactualContracts({
      contracts,
      verdict: ownerVerdict,
      emptyPatch: false,
      candidateFiles: ["pkg/owner.py"],
      targetOwnerFile: "pkg/owner.py",
    })
    expect(ok.satisfied).toBe(true)
    expect(ok.violations).toEqual([])
  })

  it("singleOwnerFile binds cand1 to the EXACT seeded owner file, not any owner-set file", () => {
    const contracts = deriveCounterfactualContracts(facts({ crossFile: true, touchedSourceFiles: 2 }))
    const verdict = analyzePatchBudget(inPlaceDiff("pkg/owner_b.py"), {
      ownerFiles: ["pkg/owner_a.py", "pkg/owner_b.py"],
    })
    expect(verdict.budget.sourceFiles).toBe(1)
    expect(verdict.budget.filesOutsideOwner).toEqual([])
    const ev = evaluateCounterfactualContracts({
      contracts,
      verdict,
      emptyPatch: false,
      candidateFiles: ["pkg/owner_b.py"],
      targetOwnerFile: "pkg/owner_a.py",
    })
    expect(ev.satisfied).toBe(false)
    expect(ev.violations).toEqual(["singleOwnerFile"])
  })

  it("noNewDefs: cand1 adding a def violates; in-place edit satisfies", () => {
    const contracts = deriveCounterfactualContracts(facts({ newDefs: 1 }))
    expect(contracts).toEqual(["noNewDefs"])

    const addsDef = analyzePatchBudget(newDefDiff("pkg/owner.py"), { ownerFiles: ["pkg/owner.py"] })
    expect(addsDef.budget.newDefs).toBe(1)
    const over = evaluateCounterfactualContracts({
      contracts,
      verdict: addsDef,
      emptyPatch: false,
      candidateFiles: ["pkg/owner.py"],
      targetOwnerFile: "pkg/owner.py",
    })
    expect(over.satisfied).toBe(false)
    expect(over.violations).toEqual(["noNewDefs"])

    const inPlace = analyzePatchBudget(inPlaceDiff("pkg/owner.py"), {
      ownerFiles: ["pkg/owner.py"],
    })
    expect(inPlace.budget.newDefs).toBe(0)
    const ok = evaluateCounterfactualContracts({
      contracts,
      verdict: inPlace,
      emptyPatch: false,
      candidateFiles: ["pkg/owner.py"],
      targetOwnerFile: "pkg/owner.py",
    })
    expect(ok.satisfied).toBe(true)
    expect(ok.violations).toEqual([])
  })

  it("noRuntimeExpansion: cand1 adding a runtime-expanding call violates; in-place edit satisfies", () => {
    const contracts = deriveCounterfactualContracts(facts({ runtimeExpandingCalls: 1 }))
    expect(contracts).toEqual(["noRuntimeExpansion"])

    const verdict = analyzePatchBudget(runtimeExpandDiff("pkg/owner.py"), {
      ownerFiles: ["pkg/owner.py"],
      runtimeExpandingPolicy: "gate",
    })
    expect(verdict.budget.runtimeExpandingCalls).toBeGreaterThan(0)
    const over = evaluateCounterfactualContracts({
      contracts,
      verdict,
      emptyPatch: false,
      candidateFiles: ["pkg/owner.py"],
      targetOwnerFile: "pkg/owner.py",
    })
    expect(over.satisfied).toBe(false)
    expect(over.violations).toEqual(["noRuntimeExpansion"])

    const inPlace = analyzePatchBudget(inPlaceDiff("pkg/owner.py"), {
      ownerFiles: ["pkg/owner.py"],
      runtimeExpandingPolicy: "gate",
    })
    const ok = evaluateCounterfactualContracts({
      contracts,
      verdict: inPlace,
      emptyPatch: false,
      candidateFiles: ["pkg/owner.py"],
      targetOwnerFile: "pkg/owner.py",
    })
    expect(ok.satisfied).toBe(true)
    expect(ok.violations).toEqual([])
  })

  it("nonEmptyPatch: cand1 empty violates; non-empty satisfies", () => {
    const contracts = deriveCounterfactualContracts(facts({ emptyPatch: true }))
    expect(contracts).toEqual(["nonEmptyPatch"])

    // an empty patch produces an empty/zero verdict; emptiness is signalled explicitly.
    const emptyVerdict = analyzePatchBudget("", { ownerFiles: ["pkg/owner.py"] })
    const over = evaluateCounterfactualContracts({
      contracts,
      verdict: emptyVerdict,
      emptyPatch: true,
      candidateFiles: [],
      targetOwnerFile: "pkg/owner.py",
    })
    expect(over.satisfied).toBe(false)
    expect(over.violations).toEqual(["nonEmptyPatch"])

    const nonEmptyVerdict = analyzePatchBudget(inPlaceDiff("pkg/owner.py"), {
      ownerFiles: ["pkg/owner.py"],
    })
    const ok = evaluateCounterfactualContracts({
      contracts,
      verdict: nonEmptyVerdict,
      emptyPatch: false,
      candidateFiles: ["pkg/owner.py"],
      targetOwnerFile: "pkg/owner.py",
    })
    expect(ok.satisfied).toBe(true)
    expect(ok.violations).toEqual([])
  })

  it("KEY INVARIANT: within-budget facts derive [] ⇒ ANY candidate is satisfied (no global hard reject)", () => {
    const contracts = deriveCounterfactualContracts(baseFacts)
    expect(contracts).toEqual([])

    // A deliberately LARGE / structurally-risky candidate patch: 2 files, a new
    // def, a runtime-expanding call. With NO contracts derived it must STILL pass,
    // proving contracts bind only counterfactual candidates and never leak globally.
    const bigDiff =
      newDefDiff("pkg/owner.py") +
      runtimeExpandDiff("pkg/elsewhere.py") +
      inPlaceDiff("pkg/third.py")
    const verdict = analyzePatchBudget(bigDiff, { ownerFiles: ["pkg/owner.py"] })
    // sanity: the real analyzer DOES consider this over-budget on its own…
    expect(verdict.budget.sourceFiles).toBeGreaterThan(1)
    expect(verdict.budget.newDefs).toBeGreaterThan(0)
    // …yet the contract layer imposes nothing.
    const ev = evaluateCounterfactualContracts({
      contracts,
      verdict,
      emptyPatch: false,
      candidateFiles: ["pkg/owner.py", "pkg/elsewhere.py", "pkg/third.py"],
    })
    expect(ev.satisfied).toBe(true)
    expect(ev.violations).toEqual([])
  })

  it("a derived contract the candidate HONORED is absent from violations (multi-contract)", () => {
    // cand0 violated BOTH singleOwnerFile and noNewDefs.
    const contracts = deriveCounterfactualContracts(facts({ crossFile: true, newDefs: 1 }))
    expect([...contracts].sort()).toEqual(["noNewDefs", "singleOwnerFile"] as CounterfactualContractKind[])

    // cand1 stays single-owner-file but STILL adds a def: only noNewDefs violates.
    const verdict = analyzePatchBudget(newDefDiff("pkg/owner.py"), { ownerFiles: ["pkg/owner.py"] })
    expect(verdict.budget.sourceFiles).toBe(1)
    expect(verdict.budget.newDefs).toBe(1)
    const ev = evaluateCounterfactualContracts({
      contracts,
      verdict,
      emptyPatch: false,
      candidateFiles: ["pkg/owner.py"],
      targetOwnerFile: "pkg/owner.py",
    })
    expect(ev.satisfied).toBe(false)
    expect(ev.violations).toEqual(["noNewDefs"])
    // mutation teeth: the honored contract must NOT appear.
    expect(ev.violations).not.toContain("singleOwnerFile")
  })
})
