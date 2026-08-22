/**
 * @deprecated jun-27 — the verify-select / best-of-N veto SELECTION plane is retired (it laundered correct patches to empty when no candidate passed the hard gates). Superseded by the closure-repair loop (run test → re-inject fail-log → rewrite). The enabling presets were removed; do NOT enable these knobs. Best-of-N may return later in a SOFT-rerank / LLM-judge form (never the hard-veto form), so this code is kept for reference only.
 *
 * Hard-gate + early-accept + lexicographic-scoring helpers for the selection
 * executor. Pure functions over candidates / scored entries / injected ports.
 * `ownerCoverageOf` is re-exported from `./selection-executor` (public surface);
 * everything else is imported back by the executor.
 */

import { analyzePatchBudget } from "@/agent/patch-budget"
import {
  type CandidateVerdict,
  type HardGateSignals,
  isValidResolvedKofN,
  type LexTiers,
  type ResolvedKofNSignal,
  resolvedKofNPositive,
  resolvedKofNVoterQuorum,
  type SelectorMode,
  type SoftScoreSignals,
  scoreCandidate,
} from "@/agent/verification-bundle"
import {
  candidateFamilyCoverageMissing,
  candidateFamilyRank,
  isCoChangeFamily,
} from "./candidate-families"
import { diffTouchedSymbols } from "./diff-touched-symbols"
import { type MweProofReceipt, mweProofAuthorityRank } from "./mwe-proof"
import {
  contractsSatisfiedCount,
  mergeSelectionContractBundles,
  requiredContractsSatisfiedCount,
} from "./public-contract-bundle"
import type { SelectionContractBundle } from "./public-contract-types"
import { hardResolvedRejected } from "./selection-proof-telemetry"
import type {
  Candidate,
  ResolvedKofNMode,
  ScoredEntry,
  SelectionPorts,
  SelectionProofState,
} from "./selection-types"

/** Fraction of a candidate's files that are closure-ranked owners. `null` when
 *  the candidate touches no file OR no owner set is known (uninformative ⇒
 *  fail-open soft signal, contributes nothing rather than a misleading 0). */
export const ownerCoverageOf = (
  files: readonly string[],
  owners: ReadonlySet<string>,
): number | null => {
  if (files.length === 0 || owners.size === 0) return null
  const hit = files.filter((f) => owners.has(f)).length
  return hit / files.length
}

const fullyInsideOwners = (files: readonly string[], owners: ReadonlySet<string>): boolean =>
  owners.size > 0 && files.length > 0 && files.every((f) => owners.has(f))

export const earlyAcceptable = (
  entry: ScoredEntry,
  owners: ReadonlySet<string>,
  requireHardResolved: boolean,
  mode: SelectorMode,
): boolean => {
  if (!entry.verdict.admissible) return false
  // Early-stop authority is STRICTER than admissibility: fail-open `null` gates
  // keep a candidate admissible, but they are not strong enough to stop the
  // loop. The progressive shortcut requires an explicitly clean-applying patch.
  if (!entry.hard.patchProduced || entry.hard.applyClean !== true) return false
  const resolved = entry.hard.patchedResolvedKofN
  // Executed proof receipt: a positive validated repro quorum OR an executed
  // clean keep-green witness result.
  const executedProof = resolvedKofNPositive(resolved) || entry.hard.regressionGreen === true
  if (mode === "clean") {
    // T-SEL-13: clean early-stop requires an EXECUTED proof receipt ONLY. No
    // static owner/family heuristic may stop the search by itself — a candidate
    // fully inside the (heuristic) owner set cannot early-accept without proof,
    // and strong static owner confidence never short-circuits the loop.
    return executedProof
  }
  // research/legacy cost shortcut (byte-identical): owner-coverage gated.
  // No owner authority => no early stop (collapses to "first positive wins").
  if (owners.size === 0) return false
  // A positive candidate may stop the loop only when every touched file is inside
  // the owner set; broad symptom+stray patches still face later owner siblings.
  if (!fullyInsideOwners(entry.candidate.files, owners)) return false
  if (requireHardResolved) return resolvedKofNPositive(resolved)
  return executedProof
}

export const voterQuorumOf = (
  mode: ResolvedKofNMode,
  resolved: ResolvedKofNSignal | null,
): number | null => (mode === "soft" ? resolvedKofNVoterQuorum(resolved) : null)

