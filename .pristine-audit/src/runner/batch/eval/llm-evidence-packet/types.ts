/**
 * OPC-07 — typed, stage-scoped LLM evidence packet.
 *
 * Every LLM call in the selection pipeline declares exactly ONE `stage` and ONE
 * `question`, and receives a bounded, TYPED evidence packet. The inner evidence
 * fields are typed objects (not free-text bags) so a packet is self-describing
 * and an auditor can confirm, field by field, that no hidden benchmark artifact
 * leaked in (see {@link assertPacketBlind}).
 *
 * Authority: packets are ADVISORY. They improve local judgment inside an allowed
 * action menu. They never carry submit authority — deterministic proof rails
 * decide admission.
 */

export type LlmEvidencePacketStage =
  | "intake"
  | "candidate_generation"
  /**
   * LEGACY NAME. The live `candidate_review` use is a PRE-proof expansion risk
   * SCREEN (see llm-risk-gate.ts: "should the selector expand?"), not a post-exec
   * correctness review. Per OPC-07 minimum-scope it stays shadow/research only;
   * it is not part of the v4 proof-clean runtime authority.
   */
  | "candidate_review"
  /**
   * True POST-exec review surface over executed proof receipts. This is
   * advisory-only diagnosis for the repair round, not winner authority.
   */
  | "candidate_post_review"
  | "repair_seed"
  | "selection_explanation"
  /**
   * A10 — TRANSIENT router-input stage. NOT a stored artifact stage: it is the
   * `selection_explanation` evidence body RE-CONTRACTED for the adaptive PHASE
   * ROUTER (which asks "choose the next phase", not "explain the outcome"). A
   * packet wearing this stage carries a phase-DECISION question + the closed
   * routing action menu, so the model sees ONE coherent stage/question/action
   * contract matching its real consumer (the router prompt). It is never recorded
   * into {@link LlmEvidenceArtifacts} (report storage ignores it) — the report
   * keeps using the honest `selection_explanation` packet. See
   * {@link toPhaseRoutingContract}.
   */
  | "phase_routing"

/**
 * One labeled candidate definition/symbol slice. `label` is `file:line` of the
 * matched `def`/`class` so the LLM can tell co-located sites apart; `slice` is
 * the EXACT bounded block (same per-slice cap as the single-slice path).
 */
export interface OwnerSourceSlice {
  readonly label: string
  readonly slice: string
}

/**
 * A narrowed owner/fault site. `sourceSlice` is the EXACT definition/symbol
 * block resolved from public issue/static provenance — never a broad excerpt or
 * a whole file body. Absent slice ⇒ the caller emits a `missingEvidence` entry
 * rather than falling back to an unbounded window.
 */
export interface OwnerEvidenceFact {
  readonly file: string
  readonly symbols: readonly string[]
  /** e.g. "issue-file", "static-witness:override-family", "selection-owner". */
  readonly provenance: string
  readonly sourceSlice?: string
  /**
   * ALL candidate def/class slices when the owner symbol resolves to MORE THAN
   * ONE site (overload/redefinition) OR several issue symbols resolve in the
   * same file. Each entry is the bounded block for one site, labeled `file:line`.
   * Present so the model receives EVERY candidate site to disambiguate — instead
   * of the scaffold deterministically picking site 0. Each slice obeys the same
   * per-slice `maxLines` cap, so total size stays bounded. `sourceSlice` remains
   * the first/primary site for back-compat readers.
   */
  readonly sourceSlices?: readonly OwnerSourceSlice[]
  /**
   * B4: when no slice was resolved, WHY — `non_source` (binary/unreadable text)
   * vs `not_found` (readable source, symbol absent). Lets the caller emit a
   * specific missingEvidence reason instead of one undifferentiated gap.
   */
  readonly sliceMiss?: SymbolSliceMiss
  /**
   * B4: true when the resolved slice's symbol name matched MORE THAN ONE
   * def/class site (overload/redefinition) — the chosen slice is the first match
   * and therefore ambiguous; surfaced so the LLM/caller knows it may be the
   * wrong site rather than silently trusting it.
   */
  readonly ambiguousSliceMatch?: boolean
}

/** Observed state of a proof obligation. Separates infra failure from correctness. */
export type ProofReceiptState =
  | "base_red"
  | "base_green"
  | "candidate_green"
  | "candidate_red"
  | "execution_failed"
  | "env_prep_failed"
  | "static_only"
  | "not_run"

