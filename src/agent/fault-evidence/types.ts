/**
 * T-201 — FaultEvidencePacket: a bench-only, bounded, typed "what to touch"
 * artifact. Deliberately NOT named `EvidencePacket` (that is the multilang
 * debugging packet in `src/tool/evidence/types.ts`).
 *
 * The packet carries only PATHS, SCORES, PROVENANCE and SYMBOL NAMES — never
 * raw source bodies — so it can be injected as a compact owner hint without the
 * unbounded raw-source blob the agentless hint path used to splat. It is built
 * BLIND: from the issue text + stage-1 ranking + bounded LSP owner-resolve,
 * never from hidden bench labels (FAIL_TO_PASS / test_patch / grader report).
 */

export type FaultCandidateSource = "stage1" | "issue-file" | "owner-resolve"

/**
 * T-OWN-12 — owner-evidence STRENGTH lattice (additive over `sources`).
 *
 *  - `authoritative`: at least one evidence stream is itself owner-authority:
 *      • `issue-file` — the file is NAMED in public issue text (a public,
 *        non-heuristic owner claim), or
 *      • a UNIQUE-symbol-defining `owner-resolve` (the file is the sole definer
 *        of an issue symbol). Uniqueness is not yet tracked on the candidate, so
 *        `owner-resolve` is treated as ADVISORY for now (see `ownerStrength`).
 *  - `advisory`: only heuristic/scored streams point at it (`stage1` ranking,
 *    non-unique `owner-resolve`). Advisory evidence may shape generation /
 *    family ordering but, in clean mode, can never admit or veto an owner.
 */
export type OwnerStrength = "authoritative" | "advisory"

export interface FaultCandidate {
  /** Repo-relative path. */
  file: string
  /** Deterministic merged rank score (higher = stronger owner signal).
   *  Heuristic/advisory only — clean owner admission MUST NOT read this. */
  score: number
  /** Which evidence streams pointed at this file (deduped, stable order). */
  sources: FaultCandidateSource[]
  /** Issue symbols resolved to this file (bounded; names only, no bodies). */
  symbols: string[]
}

export interface FaultEvidencePacket {
  /** Top-K owner candidates, score-desc with deterministic path tie-break. */
  candidates: FaultCandidate[]
  /** Bounded issue symbols (`extractSymbols`, capped). */
  issueSymbols: readonly string[]
  /** True when candidate or symbol windows were capped. */
  truncated: boolean
  /** True when an input stream was missing/empty (no stage-1, no LSP) — the
   *  packet is still usable, just incomplete. */
  partial: boolean
}

export interface FaultEvidenceInput {
  issueText: string
  /** Stage-1 ranked candidate files (blind localization). */
  stage1Files?: readonly { file: string; score: number }[]
  /** Files explicitly named in the issue (blind). */
  issueFiles?: readonly string[]
  /** Bounded LSP owner-resolve results (blind go-to-def). `undefined` ⇒ LSP
   *  was unavailable (=> partial); `[]` ⇒ available but resolved nothing. */
  ownerResolved?: readonly { file: string; forSymbol: string }[]
  maxCandidates?: number
  maxSymbols?: number
}