export const terminalAuthorityRank = (candidate: Candidate): number => {
  if (
    candidate.stopReason === "max_turns" ||
    candidate.stopReason === "budget_exhausted" ||
    candidate.stopReason === "aborted"
  ) {
    return 2
  }
  if (candidate.stopReason === "error" || candidate.stopReason === "refusal") return 1
  return 0
}

export const strongerTerminalRepresentative = (
  current: Candidate,
  candidate: Candidate,
): Candidate =>
  terminalAuthorityRank(candidate) > terminalAuthorityRank(current) ? candidate : current

export const minimalityOf = (args: {
  readonly isEmpty: boolean
  readonly size: number
  readonly minB: number
  readonly maxB: number
}): number | null => {
  if (args.isEmpty) return null
  return args.maxB === args.minB ? 1 : 1 - (args.size - args.minB) / (args.maxB - args.minB)
}

export const requireHardResolvedForEarlyAccept = (
  ports: SelectionPorts,
  mode: ResolvedKofNMode | undefined,
): boolean => ports.resolvedKofN !== undefined && (mode ?? "hard") === "hard"

export const declaredExpectedMatchOf = async (
  c: Candidate,
  isEmpty: boolean,
  ports: SelectionPorts,
): Promise<boolean | null> => {
  if (isEmpty) return null
  return (await ports.declaredExpected?.(c)) ?? null
}

export const staticSanityReasonsOf = async (
  c: Candidate,
  isEmpty: boolean,
  ports: SelectionPorts,
): Promise<readonly string[]> => {
  if (isEmpty) return []
  return (await ports.staticSanity?.(c)) ?? []
}

const MWE_CANDIDATE_RED_REJECT_REASON =
  "hard:mweProof=candidate_red (public issue MWE still fails after patch)"

const PROOF_REQUIRED_MISSING_REJECT_REASON =
  "hard:proofRequiredMissing=true (proof-required mode requires positive executed proof; safety or structural evidence alone cannot submit)"

const PROOF_INFRA_BLOCKED_REJECT_REASON =
  "hard:proofInfraBlocked=true (public proof execution failed; do not treat this as candidate correctness)"

const familyCoverageMissingRejectReason = (missing: readonly string[]): string =>
  `hard:familyCoverageMissing=${missing.join(",")} (typed co-change family postcondition not satisfied)`

const FAMILY_COVERAGE_VETO_EVIDENCE_PREFIXES = ["static-witness:", "cha-multisite:"] as const

const familyCoverageHasStructuralAuthority = (candidate: Candidate): boolean => {
  const evidence = candidate.familySourceEvidence
  // Legacy/test candidates may not carry provenance yet. Preserve prior behavior
  // there so this split only narrows the veto for real family-tagged candidates
  // whose source evidence is available.
  if (evidence === undefined) return true
  return evidence.some((entry) =>
    FAMILY_COVERAGE_VETO_EVIDENCE_PREFIXES.some((prefix) => entry.startsWith(prefix)),
  )
}

export const applyMweProofHardGate = (
  verdict: CandidateVerdict,
  mode: SelectorMode,
  receipt: MweProofReceipt | undefined,
): CandidateVerdict =>
  mode === "clean" && receipt?.state === "candidate_red"
    ? {
        admissible: false,
        score: verdict.score,
        reasons: [...verdict.reasons, MWE_CANDIDATE_RED_REJECT_REASON],
      }
    : verdict

export const applyProofRequiredHardGate = (
  verdict: CandidateVerdict,
  enabled: boolean,
  proofState: SelectionProofState,
): CandidateVerdict => {
  if (!enabled || proofState === "proof_positive") return verdict
  return {
    admissible: false,
    score: verdict.score,
    reasons: [
      ...verdict.reasons,
      proofState === "infra_blocked"
        ? PROOF_INFRA_BLOCKED_REJECT_REASON
        : PROOF_REQUIRED_MISSING_REJECT_REASON,
    ],
  }
}

export const applyStaticSanityHardGate = (
  verdict: CandidateVerdict,
  reasons: readonly string[],
): CandidateVerdict =>
  reasons.length === 0
    ? verdict
    : {
        admissible: false,
        score: verdict.score,
        reasons: [...verdict.reasons, ...reasons],
      }

