/**
 * Counterfactual contract derivation + evaluation (T-301 + T-CF-11).
 *
 * STRUCTURAL layer (T-301): when candidate 0 trips structural risk, candidate 1
 * is generated from a counterfactual seed that imposes STRUCTURAL CONTRACTS
 * (single owner file, no new defs, no new files, no runtime expansion, non-empty
 * patch). The selector PENALIZES a counterfactual candidate that violates its OWN
 * contract.
 *
 * SEMANTIC layer (T-CF-11): structural minimality alone repairs "the patch is too
 * big" but not "the patch fixed the wrong SIDE of the issue". When candidate 0 is
 * (e.g.) a symptom-owner patch that missed a *lifecycle-owner* public contract,
 * the counterfactual should be steered to the OPPOSITE side of the failed
 * contract — the lifecycle family — instead of merely demanding a smaller edit.
 * `deriveSemanticCounterfactualContracts` turns a FAILED public-contract
 * descriptor (+ candidate-family contrast + structural facts) into semantic
 * contracts and a concrete `targetFamily`.
 *
 * Authority stays NARROW for BOTH layers: derived contracts bind ONLY the
 * counterfactual candidate spawned from them, and only on the exact dimensions
 * cand0 actually violated. A legitimately-large patch from a NORMAL
 * (non-counterfactual) candidate derives `[]` contracts here and is therefore
 * always satisfied — the key invariant that keeps the patch-budget escalation
 * path (NOT a hard reject) intact for ordinary candidates. There is NO
 * instance-specific matching: the derivation reads only the structural
 * descriptor `kind`, never issue text.
 *
 * Source of truth for cand0's structural violations: {@link CandidateRiskFacts}
 * (`@/runner/batch/eval/counterfactual-risk`). Source of truth for the
 * counterfactual candidate's own structure: {@link PatchBudgetVerdict}
 * (`@/agent/patch-budget`). PURE + deterministic — no reason-string parsing.
 */

import type { PatchBudgetVerdict } from "@/agent/patch-budget"
import type { CandidateRiskFacts } from "@/runner/batch/eval/counterfactual-risk"

/** Structural contract kinds (T-301) — bound to the patch-budget facts. */
export type StructuralCounterfactualContractKind =
  | "singleOwnerFile"
  | "noNewDefs"
  | "noNewFiles"
  | "nonEmptyPatch"

/** Semantic contract kinds (T-CF-11) — the "opposite side of the failed public
 *  contract". Each binds the counterfactual candidate to TOUCH the family the
 *  failed public contract demanded, rather than to shrink the patch. */
export type SemanticCounterfactualContractKind =
  | "mustTouchOwnerFamily"
  | "mustImplementApiSurface"
  | "mustFixLifecycleOwner"
  | "mustPreserveResetSemantics"
  | "mustCoverContractFamily"

export type CounterfactualContractKind =
  | StructuralCounterfactualContractKind
  | SemanticCounterfactualContractKind

const STRUCTURAL_KINDS: ReadonlySet<CounterfactualContractKind> =
  new Set<CounterfactualContractKind>([
    "singleOwnerFile",
    "noNewDefs",
    "noNewFiles",
    "nonEmptyPatch",
  ])

/** True for the structural (patch-budget) contract kinds; false for semantic. */
export const isStructuralCounterfactualContract = (
  kind: CounterfactualContractKind,
): kind is StructuralCounterfactualContractKind => STRUCTURAL_KINDS.has(kind)

/** Derive the STRUCTURAL contracts cand1 must honor, from cand0's risk facts.
 *  Only emit a contract for a dimension cand0 actually violated. UNCHANGED from
 *  T-301: existing callers and tests depend on this exact behavior. */
export const deriveCounterfactualContracts = (
  facts: CandidateRiskFacts,
): readonly StructuralCounterfactualContractKind[] => {
  const contracts: StructuralCounterfactualContractKind[] = []
  if (facts.crossFile || facts.touchedSourceFiles > 1 || facts.filesOutsideOwner.length > 0)
    contracts.push("singleOwnerFile")
  if (facts.newDefs > 0) contracts.push("noNewDefs")
  if (facts.newFiles > 0) contracts.push("noNewFiles")
  if (facts.emptyPatch === true) contracts.push("nonEmptyPatch")
  return contracts
}

// ── semantic derivation (T-CF-11) ───────────────────────────────────────────

/** Candidate families the static engine separates candidates into. */
export type CandidateFamily =
  | "root-owner"
  | "symptom-owner"
  | "api-owner"
  | "lifecycle-owner"
  | "test-adjacent-owner"
  | "multi-site"

