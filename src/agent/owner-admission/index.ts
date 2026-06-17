/**
 * T-202 — owner admission DECISION builder. PURE + deterministic, derived from
 * the {@link FaultEvidencePacket} (T-201). Answers one question: is the fault
 * owner clear enough to admit a "first edit candidate" line, or must the loop
 * keep gathering evidence first?
 *
 * BLIND like its upstream: reads only paths/scores/provenance/symbols from the
 * packet — never FAIL_TO_PASS / test_patch / gold / grader oracle. No I/O, no
 * LLM. Mirrors the pure-policy shape of `src/agent/no-patch-breaker.ts`.
 *
 * Output pairs with later tickets:
 *  - `admit:false` (multi-owner / empty) keeps the loop evidence-first; it does
 *    NOT hard-block edits (no dispatch-time deny — see T-202 acceptance).
 *  - `coverageExpectation` is the explicit class-fix risk axis: only
 *    `single-site` may later qualify for commit-fast without extra sibling
 *    evidence; `owner-family` / `cross-owner` raise `siblingCoverageExpected`
 *    so a single-site edit is NOT treated complete (pairs with T-601
 *    `sibling_coverage_missing`).
 */
import type { FaultCandidate, FaultEvidencePacket } from "@/agent/fault-evidence/types"

/**
 * Coverage class for the admitted defect.
 *  - `single-site`: one corroborated owner, no sibling producers/sites.
 *  - `owner-family`: owner plus co-ranked siblings that share evidence streams
 *    (same defect class likely spans them).
 *  - `cross-owner`: multiple unresolved plausible owners — ambiguous, not a
 *    family; evidence-first.
 */
export type CoverageExpectation = "single-site" | "owner-family" | "cross-owner"

export interface OwnerAdmissionInput {
  packet: FaultEvidencePacket
  /**
   * Score gap (top minus runner-up) below which two top candidates are treated
   * as co-plausible owners rather than a single clear winner.
   */
  minLeadGap?: number
}

export interface OwnerAdmission {
  /** True ⇒ a single corroborated owner is clear enough to inject as the first
   *  edit candidate. False ⇒ stay evidence-first (never a hard edit block). */
  admit: boolean
  /** Repo-relative owner path when `admit`, else `null`. */
  owner: string | null
  /** Explicit class-fix risk axis (T-601 pairing). */
  coverageExpectation: CoverageExpectation
  /** Convenience boolean: the defect class is expected to span sibling
   *  producers/sites, so a single-site edit must not be treated complete.
   *  True for `owner-family` and `cross-owner`. */
  siblingCoverageExpected: boolean
  /** Always non-empty; explains the decision deterministically. */
  reason: string
}

/** Default lead-gap: corroboration boosts in the packet are ≥1 (issue-file +2,
 *  owner-resolve +3), so a sub-1 gap means the runner-up is effectively tied. */
const DEFAULT_MIN_LEAD_GAP = 1

/** A candidate is "corroborated" when more than one evidence stream points at
 *  it — a single stage-1 rank hit alone is not enough to admit an owner. */
const isCorroborated = (c: FaultCandidate): boolean => c.sources.length > 1

export const decideOwnerAdmission = (input: OwnerAdmissionInput): OwnerAdmission => {
  const { packet } = input
  const gap = input.minLeadGap ?? DEFAULT_MIN_LEAD_GAP
  const candidates = packet.candidates

  // Empty / absent evidence ⇒ safe default: no owner, stay evidence-first.
  if (candidates.length === 0) {
    return {
      admit: false,
      owner: null,
      coverageExpectation: "cross-owner",
      siblingCoverageExpected: true,
      reason: packet.partial
        ? "no fault candidates (partial evidence: a blind input stream was absent) — evidence-first, no owner admitted"
        : "no fault candidates — evidence-first, no owner admitted",
    }
  }

  const [top, second] = candidates
  const lead = second ? top.score - second.score : Number.POSITIVE_INFINITY

  // Multiple plausible owners with no clear leader ⇒ need more evidence. Do not
  // force an owner; do not block edits. Ambiguity is `cross-owner`.
  if (second && lead < gap) {
    return {
      admit: false,
      owner: null,
      coverageExpectation: "cross-owner",
      siblingCoverageExpected: true,
      reason: `multiple plausible owners (top "${top.file}" score ${top.score} vs "${second.file}" ${second.score}, lead ${lead} < ${gap}) — evidence-first, no forced owner`,
    }
  }

  // Clear leader, but is it corroborated? A lone stage-1 hit is too weak to
  // admit as a first-edit candidate.
  if (!isCorroborated(top)) {
    return {
      admit: false,
      owner: null,
      coverageExpectation: "cross-owner",
      siblingCoverageExpected: true,
      reason: `top owner "${top.file}" uncorroborated (only sources: ${top.sources.join(", ")}) — evidence-first, no owner admitted`,
    }
  }

  // Single corroborated owner with a clear lead ⇒ admit. Now classify coverage:
  // a corroborated runner-up sharing an evidence stream signals the defect class
  // likely spans an owner family, so a single-site edit isn't complete.
  const familySibling = second && isCorroborated(second) && shareStream(top, second) ? second : null
  if (familySibling) {
    return {
      admit: true,
      owner: top.file,
      coverageExpectation: "owner-family",
      siblingCoverageExpected: true,
      reason: `single clear owner "${top.file}" with corroborated sibling "${familySibling.file}" sharing evidence (${sharedStreams(top, familySibling).join(", ")}) — admit; defect class spans the owner family, single-site edit not complete`,
    }
  }

  return {
    admit: true,
    owner: top.file,
    coverageExpectation: "single-site",
    siblingCoverageExpected: false,
    reason: `single corroborated owner "${top.file}" (sources: ${top.sources.join(", ")}, lead ${lead}) — admit as first edit candidate; single-site coverage`,
  }
}

const sharedStreams = (a: FaultCandidate, b: FaultCandidate): string[] =>
  a.sources.filter((s) => b.sources.includes(s))

const shareStream = (a: FaultCandidate, b: FaultCandidate): boolean =>
  sharedStreams(a, b).length > 0