/**
 * B8 — EXPLICIT typed source-policy class. The free-string `source` is a
 * human-readable receipt identifier (e.g. `public_mwe`, `discovered_regression`,
 * `hard:proofRequiredMissing`, `selector_hard_reason`) and stays open because
 * deterministic reasons are generated dynamically. The POLICY — what kind of
 * evidence provenance this receipt represents, and therefore how the LLM may
 * trust/use it — is a CLOSED typed union:
 *
 *  - `public_issue`            — derived from the public issue / its repro seed.
 *  - `public_repro`            — an executed public reproduction (blind-by-construction script).
 *  - `public_discovered_test`  — a publicly-discovered regression/owner test (result only).
 *  - `static`                  — static analysis / structural witness, not executed.
 *  - `official_hidden_withheld`— official harness-derived; result MAY surface, command NEVER.
 *  - `infra`                   — execution/environment outcome, not a correctness verdict.
 *
 * Leaking a free string into `sourcePolicy` is a compile error — that is the
 * point: source provenance must be a deliberate, auditable classification.
 */
export type ProofReceiptSourcePolicy =
  | "public_issue"
  | "public_repro"
  | "public_discovered_test"
  | "static"
  | "official_hidden_withheld"
  | "infra"

export interface ProofReceiptFact {
  /**
   * Free-string receipt IDENTIFIER (open: `hard:*` reasons are dynamic). Use
   * {@link sourcePolicyOf} to derive the typed policy, or set `sourcePolicy`
   * explicitly at construction.
   */
  readonly source: string
  /** B8: EXPLICIT typed provenance/trust policy (closed union). */
  readonly sourcePolicy?: ProofReceiptSourcePolicy
  readonly state: ProofReceiptState
  readonly command?: string
  /**
   * B5 / C3 fence: set true for owner-test / module-smoke RESULT receipts whose
   * command MUST NOT be surfaced (it can encode a hidden-test path). When true,
   * `command` is always absent — the LLM sees the result STATE and its source
   * policy, never the executable selector. {@link ownerTestResultReceipt}
   * constructs these so the fence cannot be forgotten.
   */
  readonly cmdWithheld?: boolean
  readonly baseValidatedRed?: boolean
  readonly stdoutTail?: string
  readonly stderrTail?: string
  readonly candidatePatchHash?: string
}

export class ProofReceiptSourcePolicyError extends Error {
  constructor(readonly source: string) {
    super(`proof receipt source policy missing for source "${source}"`)
    this.name = "ProofReceiptSourcePolicyError"
  }
}

/** A typed, provenance-carrying selector contract fact (mirrors SelectionContract). */
export interface ContractFact {
  readonly contractId: string
  /** provenance/strength label — NEVER a hidden oracle. */
  readonly authority: string
  readonly satisfied: boolean | "unknown"
}

export interface StaticFact {
  readonly kind: string
  readonly value: string
}

export interface MissingEvidenceFact {
  readonly kind: string
  readonly reason: string
}

/**
 * One step of the typed VerificationPlan, flattened for the LLM. `cmd` is
 * OPTIONAL by design: only blind-by-construction `repro` step commands (a
 * synthesized sandbox-temp script) are ever surfaced. Non-repro step commands
 * (`owner-test`/`module-smoke`) are withheld because their command can be a path
 * to a hidden test — a leak `assertPacketBlind` cannot catch (it scans for
 * uppercase dataset keys, not paths). The successPredicate is always just the
 * discriminant `.type` (never its selector/substring), so it is leak-free.
 */
export interface VerificationStepFact {
  readonly kind: string
  readonly cmd?: string
  readonly cmdWithheld?: boolean
  readonly authority?: string
  readonly successPredicate?: string
}

/**
 * The active proof target: "what public evidence must this candidate satisfy
 * before it is admissible." Derived from the typed `VerificationPlan`.
 */
export interface VerificationTargetFact {
  readonly primaryRail: VerificationStepFact | null
  readonly required: readonly VerificationStepFact[]
  readonly optional: readonly VerificationStepFact[]
  readonly baseValidatedRed: boolean
}