export const familyCoverageMissingHardReasons = (candidate: Candidate): readonly string[] => {
  if (candidate.patch.trim() === "" || candidate.familyId === undefined) return []
  if (!isCoChangeFamily(candidate.familyId)) return []
  // T1 authority split: only structurally-authoritative co-change families may
  // veto in clean mode. Advisory exploration families may still steer generation
  // and ranking, but they must not escalate into a hard submit block without
  // typed relation provenance.
  if (!familyCoverageHasStructuralAuthority(candidate)) return []
  // Relatedness guard (T1): round-robin family planning assigns
  // `candidateFamilies[i]` independent of what candidate i actually edits, and
  // `withFamily` stamps the tag unconditionally. A candidate that touches NONE of
  // the family's owner files is spuriously tagged — do not veto it on a family it
  // has no relation to (prevents a false-positive rejection of an unrelated fix).
  const ownerFiles = candidate.familyOwnerFiles ?? []
  if (!ownerFiles.some((file) => candidate.files.includes(file))) return []
  const missing = candidateFamilyCoverageMissing(
    {
      familyId: candidate.familyId,
      ownerFiles,
    },
    candidate.files,
  )
  return missing.length === 0 ? [] : [familyCoverageMissingRejectReason(missing)]
}

const DECLARED_EXPECTED_REJECT_REASON =
  "hard:declaredExpectedMatch=false (candidate contradicts issue-declared expected behavior)"

const applyDeclaredExpectedHardGate = (
  verdict: CandidateVerdict,
  declaredExpectedMatch: boolean | null,
): CandidateVerdict =>
  declaredExpectedMatch === false
    ? {
        admissible: false,
        score: verdict.score,
        reasons: [...verdict.reasons, DECLARED_EXPECTED_REJECT_REASON],
      }
    : verdict

/**
 * Score under the active authority mode (T-AUTH-01 / T-SEL-02).
 *
 * `declaredExpected` is a `researchOnly` signal: a `declaredExpectedMatch ===
 * false` verdict may hard-reject ONLY in `research` mode (the legacy answer-key
 * veto, preserved byte-identically). The `declaredExpectedMatch === true` case
 * NEVER vetoes. (In research mode the `true` value also earns soft ranking credit
 * via `score.ts`; in clean mode researchOnly soft signals are excluded from the
 * ranking entirely — see accumulateSoftScore — so declaredExpected is credit-only
 * by being NON-vetoing rather than by adding score.)
 *
 * CLEAN mode NEVER hard-vetoes on declaredExpected — not even when the verdict
 * came from a PUBLIC-issue-text-derived invariant (`declaredExpectedPublic`).
 * The match is a STATIC, execution-free regex compare of the candidate's added
 * literals against a value extracted from issue PROSE; a non-executed heuristic
 * may not decide correctness, so it must only ADD ranking credit in clean mode,
 * never reject. By NOT adding `DECLARED_EXPECTED_REJECT_REASON` here, this also
 * keeps the candidate best-effort eligible (see `bestEffortEligible`, which bars
 * only on that reason). `declaredExpectedPublic` is retained for the call sites /
 * telemetry but no longer enables a clean-mode veto.
 */
export const scoreWithAuthority = (
  hard: HardGateSignals,
  soft: SoftScoreSignals,
  declaredExpectedMatch: boolean | null,
  mode: SelectorMode,
  declaredExpectedPublic = false,
): CandidateVerdict => {
  void declaredExpectedPublic
  const verdict = scoreCandidate(hard, soft, { mode })
  // RESEARCH mode keeps the legacy declaredExpected veto; CLEAN mode never vetoes
  // (the static answer-key/prose-regex match has no clean-benchmark authority).
  return mode === "clean" ? verdict : applyDeclaredExpectedHardGate(verdict, declaredExpectedMatch)
}

const countAddedSourceLines = (patch: string): number => {
  let n = 0
  for (const line of patch.split("\n")) if (line.startsWith("+") && !line.startsWith("+++")) n += 1
  return n
}

