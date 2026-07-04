/**
 * LocalizationPass builder (jul-5, SOTA++ P5) — pure narrowing over candidates.
 *
 * Deterministic ids (`cand-0001`, …, no clock/random). The tracker NARROWS: add candidates,
 * exclude with a reason+evidence, select patch targets. `active()` = candidates neither excluded
 * nor already selected — the working set the model reasons over. All queries are O(n) scans (n =
 * session candidates, small). The tracker organizes; it never auto-picks the fix.
 */

import type {
  Candidate,
  CandidateInput,
  Exclusion,
  LocalizationPass,
  PatchTarget,
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
  let seq = 0

  const addCandidate = (input: CandidateInput): Candidate => {
    seq += 1
    const c: Candidate = {
      id: input.id ?? mintId(seq),
      kind: input.kind,
      ref: input.ref,
      confidence: input.confidence,
      evidenceRefs: input.evidenceRefs ?? [],
    }
    candidates.push(c)
    return c
  }

  const exclude = (candidateId: string, reason: string, evidenceRefs: readonly string[] = []): void => {
    excluded.push({ candidateId, reason, evidenceRefs })
  }

  const selectPatchTarget = (
    candidateId: string,
    rationale: string,
    evidenceRefs: readonly string[] = [],
  ): void => {
    selected.push({ candidateId, rationale, evidenceRefs })
  }

  const active = (): readonly Candidate[] => {
    const out = new Set(excluded.map((e) => e.candidateId))
    for (const s of selected) out.add(s.candidateId)
    return candidates
      .filter((c) => !out.has(c.id))
      .slice()
      .sort((a, b) => b.confidence - a.confidence)
  }

  const snapshot = (): LocalizationPass => ({
    candidates: candidates.slice(),
    excluded: excluded.slice(),
    selectedPatchTargets: selected.slice(),
  })

  return { addCandidate, exclude, selectPatchTarget, active, snapshot }
}