/**
 * The candidate's OWN edit surface — SOURCE-ONLY facts derived from the
 * candidate's unified diff (`filesFromUnifiedDiff` / `diffTouchedSymbols`). It
 * lets the LLM/router tell whether the candidate actually touched the
 * owner/proof surface. ANSWER-KEY FENCE: never a hidden-test path, never an
 * executable command — only the files/symbols the candidate's own diff edits,
 * plus an OPTIONAL bounded summary (never the full diff). Blindness-scanned like
 * every other evidence field (see {@link evidenceStrings}).
 */
export interface CandidateEditSurfaceFact {
  readonly touchedFiles: readonly string[]
  readonly touchedSymbols: readonly string[]
  /** OPTIONAL bounded, source-only patch SUMMARY — never the full diff. */
  readonly patchSummary?: string
}

export interface LlmEvidencePacket {
  readonly stage: LlmEvidencePacketStage
  readonly instanceIdHash: string
  readonly evidenceRevision: string
  readonly candidatePatchHash?: string
  readonly question: string
  readonly allowedActions: readonly string[]
  readonly forbiddenSources: readonly string[]
  readonly publicIssueFacts: readonly string[]
  readonly ownerEvidence: readonly OwnerEvidenceFact[]
  readonly proofReceipts: readonly ProofReceiptFact[]
  readonly contractFacts: readonly ContractFact[]
  readonly staticFacts: readonly StaticFact[]
  readonly verificationTarget?: VerificationTargetFact
  /** SOURCE-ONLY candidate edit surface (candidate-local packets only). */
  readonly candidateEditSurface?: CandidateEditSurfaceFact
  readonly missingEvidence: readonly MissingEvidenceFact[]
}

export interface LlmEvidenceArtifacts {
  readonly intake?: LlmEvidencePacket
  readonly candidateReview?: LlmEvidencePacket
  readonly candidateReviewHistory?: readonly LlmEvidencePacket[]
  readonly candidatePostReview?: LlmEvidencePacket
  readonly candidatePostReviewHistory?: readonly LlmEvidencePacket[]
  readonly candidateGeneration?: LlmEvidencePacket
  readonly candidateGenerationHistory?: readonly LlmEvidencePacket[]
  readonly repairSeed?: LlmEvidencePacket
  readonly repairSeedHistory?: readonly LlmEvidencePacket[]
  readonly selectionExplanation?: LlmEvidencePacket
  readonly selectionExplanationHistory?: readonly LlmEvidencePacket[]
}

export type LlmEvidenceRevisionByStage = Readonly<Partial<Record<LlmEvidencePacketStage, string>>>

export interface LlmEvidencePacketCounts {
  readonly candidateGeneration: number
  readonly repairSeed: number
  readonly selectionExplanation: number
}

export interface LlmEvidenceSummary {
  readonly stages: readonly LlmEvidencePacketStage[]
  readonly revisionByStage: LlmEvidenceRevisionByStage
  readonly missingKinds: readonly string[]
}

/**
 * B4: distinguishable empty-return reason for {@link extractSymbolSliceResult}.
 *  - `not_found`        — the source IS readable text but no `def`/`class <symbol>` matched.
 *  - `non_source`       — the source looks binary / non-text (e.g. NUL bytes), so a
 *                         Python regex cannot meaningfully run; the absence is NOT
 *                         "symbol missing" — it is "no source language to inspect".
 * A typed reason lets callers emit a SPECIFIC missingEvidence (binary file vs.
 * symbol-not-in-file) instead of conflating both into a single `undefined`.
 */
export type SymbolSliceMiss = "not_found" | "non_source"

export interface SymbolSliceResult {
  /** Present iff a matching def/class block was resolved (FIRST site, back-compat). */
  readonly slice?: string
  /**
   * ALL matching def/class sites, each a bounded block labeled `<symbol>@line`.
   * Present when a slice resolved. Lets callers surface every candidate site
   * (not just `slice`) so an ambiguous symbol is disambiguated by the model, not
   * by the scaffold. Empty/absent when nothing resolved.
   */
  readonly slices?: readonly OwnerSourceSlice[]
  /** Present iff no slice — distinguishes binary/non-source from genuine not-found. */
  readonly miss?: SymbolSliceMiss
  /**
   * B4: count of DISTINCT def/class sites that matched this symbol name. >1 means
   * the returned slice is ambiguous (same-name overload/redefinition); callers can
   * surface this instead of silently taking the first match.
   */
  readonly matchCount: number
}
