/**
 * LocalizationPass builder (jul-5, SOTA++ P5) — pure narrowing over candidates.
 *
 * Deterministic ids (`cand-0001`, …, no clock/random). The tracker NARROWS: add candidates,
 * exclude with a reason+evidence, select patch targets. `active()` = candidates neither excluded
 * nor already selected — the working set the model reasons over. All queries are O(n) scans (n =
 * session candidates, small). The tracker organizes; it never auto-picks the fix.
 */

import { byteCompare } from "@/shared"
import {
  CANDIDATE_KINDS,
  type Candidate,
  type CandidateInput,
  type Exclusion,
  type LocalizationPass,
  type PatchTarget,
} from "./types"

const mintId = (seq: number): string => `cand-${String(seq).padStart(4, "0")}`

export interface LocalizationTracker {
  addCandidate(input: CandidateInput): Candidate
  exclude(candidateId: string, reason: string, evidenceRefs?: readonly string[]): void
  selectPatchTarget(candidateId: string, rationale: string, evidenceRefs?: readonly string[]): void
  /** Candidates not excluded and not already selected, highest confidence first. */
  active(): readonly Candidate[]
  snapshot(): LocalizationPass
}

export const createLocalizationTracker = (): LocalizationTracker => {
  const candidates: Candidate[] = []
  const excluded: Exclusion[] = []
  const selected: PatchTarget[] = []
  const candidateIds = new Set<string>()
  const excludedIds = new Set<string>()
  const selectedIds = new Set<string>()
  let seq = 0

  const addCandidate = (input: CandidateInput): Candidate => {
    // Contract (adversarial-audit R1): reject malformed candidates loudly.
    if (!CANDIDATE_KINDS.has(input.kind))
      throw new Error(`localization: unknown candidate kind "${input.kind}"`)
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
      throw new Error(
        `localization: confidence must be a finite number in [0,1], got ${input.confidence}`,
      )
    seq += 1
    const id = input.id ?? mintId(seq)
    if (candidateIds.has(id)) throw new Error(`localization: duplicate candidate id "${id}"`)
    const c: Candidate = {
      id,
      kind: input.kind,
      ref: input.ref,
      confidence: input.confidence,
      evidenceRefs: input.evidenceRefs ?? [],
    }
    candidates.push(c)
    candidateIds.add(id)
    return c
  }

  /** A candidate must exist, and exclude/select are MUTUALLY EXCLUSIVE + idempotent-
   *  rejecting: you cannot exclude then select the same candidate (contradiction), nor
   *  record it twice. Fail-fast so the pass never holds a self-contradicting state. */
  const requireExclusiveUnseen = (candidateId: string, verb: string): void => {
    if (!candidateIds.has(candidateId))
      throw new Error(`localization: cannot ${verb} unknown candidate "${candidateId}"`)
    if (excludedIds.has(candidateId))
      throw new Error(`localization: candidate "${candidateId}" already excluded`)
    if (selectedIds.has(candidateId))
      throw new Error(`localization: candidate "${candidateId}" already selected`)
  }

  const exclude = (
    candidateId: string,
    reason: string,
    evidenceRefs: readonly string[] = [],
  ): void => {
    requireExclusiveUnseen(candidateId, "exclude")
    excluded.push({ candidateId, reason, evidenceRefs })
    excludedIds.add(candidateId)
  }

  const selectPatchTarget = (
    candidateId: string,
    rationale: string,
    evidenceRefs: readonly string[] = [],
  ): void => {
    requireExclusiveUnseen(candidateId, "select")
    selected.push({ candidateId, rationale, evidenceRefs })
    selectedIds.add(candidateId)
  }

  const active = (): readonly Candidate[] =>
    candidates
      .filter((c) => !excludedIds.has(c.id) && !selectedIds.has(c.id))
      .slice()
      // confidence is add-validated to a finite [0,1], so the compare is well-defined;
      // ties break by id (zero-padded ⇒ insertion order) via locale-independent
      // `byteCompare` — this ranking is model-facing, so the tiebreak must be
      // byte-stable across machines (localeCompare's ICU ordering is not).
      .sort((a, b) => b.confidence - a.confidence || byteCompare(a.id, b.id))

  const snapshot = (): LocalizationPass => ({
    candidates: candidates.slice(),
    excluded: excluded.slice(),
    selectedPatchTargets: selected.slice(),
  })

  return { addCandidate, exclude, selectPatchTarget, active, snapshot }
}
