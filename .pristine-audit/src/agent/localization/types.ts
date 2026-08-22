/**
 * Localization typed pass (jul-5, SOTA++ P5) — the typed state the review asked for:
 * Symptom → Candidates → Evidence expansion → Contradiction/Exclusion → Patch target.
 *
 * Today localization is scattered prompt-steer + tools (agentless-localize / forward-localize /
 * CHA-multisite / spec-steer) with no typed pass. This is the pure state layer: candidates carry
 * `evidenceRefs` (ids into the P1 {@link EvidenceLedger}), exclusions carry a reason + the evidence
 * that ruled them out, and selected patch targets carry a rationale. The engine NARROWS and LINKS;
 * the model still SELECTS (philosophy guard — same as the evidence layer).
 *
 * Slice-pure: no `@/llm` / `@/tool`. Candidate generation adapters (agentless / LSP / graph) live at
 * the edge and feed this layer already-extracted candidates. DEFAULT-OFF: inert until wired.
 */

/** What a candidate points at. Derived from the runtime list so the type and the
 *  validation Set never drift. */
const CANDIDATE_KIND_LIST = ["file", "symbol", "test", "call_path"] as const
export type CandidateKind = (typeof CANDIDATE_KIND_LIST)[number]
/** Runtime membership check — guards the candidate-generation edge (external adapters). */
export const CANDIDATE_KINDS: ReadonlySet<CandidateKind> = new Set(CANDIDATE_KIND_LIST)

/** A localization candidate — a place the fix might live, with its supporting evidence. */
export interface Candidate {
  readonly id: string
  readonly kind: CandidateKind
  /** file path / fully-qualified symbol / test id / call-path descriptor. */
  readonly ref: string
  /** 0..1 — relative belief, NOT a probability. The model still decides. */
  readonly confidence: number
  /** Ids of `EvidenceCard`s (format `ev-XXXX`) that put this candidate on the board.
   *  NOT validated cross-slice here — a pure layer has no ledger access — so the WIRING
   *  must ensure each ref exists in the EvidenceLedger before use (audit R2, intentional
   *  deferral; the same holds for evidenceRefs on Exclusion / PatchTarget). */
  readonly evidenceRefs: readonly string[]
}

/** A candidate ruled out, with WHY and the evidence that contradicted it. */
export interface Exclusion {
  readonly candidateId: string
  readonly reason: string
  readonly evidenceRefs: readonly string[]
}

/** A candidate selected as a place to edit, with the rationale. */
export interface PatchTarget {
  readonly candidateId: string
  readonly rationale: string
  readonly evidenceRefs: readonly string[]
}

/** The typed localization state for a session/pass — narrows over turns. */
export interface LocalizationPass {
  readonly candidates: readonly Candidate[]
  readonly excluded: readonly Exclusion[]
  readonly selectedPatchTargets: readonly PatchTarget[]
}

/** Candidate as submitted (id optional — the pass assigns a stable one if absent). */
export type CandidateInput = Omit<Candidate, "id" | "evidenceRefs"> & {
  readonly id?: string
  readonly evidenceRefs?: readonly string[]
}