/**
 * Project a scored candidate into the clean-selector lexicographic tiers
 * (T-SEL-06). Executable proof (`votes/k`) + executed keep-green are the top
 * tiers. The public-contract tier (T-CON-10) is evaluated from `contracts` — but
 * only GENUINELY-sourced contracts the caller supplies; it is empty by default
 * (the closure owner ranking is heuristic and must not be promoted into this
 * tier — see runSelection). The candidate-family tier (T-GEN-09) stays 0 until
 * authoritative family evidence (T-OWN-12) exists; both slot in ABOVE minimality
 * WITHOUT disturbing the executable/structural tiers above.
 */
export const buildLexTiers = (
  entry: ScoredEntry,
  order: number,
  owners: ReadonlySet<string>,
  contracts: SelectionContractBundle,
): LexTiers => {
  const kofn = entry.resolvedKofN ?? entry.hard.patchedResolvedKofN
  const proofStrength =
    kofn !== null && isValidResolvedKofN(kofn) && kofn.k > 0 ? kofn.votes / kofn.k : 0
  const budget = analyzePatchBudget(entry.candidate.patch, { ownerFiles: [...owners] }).budget
  const candidate = {
    touchedFiles: entry.candidate.files,
    touchedSymbols: diffTouchedSymbols(entry.candidate.patch),
  }
  const effectiveContracts =
    mergeSelectionContractBundles(contracts, entry.candidate.publicContracts) ?? contracts
  return {
    mweProof: mweProofAuthorityRank(entry.candidate.mweReceipt),
    proofStrength,
    executedKeepGreen: entry.hard.regressionGreen === true ? 1 : 0,
    requiredContractsSatisfied: requiredContractsSatisfiedCount(effectiveContracts, candidate),
    contractsSatisfied: contractsSatisfiedCount(effectiveContracts, candidate),
    familyRank: candidateFamilyRank(
      entry.candidate.familyId === undefined
        ? undefined
        : {
            familyId: entry.candidate.familyId,
            ownerFiles: entry.candidate.familyOwnerFiles ?? [],
          },
      entry.candidate.files,
    ),
    sourceFiles: budget.sourceFiles,
    addedLines: countAddedSourceLines(entry.candidate.patch),
    newDefs: budget.newDefs,
    newFiles: budget.newFiles,
    order,
  }
}

const declaredExpectedRejected = (verdict: CandidateVerdict): boolean =>
  verdict.reasons.includes(DECLARED_EXPECTED_REJECT_REASON)

const mweCandidateRedRejected = (verdict: CandidateVerdict): boolean =>
  verdict.reasons.includes(MWE_CANDIDATE_RED_REJECT_REASON)

const proofRequiredRejected = (verdict: CandidateVerdict): boolean =>
  verdict.reasons.includes(PROOF_REQUIRED_MISSING_REJECT_REASON) ||
  verdict.reasons.includes(PROOF_INFRA_BLOCKED_REJECT_REASON)

const familyCoverageRejected = (verdict: CandidateVerdict): boolean =>
  verdict.reasons.some((reason) => reason.startsWith("hard:familyCoverageMissing="))

// B#3: a static-sanity hard reject is a DETERMINISTIC parse-level "this patch is
// broken" signal (e.g. callback arity mismatch, None-subscript mutation). Like
// the other hard vetoes it must also bar the best-effort fallback — otherwise a
// no-other-candidate run resurrects the broken patch via best-effort and submits
// it. (Matches the audit rule: selectBestEffort must not resubmit a candidate
// carrying explicit negative evidence.)
const staticSanityRejected = (verdict: CandidateVerdict): boolean =>
  verdict.reasons.some((reason) => reason.startsWith("hard:staticSanity="))

export const bestEffortEligible = (
  entry: Pick<ScoredEntry, "hard" | "verdict">,
  mode: SelectorMode,
): boolean => {
  if (!entry.hard.patchProduced) return false
  if (entry.hard.applyClean === false) return false
  if (entry.hard.regressionGreen === false) return false
  if (mode !== "clean" && entry.hard.smokeGreen === false) return false
  if (hardResolvedRejected(entry.hard.patchedResolvedKofN)) return false
  if (declaredExpectedRejected(entry.verdict)) return false
  if (mweCandidateRedRejected(entry.verdict)) return false
  if (proofRequiredRejected(entry.verdict)) return false
  if (familyCoverageRejected(entry.verdict)) return false
  if (staticSanityRejected(entry.verdict)) return false
  return true
}