/**
 * Minimal STRUCTURAL descriptor of a FAILED public contract. Defined locally
 * (not imported) on purpose: the public-contract bundle is owned by another
 * agent, so we depend only on this stable shape to avoid a cross-file race.
 *
 * `kind` is the public-contract class that the winning/terminal candidate FAILED
 * to satisfy (e.g. `lifecycle-owner`, `api-surface`). It is a generic typed
 * obligation, NEVER an issue-family regex or instance id.
 */
export interface FailedSelectionContract {
  readonly kind: string
  /** Files the failed public contract names as its subject (the side that must
   *  be touched). Used to bind a concrete target file when available. */
  readonly subjectFiles?: readonly string[]
  /** Candidate family the failed public contract belongs to, if the bundle
   *  already classified it. When absent we infer it from `kind`. */
  readonly targetFamily?: string
}

/** Result of semantic derivation: the contracts cand1 must honor, the family it
 *  must steer toward, and the concrete subject files (if the contract named
 *  any). `targetFamily === undefined` ⇒ no semantic counterfactual applies. */
export interface SemanticCounterfactualDerivation {
  readonly contracts: readonly SemanticCounterfactualContractKind[]
  readonly targetFamily: CandidateFamily | undefined
  readonly targetFiles: readonly string[]
}

/** Map a public-contract `kind` to its semantic counterfactual contract +
 *  target family. Generic typed mapping — no instance matching. */
const SEMANTIC_BY_CONTRACT_KIND: Readonly<
  Record<string, { contract: SemanticCounterfactualContractKind; family: CandidateFamily }>
> = {
  "owner-must-touch": { contract: "mustTouchOwnerFamily", family: "root-owner" },
  "api-surface": { contract: "mustImplementApiSurface", family: "api-owner" },
  "lifecycle-owner": { contract: "mustFixLifecycleOwner", family: "lifecycle-owner" },
  "state-reset-semantics": { contract: "mustPreserveResetSemantics", family: "lifecycle-owner" },
  "multi-site-family": { contract: "mustCoverContractFamily", family: "multi-site" },
}

const CANDIDATE_FAMILIES: ReadonlySet<string> = new Set<CandidateFamily>([
  "root-owner",
  "symptom-owner",
  "api-owner",
  "lifecycle-owner",
  "test-adjacent-owner",
  "multi-site",
])

const asCandidateFamily = (value: string | undefined): CandidateFamily | undefined =>
  value !== undefined && CANDIDATE_FAMILIES.has(value) ? (value as CandidateFamily) : undefined

/**
 * Derive the SEMANTIC counterfactual contract(s) — the "opposite side of the
 * failed contract" — from the failed public contract(s), the contrast between
 * the candidate family cand0 came from vs the family the contract demanded, and
 * the structural patch-budget facts.
 *
 * Steering rule: emit a semantic contract only when the failed contract maps to
 * a family DIFFERENT from cand0's family (the genuine "opposite side"). A
 * symptom-owner cand0 that missed a lifecycle-owner contract therefore produces
 * `mustFixLifecycleOwner` targeting `lifecycle-owner`; a candidate already in the
 * demanded family produces nothing (no counterfactual to spawn). When cand0's
 * family is unknown, we still steer (we cannot prove same-side), so the
 * counterfactual is never silently dropped.
 *
 * Authority is narrow: the returned contracts/targetFamily describe ONLY the
 * counterfactual candidate to be spawned; they never reject other candidates.
 */
export const deriveSemanticCounterfactualContracts = (args: {
  readonly failedContracts: readonly FailedSelectionContract[]
  /** Candidate family cand0 (the patch that missed the contract) came from. */
  readonly candidateFamily?: string
  /** Structural facts — currently advisory context only; semantic steering does
   *  not require a structural breach (a within-budget symptom patch can still
   *  miss a lifecycle contract). Reserved for future budget-aware steering. */
  readonly facts?: CandidateRiskFacts
}): SemanticCounterfactualDerivation => {
  const contracts: SemanticCounterfactualContractKind[] = []
  const families: CandidateFamily[] = []
  const targetFiles: string[] = []
  const cand0Family = asCandidateFamily(args.candidateFamily)

  for (const failed of args.failedContracts) {
    const mapped = SEMANTIC_BY_CONTRACT_KIND[failed.kind]
    if (mapped === undefined) continue
    // Prefer the bundle-declared family if it is a known family, else the mapped one.
    const demanded = asCandidateFamily(failed.targetFamily) ?? mapped.family
    // Opposite-side rule: skip when cand0 already lives in the demanded family.
    if (cand0Family !== undefined && cand0Family === demanded) continue
    if (!contracts.includes(mapped.contract)) contracts.push(mapped.contract)
    if (!families.includes(demanded)) families.push(demanded)
    for (const f of failed.subjectFiles ?? []) {
      if (f !== "" && !targetFiles.includes(f)) targetFiles.push(f)
    }
  }

  return {
    contracts,
    // First demanded family wins as the primary steer target (stable, ordered).
    targetFamily: families[0],
    targetFiles,
  }
}

