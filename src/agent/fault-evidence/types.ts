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

export type FaultCandidateSource = "stage1" | "issue-file" | "owner-resolve" | "static-witness"

/**
 * T-OWN-12 — owner-evidence STRENGTH lattice (additive over `sources`).
 *
 *  - `authoritative`: at least one evidence stream is itself owner-authority:
 *      • `issue-file` — the file is NAMED in public issue text (a public,
 *        non-heuristic owner claim), or
 *      • `static-witness` — the file is named by a TYPED-RELATION static witness
 *        that confers clean owner authority (SCAFF-03): a unique symbol definer,
 *        a complete override family, or a both-ends producer/consumer. This is
 *        the provenance that finally tracks the "unique definer" the legacy
 *        `owner-resolve` stream could only guess at.
 *      • a UNIQUE-symbol-defining `owner-resolve` (the file is the sole definer
 *        of an issue symbol). Uniqueness is not tracked on a bare `owner-resolve`
 *        candidate, so `owner-resolve` ALONE is treated as ADVISORY (see
 *        `ownerStrength`); the typed `static-witness` stream supersedes it.
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
  /** SCAFF-03 — authoritative owner files derived from TYPED-RELATION static
   *  witnesses (unique definer / complete override family / both-ends
   *  producer-consumer). Generic on purpose: the bench adapter digests its
   *  witness IR down to plain `{ file, forSymbol? }` records so this pure agent
   *  domain stays free of any benchmark-shaped coupling. Each entry's file is
   *  AUTHORITATIVE (carries the `static-witness` source). Omitted/empty ⇒ no
   *  witness owners (behavior byte-identical to before SCAFF-03). */
  witnessOwners?: readonly { file: string; forSymbol?: string }[]
  maxCandidates?: number
  maxSymbols?: number
}