/**
 * CORRECTED non-empty fallback eligibility (default-OFF A/B arm).
 *
 * This is the ROCK-SOLID SUBSET of submittability, used ONLY when there is NO
 * winner at all (no admissible AND no best-effort-eligible candidate, so the
 * alternative is submitting an EMPTY patch). A candidate is eligible to be
 * submitted in place of empty iff it:
 *   - produced a non-empty patch,
 *   - did not fail to apply (`applyClean !== false` — null fail-open is allowed),
 *   - did not regress existing tests (`regressionGreen !== false`), and
 *   - did not trip the DETERMINISTIC static-sanity parse gate (NameError /
 *     callback-arity / None-subscript style "this patch is broken" evidence).
 *
 * WEAK-DOMINANCE RATIONALE (SWE-bench, BINARY scoring): such a candidate WEAKLY
 * DOMINATES the empty patch. If it is wrong it scores 0 — exactly what empty
 * scores. If the ONLY thing that barred it was a SELF-oracle (the candidate's
 * own MWE/repro run, ~45% false-negative rate per jun-20), it may actually be
 * correct and score 1 (> empty). Submitting empty instead can only ever lose,
 * never help. So we DELIBERATELY DO NOT bar the SELF-oracle / completeness /
 * absorb-inert rejections that `bestEffortEligible` bars:
 *   - `mweCandidateRedRejected`   — candidate's own MWE still red (self-oracle FN)
 *   - `proofRequiredRejected`     — proof-required mode had no positive proof
 *   - `familyCoverageRejected`    — typed co-change completeness demand
 *   - `hardResolvedRejected`      — resolved-K-of-N self-oracle
 *   - `declaredExpectedRejected`  — static prose-regex answer-key heuristic
 * We STILL bar the genuinely-bad ones (won't apply / regresses / static-sanity /
 * empty): those risk a grader error or real breakage, not merely a 0.
 */
export const nonEmptyFallbackEligible = (
  entry: Pick<ScoredEntry, "hard" | "verdict">,
  _mode: SelectorMode,
): boolean => {
  if (!entry.hard.patchProduced) return false
  if (entry.hard.applyClean === false) return false
  if (entry.hard.regressionGreen === false) return false
  if (staticSanityRejected(entry.verdict)) return false
  return true
}

/**
 * G0 — RCA histogram key: which gate(s) barred a candidate. The first nine
 * mirror the EXACT predicate sequence {@link bestEffortEligible} checks, so the
 * diagnostic can never drift from the best-effort gate it explains; a candidate
 * with NONE of those nine is `bestEffortEligible`. The tenth (`family`) is an
 * ADDITIVE attribution bucket for the clean-mode family-coverage admissibility
 * veto (which bars before best-effort is even reached) — surfaced so a
 * family-driven winner=null is auditable rather than invisible.
 *
 * PURE telemetry — never changes admissibility or the winner.
 */
export type BestEffortIneligibleReason =
  | "patchProduced"
  | "applyClean"
  | "regressionGreen"
  | "smokeGreen"
  | "hardResolved"
  | "declaredExpected"
  | "mweRed"
  | "proof"
  | "staticSanity"
  | "family"

export const ineligibleReasonsFor = (
  entry: Pick<ScoredEntry, "hard" | "verdict">,
  mode: SelectorMode,
): readonly BestEffortIneligibleReason[] => {
  const reasons: BestEffortIneligibleReason[] = []
  if (!entry.hard.patchProduced) reasons.push("patchProduced")
  if (entry.hard.applyClean === false) reasons.push("applyClean")
  if (entry.hard.regressionGreen === false) reasons.push("regressionGreen")
  if (mode !== "clean" && entry.hard.smokeGreen === false) reasons.push("smokeGreen")
  if (hardResolvedRejected(entry.hard.patchedResolvedKofN)) reasons.push("hardResolved")
  if (declaredExpectedRejected(entry.verdict)) reasons.push("declaredExpected")
  if (mweCandidateRedRejected(entry.verdict)) reasons.push("mweRed")
  if (proofRequiredRejected(entry.verdict)) reasons.push("proof")
  if (staticSanityRejected(entry.verdict)) reasons.push("staticSanity")
  if (familyCoverageRejected(entry.verdict)) reasons.push("family")
  return reasons
}