export type FailedPublicContract = FailedSelectionContract

export interface CounterfactualContractEvaluation {
  /** true ⇒ candidate honored every derived contract (or no contracts derived). */
  readonly satisfied: boolean
  readonly violations: readonly CounterfactualContractKind[]
  /** violations that are structural (patch-budget) contracts. */
  readonly structuralViolations: readonly StructuralCounterfactualContractKind[]
  /** violations that are semantic ("opposite-side") contracts. */
  readonly semanticViolations: readonly SemanticCounterfactualContractKind[]
}

/** Evaluate a counterfactual candidate's OWN patch against the derived contracts.
 *  Only the derived `contracts` are checked: an undriven dimension never violates.
 *
 *  STRUCTURAL contracts read the patch-budget verdict (T-301, unchanged).
 *  SEMANTIC contracts read whether the candidate TOUCHED the demanded family —
 *  i.e. its patched files intersect the contract's subject files. A semantic
 *  contract with no known subject files (and no target-family files) cannot be
 *  falsified structurally and is treated as satisfied (we never invent a
 *  reject). */
export const evaluateCounterfactualContracts = (args: {
  readonly contracts: readonly CounterfactualContractKind[]
  readonly verdict: PatchBudgetVerdict // analyzePatchBudget(candidate1.patch, {ownerFiles})
  readonly emptyPatch: boolean
  /** Repo-relative files the candidate patch touched. Used to bind the
   *  single-owner-file contract to the EXACT owner file that seeded cand1, and to
   *  decide whether a SEMANTIC candidate touched the demanded family. */
  readonly candidateFiles?: readonly string[]
  /** The concrete owner file the counterfactual seed targeted. Undefined keeps
   *  the older "any one owner file" interpretation. (Accepts an explicit
   *  `undefined` so callers may forward an optional owner without a guard.) */
  readonly targetOwnerFile?: string | undefined
  /** Subject files the SEMANTIC counterfactual must touch (the demanded family's
   *  files). When present, a semantic contract is violated unless the candidate
   *  touched at least one of them. */
  readonly semanticTargetFiles?: readonly string[]
}): CounterfactualContractEvaluation => {
  const b = args.verdict.budget
  const candidateFiles = args.candidateFiles ?? []
  const semanticTargetFiles = args.semanticTargetFiles ?? []
  const touchedDemandedFamily =
    semanticTargetFiles.length === 0 || semanticTargetFiles.some((f) => candidateFiles.includes(f))

  const violatesStructural = (kind: StructuralCounterfactualContractKind): boolean => {
    switch (kind) {
      case "singleOwnerFile":
        if (b.sourceFiles > 1 || b.filesOutsideOwner.length > 0) return true
        return args.targetOwnerFile !== undefined && !candidateFiles.includes(args.targetOwnerFile)
      case "noNewDefs":
        return b.newDefs > 0
      case "noNewFiles":
        return b.newFiles > 0
      case "nonEmptyPatch":
        return args.emptyPatch === true
    }
  }

  // Every semantic contract shares the same falsifier: did the candidate touch the
  // demanded family? (The kind only records WHICH side; the obligation is uniform.)
  const violatesSemantic = (_kind: SemanticCounterfactualContractKind): boolean =>
    !touchedDemandedFamily

  const structuralViolations: StructuralCounterfactualContractKind[] = []
  const semanticViolations: SemanticCounterfactualContractKind[] = []
  for (const kind of args.contracts) {
    if (isStructuralCounterfactualContract(kind)) {
      if (violatesStructural(kind)) structuralViolations.push(kind)
    } else if (violatesSemantic(kind)) {
      semanticViolations.push(kind)
    }
  }
  const violations: CounterfactualContractKind[] = [...structuralViolations, ...semanticViolations]
  return {
    satisfied: violations.length === 0,
    violations,
    structuralViolations,
    semanticViolations,
  }
}
