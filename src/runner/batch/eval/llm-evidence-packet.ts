import { createHash } from "node:crypto"
import type { FaultEvidencePacket } from "@/agent/fault-evidence"
import { extractIssueHint } from "@/agent/issue-hint"
import type { VerificationPlan, VerificationStep } from "@/agent/verification-plan"
import { extractIssueReproSeed } from "@/agent/verification-plan"
import { normalizePublicIssueText } from "@/shared"
import type { MweProofState } from "./mwe-proof"
import type { ReproConsensusProofState } from "./repair/resolved-consensus"
import type { PublicRegressionProofState } from "./repo-regression-discovery-adapter"
import type { SelectionProofSource, SelectionProofState } from "./selection-types"
import type { StaticWitness } from "./static-witness"
import type { StaticWitnessDiagnostic } from "./static-witness-adapter"

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

/**
 * B8: map a known free-string receipt `source` identifier to its typed policy
 * class. Unknown identifiers (including dynamic `hard:*` deterministic reasons)
 * return undefined — producers that KNOW the provenance should set `sourcePolicy`
 * explicitly rather than rely on inference. ANSWER-KEY SAFE: pure classification
 * of an already-blind identifier, no test/command text.
 */
export const sourcePolicyOf = (source: string): ProofReceiptSourcePolicy | undefined => {
  if (source.startsWith("hard:")) return "static"
  switch (source) {
    case "public_mwe":
    case "public_repro":
      return "public_repro"
    case "repro_consensus":
      return "public_repro"
    case "discovered_regression":
    case "public_discovered_test":
      return "public_discovered_test"
    case "owner_test":
    case "module_smoke":
      return "official_hidden_withheld"
    case "verify_cmd":
    case "primary_rail":
    case "validation_gate":
      return "public_repro"
    case "selection":
      return "static"
    default:
      return undefined
  }
}

/**
 * B5: an owner-test / module-smoke RESULT receipt — RESULT ONLY, command always
 * WITHHELD (C3 anti-gaming fence). The LLM/router learns whether the owner test
 * or module smoke went green/red and from which source policy, but NEVER the
 * executable selector (which can encode a hidden-test path the content scanner
 * cannot catch). `command` is structurally impossible to set here; `cmdWithheld`
 * is always true.
 *
 *  - kind `owner_test`   ⇒ source `owner_test`,   policy `official_hidden_withheld`
 *  - kind `module_smoke` ⇒ source `module_smoke`, policy `official_hidden_withheld`
 *
 * `result` maps to a correctness/infra STATE: green/red are candidate verdicts,
 * `infra_failed` is a non-correctness execution outcome, `not_run` is absence.
 */
export const ownerTestResultReceipt = (args: {
  readonly kind: "owner_test" | "module_smoke"
  readonly result: "green" | "red" | "infra_failed" | "not_run"
}): ProofReceiptFact => {
  const state: ProofReceiptState =
    args.result === "green"
      ? "candidate_green"
      : args.result === "red"
        ? "candidate_red"
        : args.result === "infra_failed"
          ? "execution_failed"
          : "not_run"
  return {
    source: args.kind,
    sourcePolicy: "official_hidden_withheld",
    state,
    cmdWithheld: true,
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

type MutableLlmEvidenceArtifacts = {
  intake?: LlmEvidencePacket
  candidateReview?: LlmEvidencePacket
  candidateReviewHistory?: LlmEvidencePacket[]
  candidatePostReview?: LlmEvidencePacket
  candidatePostReviewHistory?: LlmEvidencePacket[]
  candidateGeneration?: LlmEvidencePacket
  candidateGenerationHistory?: LlmEvidencePacket[]
  repairSeed?: LlmEvidencePacket
  repairSeedHistory?: LlmEvidencePacket[]
  selectionExplanation?: LlmEvidencePacket
  selectionExplanationHistory?: LlmEvidencePacket[]
}

/* ------------------------------------------------------------------ */
/* Benchmark-blindness guard (HARD)                                    */
/* ------------------------------------------------------------------ */

/**
 * Structural SWE-bench dataset KEYS. These uppercase identifiers are not
 * natural-language tokens — their presence inside an evidence field means a
 * hidden-oracle leak (a dataset record was stringified into the packet). They
 * have zero false-positive risk in legitimate public issue prose, so the guard
 * can THROW on them even on the live path. (Lowercase field names like
 * `test_patch` are intentionally NOT listed: they collide with ordinary issue
 * prose, and a throw on the live intake path would fail a real instance. The
 * structural defense against those is construction-time discipline — builders
 * only consume the allowed blind inputs — not a content scan.)
 *
 * Matched only against evidence content, never the meta menu (`forbiddenSources`
 * legitimately *names* `gold_patch` as a thing the LLM must not use).
 */
export const FORBIDDEN_PACKET_MARKERS: readonly string[] = ["FAIL_TO_PASS", "PASS_TO_PASS"]

export class PacketBlindnessViolation extends Error {
  constructor(
    readonly marker: string,
    readonly stage: LlmEvidencePacketStage,
  ) {
    super(`packet blindness violation: forbidden marker "${marker}" leaked into ${stage} evidence`)
    this.name = "PacketBlindnessViolation"
  }
}

export const assertEvidenceTextBlind = (
  stage: LlmEvidencePacketStage,
  values: readonly (string | undefined)[],
): void => {
  for (const marker of FORBIDDEN_PACKET_MARKERS) {
    if (values.some((value) => value?.includes(marker) === true)) {
      throw new PacketBlindnessViolation(marker, stage)
    }
  }
}

/** All strings drawn from EVIDENCE fields only (not the meta action menu). */
const ownerEvidenceStrings = (o: OwnerEvidenceFact): string[] => [
  o.file,
  o.provenance,
  ...o.symbols,
  ...(o.sourceSlice !== undefined ? [o.sourceSlice] : []),
  // Every multi-site slice (and its label) is rendered to the LLM, so it must
  // also pass the blindness scan — no candidate site escapes the gold guard.
  ...(o.sourceSlices ?? []).flatMap((s) => [s.label, s.slice]),
]

const proofReceiptStrings = (r: ProofReceiptFact): string[] => [
  r.source,
  r.state,
  ...(r.command !== undefined ? [r.command] : []),
  ...(r.stdoutTail !== undefined ? [r.stdoutTail] : []),
  ...(r.stderrTail !== undefined ? [r.stderrTail] : []),
]

const candidateEditSurfaceStrings = (surface: CandidateEditSurfaceFact | undefined): string[] =>
  surface === undefined
    ? []
    : [
        ...surface.touchedFiles,
        ...surface.touchedSymbols,
        ...(surface.patchSummary !== undefined ? [surface.patchSummary] : []),
      ]

const verificationStepStrings = (step: VerificationStepFact): string[] => [
  ...(step.cmd !== undefined ? [step.cmd] : []),
  ...(step.successPredicate !== undefined ? [step.successPredicate] : []),
]

const verificationTargetStrings = (target: VerificationTargetFact | undefined): string[] =>
  target === undefined
    ? []
    : [
        ...(target.primaryRail !== null ? [target.primaryRail] : []),
        ...target.required,
        ...target.optional,
      ].flatMap(verificationStepStrings)

const evidenceStrings = (packet: LlmEvidencePacket): string[] => [
  ...packet.publicIssueFacts,
  ...packet.ownerEvidence.flatMap(ownerEvidenceStrings),
  ...packet.proofReceipts.flatMap(proofReceiptStrings),
  ...packet.contractFacts.flatMap((c) => [c.contractId, c.authority]),
  ...packet.staticFacts.flatMap((s) => [s.kind, s.value]),
  ...packet.missingEvidence.flatMap((m) => [m.kind, m.reason]),
  ...candidateEditSurfaceStrings(packet.candidateEditSurface),
  ...verificationTargetStrings(packet.verificationTarget),
]

/**
 * Throw if any forbidden benchmark marker leaked into an evidence field. HARD
 * guard (the easiest place to reintroduce answer-key leakage). A leak is a
 * construction bug that would corrupt measurement, so it fails LOUD rather than
 * silently scrubbing. Scans evidence only; the action menu may still name
 * forbidden sources. Run by every packet through {@link cleanPacket}.
 */
export const assertPacketBlind = (packet: LlmEvidencePacket): LlmEvidencePacket => {
  assertEvidenceTextBlind(packet.stage, evidenceStrings(packet))
  return packet
}

/* ------------------------------------------------------------------ */
/* Hashing + clean + render                                            */
/* ------------------------------------------------------------------ */

const uniqueLines = (values: readonly string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const value = raw.trim()
    if (value === "" || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

const uniqueObjects = <T>(values: readonly T[]): T[] => {
  const seen = new Set<string>()
  const out: T[] = []
  for (const v of values) {
    const key = JSON.stringify(v)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

export const stableHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16)

export const opaqueInstanceIdHash = (problemStatement: string): string =>
  stableHash(problemStatement.trim())

export const candidatePatchHash = (patch: string): string => stableHash(patch)

const normalizeProofReceipt = (receipt: ProofReceiptFact): ProofReceiptFact => {
  if (receipt.sourcePolicy !== undefined) return receipt
  const sourcePolicy = sourcePolicyOf(receipt.source)
  if (sourcePolicy === undefined) throw new ProofReceiptSourcePolicyError(receipt.source)
  return { ...receipt, sourcePolicy }
}

/** Normalize + dedupe + HARD blindness check. Idempotent. */
export const cleanPacket = (packet: LlmEvidencePacket): LlmEvidencePacket =>
  assertPacketBlind({
    ...packet,
    allowedActions: uniqueLines(packet.allowedActions),
    forbiddenSources: uniqueLines(packet.forbiddenSources),
    publicIssueFacts: uniqueLines(packet.publicIssueFacts),
    ownerEvidence: uniqueObjects(packet.ownerEvidence),
    proofReceipts: uniqueObjects(packet.proofReceipts).map(normalizeProofReceipt),
    contractFacts: uniqueObjects(packet.contractFacts),
    staticFacts: uniqueObjects(packet.staticFacts),
    missingEvidence: uniqueObjects(packet.missingEvidence),
  })

/** Render the typed packet for prompt injection. */
export const renderLlmEvidencePacket = (packet: LlmEvidencePacket): string =>
  [
    "## LLM Evidence Packet",
    "Use only the bounded packet below. Do not assume hidden tests, gold patches, benchmark labels, or undocumented authority.",
    "```json",
    JSON.stringify(cleanPacket(packet), null, 2),
    "```",
  ].join("\n")

const LLM_EVIDENCE_STAGE_ORDER: readonly LlmEvidencePacketStage[] = [
  "intake",
  "candidate_generation",
  "candidate_review",
  "candidate_post_review",
  "repair_seed",
  "selection_explanation",
]

const singletonPacket = (packet: LlmEvidencePacket | undefined): readonly LlmEvidencePacket[] =>
  packet === undefined ? [] : [packet]

const packetHistory = (
  current: LlmEvidencePacket | undefined,
  history: readonly LlmEvidencePacket[] | undefined,
): readonly LlmEvidencePacket[] =>
  history !== undefined && history.length > 0 ? history : singletonPacket(current)

const STAGE_PACKET_READERS: Readonly<
  Partial<
    Record<
      LlmEvidencePacketStage,
      (artifacts: LlmEvidenceArtifacts) => readonly LlmEvidencePacket[]
    >
  >
> = {
  intake: (artifacts) => singletonPacket(artifacts.intake),
  candidate_review: (artifacts) =>
    packetHistory(artifacts.candidateReview, artifacts.candidateReviewHistory),
  candidate_post_review: (artifacts) =>
    packetHistory(artifacts.candidatePostReview, artifacts.candidatePostReviewHistory),
  candidate_generation: (artifacts) =>
    packetHistory(artifacts.candidateGeneration, artifacts.candidateGenerationHistory),
  repair_seed: (artifacts) => packetHistory(artifacts.repairSeed, artifacts.repairSeedHistory),
  selection_explanation: (artifacts) =>
    packetHistory(artifacts.selectionExplanation, artifacts.selectionExplanationHistory),
}

const stagePackets = (
  artifacts: LlmEvidenceArtifacts,
  stage: LlmEvidencePacketStage,
): readonly LlmEvidencePacket[] => STAGE_PACKET_READERS[stage]?.(artifacts) ?? []

const packetsFromArtifacts = (artifacts: LlmEvidenceArtifacts): readonly LlmEvidencePacket[] =>
  LLM_EVIDENCE_STAGE_ORDER.flatMap((stage) => stagePackets(artifacts, stage))

export const llmEvidencePacketCounts = (
  artifacts: LlmEvidenceArtifacts | undefined,
): LlmEvidencePacketCounts | undefined => {
  if (artifacts === undefined) return undefined
  const candidateGeneration = stagePackets(artifacts, "candidate_generation").length
  const repairSeed = stagePackets(artifacts, "repair_seed").length
  const selectionExplanation = stagePackets(artifacts, "selection_explanation").length
  if (candidateGeneration === 0 && repairSeed === 0 && selectionExplanation === 0) return undefined
  return { candidateGeneration, repairSeed, selectionExplanation }
}

export const summarizeLlmEvidenceArtifacts = (
  artifacts: LlmEvidenceArtifacts | undefined,
): LlmEvidenceSummary | undefined => {
  if (artifacts === undefined) return undefined
  const packets = packetsFromArtifacts(artifacts)
  if (packets.length === 0) return undefined
  const revisionByStage: Partial<Record<LlmEvidencePacketStage, string>> = {}
  for (const packet of packets) revisionByStage[packet.stage] = packet.evidenceRevision
  return {
    stages: LLM_EVIDENCE_STAGE_ORDER.filter((stage) => stagePackets(artifacts, stage).length > 0),
    revisionByStage,
    missingKinds: uniqueLines(
      packets.flatMap((packet) => packet.missingEvidence.map((missing) => missing.kind)),
    ),
  }
}

type PacketSingletonKey =
  | "candidateReview"
  | "candidatePostReview"
  | "candidateGeneration"
  | "repairSeed"
  | "selectionExplanation"

type PacketHistoryKey =
  | "candidateReviewHistory"
  | "candidatePostReviewHistory"
  | "candidateGenerationHistory"
  | "repairSeedHistory"
  | "selectionExplanationHistory"

const recordHistoricalPacket = (
  sink: MutableLlmEvidenceArtifacts,
  packet: LlmEvidencePacket,
  singletonKey: PacketSingletonKey,
  historyKey: PacketHistoryKey,
): void => {
  const current = sink[singletonKey]
  if (current === undefined) {
    sink[singletonKey] = packet
    sink[historyKey] = [packet]
    return
  }
  sink[historyKey] = [...(sink[historyKey] ?? [current]), packet]
}

export const recordLlmEvidencePacket = (
  artifacts: Partial<LlmEvidenceArtifacts>,
  packet: LlmEvidencePacket,
): void => {
  const sink = artifacts as MutableLlmEvidenceArtifacts
  if (packet.stage === "intake" && sink.intake === undefined) sink.intake = packet
  if (packet.stage === "candidate_review") {
    recordHistoricalPacket(sink, packet, "candidateReview", "candidateReviewHistory")
  }
  if (packet.stage === "candidate_post_review") {
    recordHistoricalPacket(sink, packet, "candidatePostReview", "candidatePostReviewHistory")
  }
  if (packet.stage === "candidate_generation") {
    recordHistoricalPacket(sink, packet, "candidateGeneration", "candidateGenerationHistory")
  }
  if (packet.stage === "repair_seed") {
    recordHistoricalPacket(sink, packet, "repairSeed", "repairSeedHistory")
  }
  if (packet.stage === "selection_explanation") {
    recordHistoricalPacket(sink, packet, "selectionExplanation", "selectionExplanationHistory")
  }
}

/* ------------------------------------------------------------------ */
/* Typed evidence assembly helpers (shared by all builders)            */
/* ------------------------------------------------------------------ */

/**
 * Per-file `owner_slice` missingEvidence for owners whose source slice could not
 * be resolved (B2). SAME emission `candidate_generation` already does
 * (llm-evidence-packet.ts), now SHARED so repair_seed / candidate_post_review
 * make a missing slice VISIBLE instead of silently dropping it.
 */
export const ownerSliceMissingEvidence = (
  ownerEvidence: readonly OwnerEvidenceFact[],
): MissingEvidenceFact[] => {
  const filesWithSlice = new Set(
    ownerEvidence.filter((o) => o.sourceSlice !== undefined).map((o) => o.file),
  )
  const seenMissing = new Set<string>()
  return ownerEvidence
    .filter((o) => o.sourceSlice === undefined && !filesWithSlice.has(o.file))
    .filter((o) => {
      if (seenMissing.has(o.file)) return false
      seenMissing.add(o.file)
      return true
    })
    .map((o) => ({
      kind: "owner_slice",
      // B4: distinguish a binary/non-source file from a genuine symbol-not-found.
      // Default (not_found / unknown) keeps the established `no_resolvable_slice:`
      // reason so existing consumers/tests stay stable.
      reason:
        o.sliceMiss === "non_source"
          ? `non_source_file:${o.file}`
          : `no_resolvable_slice:${o.file}`,
    }))
}

export const staticWitnessDiagnosticsFacts = (
  diagnostics: readonly StaticWitnessDiagnostic[] | undefined,
): {
  readonly staticFacts: readonly StaticFact[]
  readonly missingEvidence: readonly MissingEvidenceFact[]
} => {
  if (diagnostics === undefined || diagnostics.length === 0) {
    return { staticFacts: [], missingEvidence: [] }
  }
  return {
    staticFacts: diagnostics.map((diagnostic) => ({
      kind: diagnostic.kind,
      value: `${diagnostic.file}: ${diagnostic.reason}`,
    })),
    missingEvidence: diagnostics.map((diagnostic) => ({
      kind: "static_witness",
      reason: `${diagnostic.kind}:${diagnostic.file}`,
    })),
  }
}

const firstNonEmptyLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)

const boundHead = (text: string, max = 220): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

const boundTail = (text: string, max = 220): string =>
  text.length <= max ? text : `…${text.slice(-Math.max(0, max - 1))}`

const fmtList = (values: readonly string[], empty = "<none>"): string =>
  values.length === 0 ? empty : values.join(", ")

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Actual normalized public issue facts — never a placeholder pointer. */
export const describeIssueFacts = (
  problemStatement: string,
  stage: LlmEvidencePacketStage = "intake",
): string[] => {
  assertEvidenceTextBlind(stage, [problemStatement])
  const normalized = normalizePublicIssueText(problemStatement)?.trim() ?? problemStatement.trim()
  const hint = extractIssueHint(problemStatement)
  return [
    `issue summary: ${boundHead(firstNonEmptyLine(normalized) ?? "<empty issue text>")}`,
    `issue symbols: ${fmtList(hint.symbols)}`,
    `issue files: ${fmtList(hint.files)}`,
  ]
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

/**
 * Heuristic-free binary/non-source probe: a NUL byte never appears in legitimate
 * UTF-8 source text, so its presence means the "source" is not inspectable as
 * Python. (We deliberately do NOT guess by extension or content patterns — only
 * the unambiguous NUL signal, which has zero false positives in real source.)
 */
const NUL_CHAR = String.fromCharCode(0)
const looksNonSource = (source: string): boolean => source.includes(NUL_CHAR)

/**
 * B4: file-level slice-miss classification. Given the file source (null when
 * unreadable) and whichever per-symbol resolution succeeded, returns the
 * distinguishable miss reason, or undefined when a slice WAS resolved.
 *  - resolved slice present ⇒ undefined (no miss).
 *  - source null/unreadable ⇒ undefined (handled by other missingEvidence, not a slice miss).
 *  - binary/non-source file ⇒ `non_source`.
 *  - readable source, symbol absent ⇒ `not_found`.
 */
const sliceMissForFile = (
  source: string | null,
  resolved: SymbolSliceResult | undefined,
): SymbolSliceMiss | undefined => {
  if (resolved?.slice !== undefined) return undefined
  if (source === null) return undefined
  return looksNonSource(source) ? "non_source" : "not_found"
}

/**
 * B4: precise, distinguishable symbol-slice resolution.
 *  1. Walks BACKWARD over contiguous `@decorator` lines directly above the matched
 *     `def`/`class` and includes them (the decorator is often the fix site).
 *  2. Reports `matchCount` so an ambiguous same-name redefinition is visible
 *     instead of silently returning the first match.
 *  3. Returns a typed `miss` (`non_source` vs `not_found`) so callers can emit a
 *     specific missingEvidence reason rather than conflating both as `undefined`.
 * Bounded by `maxLines` (decorators included in the budget).
 */
export const extractSymbolSliceResult = (
  source: string,
  symbol: string,
  maxLines = 40,
): SymbolSliceResult => {
  if (looksNonSource(source)) return { miss: "non_source", matchCount: 0 }
  const lines = source.split(/\r?\n/)
  const matches = symbolDefinitionMatches(lines, symbol)
  if (matches.length === 0) return { miss: "not_found", matchCount: 0 }
  const chosen = matches[0]
  if (chosen === undefined) return { miss: "not_found", matchCount: 0 }
  // EVERY matching site as its own bounded, labeled slice — so an ambiguous
  // symbol surfaces all candidate sites to the model, not just site 0. Each
  // slice is independently capped by `maxLines`.
  const slices: OwnerSourceSlice[] = matches.map((match) => ({
    label: `${symbol}@${match.index + 1}`,
    slice: symbolBlockLines(lines, match, maxLines).join("\n").trimEnd(),
  }))
  return {
    // `chosen` is non-undefined, so the first slice always exists.
    slice: symbolBlockLines(lines, chosen, maxLines).join("\n").trimEnd(),
    slices,
    matchCount: matches.length,
  }
}

const symbolDefinitionMatches = (
  lines: readonly string[],
  symbol: string,
): { readonly index: number; readonly indent: number }[] => {
  const re = new RegExp(`^(\\s*)(?:async\\s+)?(?:def|class)\\s+${escapeRe(symbol)}\\b`)
  return lines.flatMap((line, index) => {
    const m = line.match(re)
    return m === null ? [] : [{ index, indent: (m[1] ?? "").length }]
  })
}

const decoratorLinesBefore = (
  lines: readonly string[],
  index: number,
  indent: number,
  maxLines: number,
): readonly string[] => {
  const decoratorLines: string[] = []
  for (let k = index - 1; k >= 0; k--) {
    const prev = lines[k]
    if (prev === undefined) break
    const trimmed = prev.trim()
    if (trimmed === "") break
    const prevIndent = prev.length - prev.trimStart().length
    if (prevIndent !== indent || !trimmed.startsWith("@")) break
    decoratorLines.unshift(prev)
  }
  // BOUND: decorators + def must fit in maxLines. If a pathological decorator
  // stack overflows the budget, keep the def and the decorators CLOSEST to it
  // (the rest are dropped) — never exceed maxLines.
  const decoratorBudget = Math.max(0, maxLines - 1)
  const keptDecorators =
    decoratorLines.length > decoratorBudget
      ? decoratorLines.slice(decoratorLines.length - decoratorBudget)
      : decoratorLines
  return keptDecorators
}

const bodyLinesAfterDefinition = (
  lines: readonly string[],
  index: number,
  indent: number,
  remainingLines: number,
): readonly string[] => {
  const block: string[] = []
  for (let j = index + 1; j < lines.length && block.length < remainingLines; j++) {
    const ln = lines[j]
    if (ln === undefined) break
    if (ln.trim() === "") {
      block.push(ln)
      continue
    }
    const curIndent = ln.length - ln.trimStart().length
    if (curIndent <= indent) break
    block.push(ln)
  }
  return block
}

const symbolBlockLines = (
  lines: readonly string[],
  match: { readonly index: number; readonly indent: number },
  maxLines: number,
): readonly string[] => {
  const decorators = decoratorLinesBefore(lines, match.index, match.indent, maxLines)
  const definition = lines[match.index]
  if (definition === undefined) return decorators
  const remaining = Math.max(0, maxLines - decorators.length - 1)
  return [
    ...decorators,
    definition,
    ...bodyLinesAfterDefinition(lines, match.index, match.indent, remaining),
  ]
}

/**
 * Exact definition/symbol block for a Python `def`/`class` symbol — the bounded
 * source slice rule (no broad windows, no whole-file bodies). Returns undefined
 * when the symbol is not statically resolvable in the source. Thin back-compat
 * wrapper over {@link extractSymbolSliceResult} (now decorator-aware).
 */
export const extractSymbolSlice = (
  source: string,
  symbol: string,
  maxLines = 40,
): string | undefined => extractSymbolSliceResult(source, symbol, maxLines).slice

/**
 * Build typed owner evidence from owner files + issue symbols. When a sandbox
 * reader is supplied, attaches the EXACT symbol slice for each issue symbol
 * statically defined in the file (bounded). No reader / no resolvable symbol ⇒
 * path + symbols only (caller may add `missingEvidence` for the missing slice).
 */
export const assembleOwnerEvidence = (args: {
  readonly ownerFiles: readonly string[]
  readonly issueSymbols?: readonly string[]
  readonly provenance?: string
  readonly readSource?: (rel: string) => string | null
}): OwnerEvidenceFact[] => {
  const provenance = args.provenance ?? "selection-owner"
  const issueSymbols = args.issueSymbols ?? []
  return args.ownerFiles.flatMap((file) =>
    file.trim() === ""
      ? []
      : [
          ownerEvidenceFact({
            file,
            provenance,
            issueSymbols,
            source: args.readSource?.(file) ?? null,
          }),
        ],
  )
}

const symbolDefinedInSource = (source: string, symbol: string): boolean =>
  new RegExp(`^\\s*(?:async\\s+)?(?:def|class)\\s+${escapeRe(symbol)}\\b`, "m").test(source)

const definedIssueSymbols = (source: string | null, issueSymbols: readonly string[]): string[] =>
  source === null ? [] : issueSymbols.filter((symbol) => symbolDefinedInSource(source, symbol))

/**
 * Resolve issue symbols to bounded slices. Returns the FIRST resolved result
 * (for back-compat `slice`/`matchCount`/`miss`) PLUS `allSlices`: the union of
 * EVERY resolved site across EVERY symbol (each label already file-local as
 * `<symbol>@line`, here re-labeled below by caller). When more than one site
 * resolves, the caller surfaces them all so the model — not the scaffold —
 * picks the right one.
 */
const resolvedSymbolSlices = (
  source: string | null,
  symbols: readonly string[],
): { readonly first?: SymbolSliceResult; readonly allSlices: readonly OwnerSourceSlice[] } => {
  if (source === null) return { allSlices: [] }
  const resolved = symbols
    .map((symbol) => extractSymbolSliceResult(source, symbol))
    .filter((r) => r.slice !== undefined)
  const first = resolved[0]
  return {
    ...(first !== undefined ? { first } : {}),
    allSlices: resolved.flatMap((r) => r.slices ?? []),
  }
}

const ownerEvidenceFact = (args: {
  readonly file: string
  readonly provenance: string
  readonly issueSymbols: readonly string[]
  readonly source: string | null
}): OwnerEvidenceFact => {
  const symbols = definedIssueSymbols(args.source, args.issueSymbols)
  const { first: resolved, allSlices } = resolvedSymbolSlices(args.source, symbols)
  const miss = sliceMissForFile(args.source, resolved)
  return {
    file: args.file,
    symbols,
    provenance: args.provenance,
    ...(resolved?.slice !== undefined ? { sourceSlice: resolved.slice } : {}),
    ...multiSiteSlicesField(args.file, allSlices),
    ...(resolved !== undefined && resolved.matchCount > 1 ? { ambiguousSliceMatch: true } : {}),
    ...(miss !== undefined ? { sliceMiss: miss } : {}),
  }
}

/**
 * Build the `sourceSlices` field ONLY when there are multiple candidate sites —
 * one site is already fully carried by `sourceSlice`, so duplicating it would
 * just bloat the packet. Each label is prefixed with the owner file so the model
 * sees `file:symbol@line`. The per-slice cap was applied upstream; this only
 * relabels, never grows a slice.
 */
const multiSiteSlicesField = (
  file: string,
  allSlices: readonly OwnerSourceSlice[],
): { sourceSlices?: readonly OwnerSourceSlice[] } =>
  allSlices.length > 1
    ? { sourceSlices: allSlices.map((s) => ({ label: `${file}:${s.label}`, slice: s.slice })) }
    : {}

/**
 * Static-witness-backed owner evidence. Carries witness kind/provenance/authority
 * and attaches an exact symbol slice when the witnessed symbol is statically
 * resolvable in that file.
 */
export const assembleStaticWitnessOwnerEvidence = (args: {
  readonly witnesses: readonly StaticWitness[]
  readonly readSource?: (rel: string) => string | null
}): OwnerEvidenceFact[] => {
  return uniqueObjects(
    args.witnesses.flatMap((witness) =>
      uniqueLines(witness.subjectFiles).map((file) =>
        staticWitnessOwnerEvidenceFact(witness, file, args.readSource?.(file) ?? null),
      ),
    ),
  )
}

const staticWitnessOwnerEvidenceFact = (
  witness: StaticWitness,
  file: string,
  source: string | null,
): OwnerEvidenceFact => {
  const symbols = uniqueLines(witness.subjectSymbols)
  const { first: resolved, allSlices } = resolvedSymbolSlices(source, symbols)
  const miss = sliceMissForFile(source, resolved)
  return {
    file,
    symbols,
    provenance: `static-witness:${witness.kind}/${witness.provenance}/${witness.authority}`,
    ...(resolved?.slice !== undefined ? { sourceSlice: resolved.slice } : {}),
    ...multiSiteSlicesField(file, allSlices),
    ...(resolved !== undefined && resolved.matchCount > 1 ? { ambiguousSliceMatch: true } : {}),
    ...(miss !== undefined ? { sliceMiss: miss } : {}),
  }
}

/**
 * Shared owner evidence surface for candidate-generation packets: public issue
 * owners plus structural static-witness owners, deduped but otherwise preserving
 * their distinct provenance.
 */
export const buildSelectionOwnerEvidence = (args: {
  readonly ownerFiles: readonly string[]
  readonly issueSymbols?: readonly string[]
  readonly staticWitnesses?: readonly StaticWitness[]
  readonly readSource?: (rel: string) => string | null
}): OwnerEvidenceFact[] =>
  uniqueObjects([
    ...assembleOwnerEvidence({
      ownerFiles: args.ownerFiles,
      ...(args.issueSymbols !== undefined ? { issueSymbols: args.issueSymbols } : {}),
      ...(args.readSource !== undefined ? { readSource: args.readSource } : {}),
    }),
    ...assembleStaticWitnessOwnerEvidence({
      witnesses: args.staticWitnesses ?? [],
      ...(args.readSource !== undefined ? { readSource: args.readSource } : {}),
    }),
  ])

/**
 * Flatten the typed VerificationPlan into the active proof target — ANSWER-KEY
 * SAFE BY CONSTRUCTION. Only `repro` step commands are surfaced (those are a
 * synthesized sandbox-temp script, blind by construction). `owner-test` /
 * `module-smoke` step commands are WITHHELD (cmdWithheld:true) because they can
 * encode a path to a hidden test — a leak the content scanner cannot detect.
 * The successPredicate is reduced to its discriminant `.type`, never its
 * selector/substring value. This fence must hold before OPC-04 wires
 * test-file-derived steps.
 */
export const verificationTargetFromPlan = (
  plan: VerificationPlan | undefined,
): VerificationTargetFact | undefined => {
  if (plan === undefined) return undefined
  const sanitizeReproCmd = (cmd: string): string | undefined => {
    const sandboxPath = /(?<![\w./-])\/[^\s'"]*\/reproduce_issue\.py/g
    const sanitized = cmd.replace(sandboxPath, "reproduce_issue.py")
    // Temp __repro_* paths are proof-port internals, not stable user-facing
    // commands. Do not let a stale fork path become prompt authority.
    if (/\/[^\s'"]*\/__repro_\d+_[^\s'"]+\.py/.test(sanitized)) return undefined
    return sanitized
  }
  const toStep = (step: VerificationStep): VerificationStepFact => {
    const cmdIsBlind = step.kind === "repro"
    const reproCmd = cmdIsBlind ? sanitizeReproCmd(step.cmd) : undefined
    return {
      kind: step.kind,
      ...(cmdIsBlind && reproCmd !== undefined ? { cmd: reproCmd } : { cmdWithheld: true }),
      ...(step.authority !== undefined ? { authority: step.authority } : {}),
      ...(step.successPredicate !== undefined
        ? { successPredicate: step.successPredicate.type }
        : {}),
    }
  }
  return {
    primaryRail: plan.primaryRail === null ? null : toStep(plan.primaryRail),
    required: plan.required.map(toStep),
    optional: plan.optional.map(toStep),
    baseValidatedRed: plan.baseValidatedRed,
  }
}

/* ------------------------------------------------------------------ */
/* Intake packet                                                       */
/* ------------------------------------------------------------------ */

type IntakeReproTelemetry =
  | {
      readonly installed: true
      readonly path: string
      readonly samples: number
      readonly reproducedCount: number
    }
  | {
      readonly installed: false
      readonly reason: string
      readonly samples?: number
      readonly reproducedCount?: number
      readonly sampleOutcomes?: readonly string[]
      readonly sampleStdoutTail?: string
      readonly sampleStderrTail?: string
    }

export interface IntakeLlmEvidenceInput {
  readonly problemStatement: string
  readonly localizeCandidates: readonly string[]
  readonly faultEvidence?: FaultEvidencePacket
  readonly verificationPlan?: VerificationPlan
  readonly reproTest?: IntakeReproTelemetry
}

const ownerEvidenceFromFaultEvidence = (args: {
  readonly faultEvidence?: FaultEvidencePacket
  readonly localizeCandidates: readonly string[]
}): OwnerEvidenceFact[] => {
  if (args.faultEvidence !== undefined && args.faultEvidence.candidates.length > 0) {
    return args.faultEvidence.candidates.map((candidate) => ({
      file: candidate.file,
      symbols: candidate.symbols,
      provenance: `fault-evidence:${candidate.sources.join("+")}`,
    }))
  }
  return args.localizeCandidates.map((file) => ({
    file,
    symbols: [],
    provenance: "localize-stage1",
  }))
}

const reproReceipts = (repro: IntakeReproTelemetry | undefined): ProofReceiptFact[] => {
  if (repro === undefined)
    return [{ source: "public_mwe", sourcePolicy: "public_repro", state: "not_run" }]
  if (repro.installed) {
    return [
      {
        source: "public_mwe",
        sourcePolicy: "public_repro",
        state: repro.reproducedCount > 0 ? "base_red" : "base_green",
        command: repro.path,
      },
    ]
  }
  return [
    {
      source: "public_mwe",
      // B8: an env/exec failure is an INFRA outcome, not a public-repro verdict.
      sourcePolicy: "infra",
      state: repro.reason.includes("env") ? "env_prep_failed" : "execution_failed",
      ...(repro.sampleStdoutTail !== undefined
        ? { stdoutTail: boundTail(repro.sampleStdoutTail, 600) }
        : {}),
      ...(repro.sampleStderrTail !== undefined
        ? { stderrTail: boundTail(repro.sampleStderrTail, 600) }
        : {}),
    },
  ]
}

export const buildIntakeLlmEvidencePacket = (input: IntakeLlmEvidenceInput): LlmEvidencePacket => {
  const issueReproSeed = extractIssueReproSeed(input.problemStatement)
  const verificationTarget = verificationTargetFromPlan(input.verificationPlan)
  const missingEvidence: MissingEvidenceFact[] = [
    ...(input.faultEvidence === undefined
      ? [{ kind: "fault_evidence", reason: "no_fault_evidence_packet" }]
      : []),
    ...(input.verificationPlan === undefined
      ? [{ kind: "verification_plan", reason: "no_verification_plan" }]
      : []),
    ...(issueReproSeed === undefined
      ? [{ kind: "public_mwe_seed", reason: "no_public_issue_mwe_seed" }]
      : []),
    ...(input.reproTest === undefined
      ? [{ kind: "public_mwe_base", reason: "public_mwe_base_not_attempted" }]
      : []),
  ]
  return cleanPacket({
    stage: "intake",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "intake-v2",
    question: "Which allowed evidence source should be collected next?",
    allowedActions: [
      "run_public_mwe_base",
      "discover_public_regression",
      "inspect_owner_slice",
      "generate_candidate",
    ],
    forbiddenSources: [
      "hidden_tests",
      "gold_patch",
      "official_harness_results",
      "contaminated_case_labels",
    ],
    publicIssueFacts: describeIssueFacts(input.problemStatement, "intake"),
    ownerEvidence: ownerEvidenceFromFaultEvidence(input),
    proofReceipts: [
      {
        source: "public_mwe",
        // B8: a not-yet-executed issue-derived seed is public-issue provenance.
        sourcePolicy: "public_issue",
        state: "static_only",
        ...(issueReproSeed !== undefined
          ? { command: `issue-seed:${issueReproSeed.provenance}` }
          : {}),
      },
      ...reproReceipts(input.reproTest),
    ],
    contractFacts: [],
    staticFacts: [
      {
        kind: "fault_evidence",
        value:
          input.faultEvidence === undefined
            ? "missing"
            : `partial=${input.faultEvidence.partial}; truncated=${input.faultEvidence.truncated}`,
      },
      { kind: "localize_candidates", value: fmtList(input.localizeCandidates) },
    ],
    ...(verificationTarget !== undefined ? { verificationTarget } : {}),
    missingEvidence,
  })
}

/* ------------------------------------------------------------------ */
/* Candidate generation packet (SHARED — one helper, both drivers)     */
/* ------------------------------------------------------------------ */

/** Bounded number of validated repro scripts rendered into the generation packet. */
const VALIDATED_REPRO_SCRIPT_CAP = 2

export interface SelectionGenerationPacketInput {
  readonly problemStatement: string
  readonly ownerEvidence: readonly OwnerEvidenceFact[]
  readonly contracts: readonly ContractFact[]
  readonly verificationTarget?: VerificationTargetFact
  readonly reproCommand?: string
  readonly validatedReproScripts?: readonly string[]
  readonly existingTestExpectations?: readonly string[]
  readonly baseValidatedRed?: boolean
  readonly closureHint?: string
  readonly seed?: string
  readonly envCaveats?: readonly string[]
  readonly staticWitnessDiagnostics?: readonly StaticWitnessDiagnostic[]
}

const selectionGenerationMissingEvidence = (
  input: SelectionGenerationPacketInput,
): MissingEvidenceFact[] => [
  ...(input.reproCommand === undefined
    ? [{ kind: "public_repro", reason: "no_executable_public_repro_hint" }]
    : []),
  ...(input.verificationTarget === undefined
    ? [{ kind: "verification_target", reason: "no_verification_plan_available" }]
    : []),
  ...ownerSliceMissingEvidence(input.ownerEvidence),
]

const selectionGenerationProofReceipts = (
  input: SelectionGenerationPacketInput,
): ProofReceiptFact[] =>
  input.reproCommand === undefined
    ? []
    : [
        {
          source: "public_mwe",
          sourcePolicy: "public_repro",
          state: input.baseValidatedRed === true ? "base_red" : "static_only",
          command: input.reproCommand,
          ...(input.baseValidatedRed !== undefined
            ? { baseValidatedRed: input.baseValidatedRed }
            : {}),
        },
      ]

const nonEmptyValidatedReproScripts = (input: SelectionGenerationPacketInput): string[] =>
  (input.validatedReproScripts ?? [])
    .map((source) => source.trim())
    .filter((source) => source !== "")

const validatedPublicReproFacts = (input: SelectionGenerationPacketInput): StaticFact[] => {
  const scripts = nonEmptyValidatedReproScripts(input)
  const note =
    scripts.length > 0
      ? [
          {
            kind: "validated_public_repro_note",
            value:
              "Scripts below reproduce the issue on the UNPATCHED tree — they reflect the bug's observable behavior. Use them to understand the ROOT CAUSE; a correct fix should make them pass cleanly (all assertions green / exit 0), but fix the root cause rather than contorting the patch to satisfy any single script.",
          },
        ]
      : []
  const rendered = scripts
    .filter((_, i) => i < VALIDATED_REPRO_SCRIPT_CAP)
    .map((source, i) => ({
      kind: "validated_public_repro",
      value: `script ${i + 1}: ${boundHead(source, 1200)}`,
    }))
  const omitted = scripts.length - VALIDATED_REPRO_SCRIPT_CAP
  const omittedFact =
    omitted > 0
      ? [
          {
            kind: "validated_public_repro_omitted",
            value: `Omitted ${omitted} additional validated reproduction script(s) to keep the prompt compact.`,
          },
        ]
      : []
  return [...note, ...rendered, ...omittedFact]
}

const existingOwnerTestExpectationFacts = (input: SelectionGenerationPacketInput): StaticFact[] => {
  const expectations = (input.existingTestExpectations ?? [])
    .map((fact) => fact.trim())
    .filter((fact) => fact !== "")
  if (expectations.length === 0) return []
  return [
    {
      kind: "existing_owner_test_expectation_note",
      value:
        "Existing repo tests below are PUBLIC source-of-truth examples. Match their exact behavior and message literals before inventing a new interpretation.",
    },
    ...expectations.map((fact, i) => ({
      kind: "existing_owner_test_expectation",
      value: `expectation ${i + 1}: ${boundHead(fact, 240)}`,
    })),
  ]
}

const selectionGenerationStaticFacts = (
  input: SelectionGenerationPacketInput,
  diagnostics: ReturnType<typeof staticWitnessDiagnosticsFacts>,
): StaticFact[] => [
  ...validatedPublicReproFacts(input),
  ...existingOwnerTestExpectationFacts(input),
  ...diagnostics.staticFacts,
  ...(input.seed !== undefined && input.seed.trim() !== ""
    ? [{ kind: "diversity_seed", value: boundHead(input.seed, 400) }]
    : []),
]

const selectionGenerationPublicIssueFacts = (input: SelectionGenerationPacketInput): string[] => [
  ...describeIssueFacts(input.problemStatement, "candidate_generation"),
  ...(input.closureHint !== undefined && input.closureHint.trim() !== ""
    ? [`co-change hint: ${boundHead(input.closureHint, 400)}`]
    : []),
  ...(input.envCaveats ?? []).map((c) => `env caveat: ${c}`),
]

/**
 * The single shared candidate_generation packet builder. SELF-CONTAINED: it
 * carries actual public issue facts + the active proof target, so it never
 * points back to ambient prompt text. Returns the rendered prompt string.
 */
export const buildSelectionGenerationLlmEvidencePacket = (
  input: SelectionGenerationPacketInput,
): LlmEvidencePacket => {
  assertEvidenceTextBlind("candidate_generation", [
    input.problemStatement,
    input.reproCommand,
    input.closureHint,
    input.seed,
    ...(input.envCaveats ?? []),
    ...(input.validatedReproScripts ?? []),
    ...(input.existingTestExpectations ?? []),
  ])
  const missingEvidence = selectionGenerationMissingEvidence(input)
  const staticWitnessDiagnostics = staticWitnessDiagnosticsFacts(input.staticWitnessDiagnostics)
  return cleanPacket({
    stage: "candidate_generation",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "selection-generation-v3",
    question:
      "Produce one minimal candidate patch that satisfies the active proof target against the bounded owner surface below.",
    allowedActions: [
      "edit_candidate_sandbox_only",
      "inspect_named_owner_files",
      "produce_minimal_patch",
    ],
    forbiddenSources: [
      "hidden_tests",
      "gold_patch",
      "official_harness_results",
      "benchmark_case_tables",
      "broad_multifile_drift_without_public_evidence",
    ],
    publicIssueFacts: selectionGenerationPublicIssueFacts(input),
    ownerEvidence: input.ownerEvidence,
    proofReceipts: selectionGenerationProofReceipts(input),
    contractFacts: input.contracts,
    staticFacts: selectionGenerationStaticFacts(input, staticWitnessDiagnostics),
    ...(input.verificationTarget !== undefined
      ? { verificationTarget: input.verificationTarget }
      : {}),
    missingEvidence: [...missingEvidence, ...staticWitnessDiagnostics.missingEvidence],
  })
}

export interface SelectionGenerationPromptInput
  extends Omit<SelectionGenerationPacketInput, "baseValidatedRed"> {
  readonly baseValidatedRed: boolean | null
  readonly recordLlmEvidencePacket?: (packet: LlmEvidencePacket) => void
}

/**
 * Shared clean generation prompt SSOT. `baseValidatedRed=null` means no repro
 * authority exists in this posture, so the field is omitted instead of being
 * coerced into a false hard gate.
 */
export const buildSelectionGenerationPrompt = (input: SelectionGenerationPromptInput): string => {
  const packet = buildSelectionGenerationLlmEvidencePacket({
    problemStatement: input.problemStatement,
    ownerEvidence: input.ownerEvidence,
    contracts: input.contracts,
    ...(input.baseValidatedRed !== null ? { baseValidatedRed: input.baseValidatedRed } : {}),
    ...(input.verificationTarget !== undefined
      ? { verificationTarget: input.verificationTarget }
      : {}),
    ...(input.reproCommand !== undefined ? { reproCommand: input.reproCommand } : {}),
    ...(input.validatedReproScripts !== undefined && input.validatedReproScripts.length > 0
      ? { validatedReproScripts: input.validatedReproScripts }
      : {}),
    ...(input.existingTestExpectations !== undefined && input.existingTestExpectations.length > 0
      ? { existingTestExpectations: input.existingTestExpectations }
      : {}),
    ...(input.closureHint !== undefined ? { closureHint: input.closureHint } : {}),
    ...(input.envCaveats !== undefined && input.envCaveats.length > 0
      ? { envCaveats: input.envCaveats }
      : {}),
    ...(input.staticWitnessDiagnostics !== undefined && input.staticWitnessDiagnostics.length > 0
      ? { staticWitnessDiagnostics: input.staticWitnessDiagnostics }
      : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  })
  input.recordLlmEvidencePacket?.(packet)
  return renderLlmEvidencePacket(packet)
}

/* ------------------------------------------------------------------ */
/* Candidate review packet (runtime risk screen, shadow/research only)  */
/* ------------------------------------------------------------------ */

export interface CandidateReviewPacketInput {
  readonly problemStatement: string
  readonly candidatePatchHash: string
  readonly candidateFiles: readonly string[]
  readonly ownerEvidence: readonly OwnerEvidenceFact[]
}

/**
 * LEGACY-NAMED stage. This is the PRE-proof expansion risk screen for
 * candidate 0 ("should the selector expand?"), not a post-exec correctness
 * review. It carries no submit authority; the deterministic selector still
 * decides.
 */
export const buildCandidateReviewLlmEvidencePacket = (
  input: CandidateReviewPacketInput,
): LlmEvidencePacket =>
  cleanPacket({
    stage: "candidate_review",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "risk-gate-v2",
    candidatePatchHash: input.candidatePatchHash,
    question:
      "Should the outer selector expand beyond candidate 0, or is the current patch already low-risk enough to stop?",
    allowedActions: ["expand", "do_not_expand"],
    forbiddenSources: [
      "hidden_tests",
      "gold_patch",
      "official_harness_results",
      "benchmark_case_tables",
    ],
    publicIssueFacts: describeIssueFacts(input.problemStatement, "candidate_review"),
    ownerEvidence: input.ownerEvidence,
    proofReceipts: [],
    contractFacts: [],
    staticFacts: [
      { kind: "stage_scope", value: "This stage does not judge correctness or select a winner." },
      {
        kind: "expand_when",
        value:
          "Expand when the patch may miss explicit issue conditions, may implement only a surfaced symptom, may overfit a public example, changes behavior without clear evidence, or you are unsure.",
      },
      {
        kind: "candidate_touched_files",
        value: input.candidateFiles.length > 0 ? input.candidateFiles.join(", ") : "<none>",
      },
    ],
    missingEvidence: [
      {
        kind: "executed_public_proof",
        reason: "no_executed_public_proof_receipts_attached_to_risk_gate",
      },
    ],
  })

/* ------------------------------------------------------------------ */
/* Candidate post-review packet (executed-proof diagnosis)             */
/* ------------------------------------------------------------------ */

export interface CandidatePostReviewPacketInput {
  readonly problemStatement: string
  readonly candidatePatchHash: string
  readonly ownerEvidence: readonly OwnerEvidenceFact[]
  readonly proofReceipts: readonly ProofReceiptFact[]
  readonly contracts: readonly ContractFact[]
  readonly verificationTarget?: VerificationTargetFact
  /** SOURCE-ONLY candidate edit surface (B7). */
  readonly candidateEditSurface?: CandidateEditSurfaceFact
  readonly staticWitnessDiagnostics?: readonly StaticWitnessDiagnostic[]
  readonly missingEvidence?: readonly MissingEvidenceFact[]
}

export const buildCandidatePostReviewLlmEvidencePacket = (
  input: CandidatePostReviewPacketInput,
): LlmEvidencePacket => {
  const staticWitnessDiagnostics = staticWitnessDiagnosticsFacts(input.staticWitnessDiagnostics)
  return cleanPacket({
    stage: "candidate_post_review",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "candidate-post-review-v1",
    candidatePatchHash: input.candidatePatchHash,
    question:
      "Diagnose the executed candidate using only these proof receipts, then identify the smallest bounded repair that preserves any stronger public or structural coverage already present.",
    allowedActions: [
      "diagnose_executed_candidate",
      "identify_missing_public_proof",
      "preserve_supported_structural_coverage",
    ],
    forbiddenSources: [
      "hidden_tests",
      "gold_patch",
      "official_harness_results",
      "benchmark_case_tables",
      "selection_override",
    ],
    publicIssueFacts: describeIssueFacts(input.problemStatement, "candidate_post_review"),
    ownerEvidence: input.ownerEvidence,
    proofReceipts: input.proofReceipts,
    contractFacts: input.contracts,
    staticFacts: [
      {
        kind: "review_scope",
        value:
          "Post-exec diagnosis only: use executed proof receipts and deterministic hard reasons to decide what the next bounded repair must preserve or fix.",
      },
      ...staticWitnessDiagnostics.staticFacts,
    ],
    ...(input.verificationTarget !== undefined
      ? { verificationTarget: input.verificationTarget }
      : {}),
    ...(input.candidateEditSurface !== undefined
      ? { candidateEditSurface: input.candidateEditSurface }
      : {}),
    missingEvidence: [
      ...(input.missingEvidence ??
        (input.proofReceipts.some(
          (receipt) => receipt.state !== "not_run" && receipt.state !== "static_only",
        )
          ? []
          : [
              {
                kind: "executed_public_proof",
                reason: "no_executed_public_proof_receipts_attached_to_post_exec_review",
              },
            ])),
      // B2: a missing owner slice is VISIBLE here, mirroring candidate_generation.
      ...ownerSliceMissingEvidence(input.ownerEvidence),
      ...staticWitnessDiagnostics.missingEvidence,
    ],
  })
}

/* ------------------------------------------------------------------ */
/* Repair seed packet (SHARED)                                         */
/* ------------------------------------------------------------------ */

export interface RepairSeedPacketInput {
  readonly problemStatement: string
  readonly candidatePatchHash: string
  readonly ownerEvidence: readonly OwnerEvidenceFact[]
  readonly proofReceipts: readonly ProofReceiptFact[]
  readonly contracts: readonly ContractFact[]
  /** Deterministic repair instruction text (bounded) assembled by the selector. */
  readonly repairGuidance?: string
  readonly verificationTarget?: VerificationTargetFact
  /** SOURCE-ONLY candidate edit surface (B7). */
  readonly candidateEditSurface?: CandidateEditSurfaceFact
  readonly missingEvidence?: readonly MissingEvidenceFact[]
}

/**
 * The single post-exec LLM action in the v4 minimum: turn a deterministic
 * proof/contract failure into one bounded next candidate. SELF-CONTAINED (real
 * issue facts) and instanceIdHash is the SAME opaque problem-statement hash as
 * every other stage; candidate identity lives in `candidatePatchHash`.
 */
export const buildRepairSeedLlmEvidencePacket = (
  input: RepairSeedPacketInput,
): LlmEvidencePacket => {
  assertEvidenceTextBlind("repair_seed", [input.problemStatement, input.repairGuidance])
  return cleanPacket({
    stage: "repair_seed",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "selector-repair-v2",
    candidatePatchHash: input.candidatePatchHash,
    question:
      "Generate a bounded repair instruction for the next candidate that satisfies the named public proof.",
    allowedActions: [
      "bounded_repair_only",
      "preserve_stronger_structural_coverage",
      "satisfy_named_public_proof",
    ],
    forbiddenSources: [
      "hidden_tests",
      "gold_patch",
      "official_harness_results",
      "benchmark_case_tables",
      "try_harder_generic_retry",
    ],
    publicIssueFacts: describeIssueFacts(input.problemStatement, "repair_seed"),
    ownerEvidence: input.ownerEvidence,
    proofReceipts: input.proofReceipts,
    contractFacts: input.contracts,
    staticFacts:
      input.repairGuidance !== undefined && input.repairGuidance.trim() !== ""
        ? [{ kind: "repair_guidance", value: boundHead(input.repairGuidance, 1800) }]
        : [],
    ...(input.verificationTarget !== undefined
      ? { verificationTarget: input.verificationTarget }
      : {}),
    ...(input.candidateEditSurface !== undefined
      ? { candidateEditSurface: input.candidateEditSurface }
      : {}),
    missingEvidence: [
      ...(input.missingEvidence ??
        (input.proofReceipts.every((r) => r.state !== "candidate_red" && r.state !== "base_red")
          ? [
              {
                kind: "executed_public_proof",
                reason: "no_positive_executed_public_proof_attached",
              },
            ]
          : [])),
      // B2: a missing owner slice is VISIBLE here, mirroring candidate_generation.
      ...ownerSliceMissingEvidence(input.ownerEvidence),
    ],
  })
}

/* ------------------------------------------------------------------ */
/* Selection explanation packet (report-only RCA)                      */
/* ------------------------------------------------------------------ */

export interface SelectionExplanationCandidateInput {
  readonly id: string
  readonly files: readonly string[]
  readonly touchedSymbols?: readonly string[]
  readonly admissible: boolean
  readonly reasons: readonly string[]
  readonly proofState?: SelectionProofState
  readonly proofSource?: SelectionProofSource
  readonly requiredContractsSatisfied?: number
  readonly contractsSatisfied?: number
}

export interface SelectionExplanationProofSummaryInput {
  readonly proofState: SelectionProofState
  readonly proofSource: SelectionProofSource
  readonly proofRequiredMissing: boolean
  readonly contractOnlySubmitted: boolean
  readonly contractOnlyBlocked: boolean
  readonly publicMweState?: MweProofState
  readonly publicRegressionState?: PublicRegressionProofState
  readonly reproConsensusState?: ReproConsensusProofState
  /** B5 — executed module-smoke (public issue-smoke) HARD-gate RESULT for the
   *  focus candidate (green/red). Absent ⇒ the smoke gate did not run. */
  readonly moduleSmokeState?: "green" | "red"
  readonly repairOnlyCandidates: number
  readonly submittedCandidateProof: boolean
}

export interface SelectionExplanationLlmEvidenceInput {
  readonly problemStatement: string
  readonly ownerFiles: readonly string[]
  readonly winnerId: string | null
  readonly noWinnerReason?: string
  readonly proofRequired?: boolean
  readonly proofSummary?: SelectionExplanationProofSummaryInput
  readonly candidates: readonly SelectionExplanationCandidateInput[]
  readonly staticWitnessDiagnostics?: readonly StaticWitnessDiagnostic[]
}

const proofSummaryReceipts = (
  summary: SelectionExplanationProofSummaryInput | undefined,
): ProofReceiptFact[] => {
  if (summary === undefined)
    return [{ source: "selection", sourcePolicy: "static", state: "not_run" }]
  const publicMweReceiptState = (
    state: MweProofState | undefined,
  ): ProofReceiptState | undefined => {
    switch (state) {
      case undefined:
        return undefined
      case "base_red":
        return "base_red"
      case "base_not_red":
        return "base_green"
      case "patched_green":
        return "candidate_green"
      case "candidate_red":
        return "candidate_red"
      case "execution_failed":
        return "execution_failed"
      case "not_found":
        return "not_run"
    }
  }
  const publicRegressionReceiptState = (
    state: PublicRegressionProofState | undefined,
  ): ProofReceiptState | undefined => {
    switch (state) {
      case undefined:
        return undefined
      case "candidate_red":
        return "candidate_red"
      case "safety_green":
        return "candidate_green"
      case "execution_failed":
        return "execution_failed"
      case "coverage_capped":
        return "static_only"
      case "not_available":
      case "base_not_green":
        return "not_run"
    }
  }
  const reproConsensusReceiptState = (
    state: ReproConsensusProofState | undefined,
  ): ProofReceiptState | undefined => {
    switch (state) {
      case undefined:
        return undefined
      case "base_red_candidate_green":
        return "candidate_green"
      case "base_red_candidate_red":
        return "candidate_red"
      case "execution_failed":
        return "execution_failed"
      case "false_negative_suspected":
        return "static_only"
      case "not_available":
        return "not_run"
    }
  }
  // B8: each report receipt carries an explicit typed source policy.
  const withPolicy = (source: string, state: ProofReceiptState): ProofReceiptFact => {
    const policy = sourcePolicyOf(source)
    return {
      source,
      ...(policy !== undefined ? { sourcePolicy: policy } : {}),
      state,
    }
  }
  return [
    ...(() => {
      const state = publicMweReceiptState(summary.publicMweState)
      return state === undefined ? [] : [withPolicy("public_mwe", state)]
    })(),
    ...(() => {
      const state = publicRegressionReceiptState(summary.publicRegressionState)
      return state === undefined ? [] : [withPolicy("discovered_regression", state)]
    })(),
    ...(() => {
      const state = reproConsensusReceiptState(summary.reproConsensusState)
      return state === undefined ? [] : [withPolicy("repro_consensus", state)]
    })(),
    // B5 — the executed module-smoke RESULT as a proof receipt the model sees.
    // `ownerTestResultReceipt` enforces `cmdWithheld:true` (RESULT ONLY, C3
    // fence): the LLM/router learns green/red, never the smoke command/selector.
    ...(summary.moduleSmokeState === undefined
      ? []
      : [ownerTestResultReceipt({ kind: "module_smoke", result: summary.moduleSmokeState })]),
  ]
}

export const buildSelectionExplanationPacket = (
  input: SelectionExplanationLlmEvidenceInput,
): LlmEvidencePacket => {
  const staticWitnessDiagnostics = staticWitnessDiagnosticsFacts(input.staticWitnessDiagnostics)
  const focusCandidate =
    input.winnerId === null
      ? undefined
      : input.candidates.find((candidate) => candidate.id === input.winnerId)
  const missingEvidence: MissingEvidenceFact[] = [
    ...(input.winnerId === null ? [{ kind: "winner", reason: "no_selected_candidate" }] : []),
    ...(input.proofSummary?.proofRequiredMissing === true
      ? [{ kind: "executed_public_proof", reason: "no_positive_executed_public_proof" }]
      : []),
    ...(input.proofSummary?.proofState === "infra_blocked"
      ? [{ kind: "public_proof", reason: "public_proof_infra_blocked" }]
      : []),
    ...staticWitnessDiagnostics.missingEvidence,
  ]
  return cleanPacket({
    stage: "selection_explanation",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "selection-explanation-v2",
    question:
      "Explain the deterministic selection outcome and the remaining missing public evidence.",
    allowedActions: [
      "explain_selection_outcome",
      "identify_missing_public_evidence",
      "separate_infra_from_candidate_failure",
    ],
    forbiddenSources: [
      "hidden_tests",
      "gold_patch",
      "official_harness_results",
      "benchmark_case_tables",
      "selection_override",
    ],
    publicIssueFacts: describeIssueFacts(input.problemStatement, "selection_explanation"),
    ownerEvidence: input.ownerFiles.map((file) => ({
      file,
      symbols: [],
      provenance: "selection-owner",
    })),
    proofReceipts: proofSummaryReceipts(input.proofSummary),
    contractFacts: input.candidates.map((c) => ({
      contractId: `candidate:${c.id}`,
      authority: `required=${c.requiredContractsSatisfied ?? 0}; contracts=${c.contractsSatisfied ?? 0}; proof=${c.proofState ?? "unknown"}`,
      satisfied: c.admissible,
    })),
    staticFacts: [
      { kind: "selected_candidate", value: input.winnerId ?? "<none>" },
      { kind: "proof_required", value: String(input.proofRequired === true) },
      ...(input.proofSummary !== undefined
        ? [
            {
              kind: "proof_gates",
              value: `state=${input.proofSummary.proofState}; source=${input.proofSummary.proofSource}; contractOnlySubmitted=${input.proofSummary.contractOnlySubmitted}; repairOnly=${input.proofSummary.repairOnlyCandidates}`,
            },
          ]
        : []),
      ...(input.noWinnerReason !== undefined
        ? [{ kind: "no_winner_reason", value: input.noWinnerReason }]
        : []),
      ...staticWitnessDiagnostics.staticFacts,
      ...input.candidates.map((c) => ({
        kind: `candidate:${c.id}`,
        value: `admissible=${c.admissible}; files=${fmtList(c.files)}; reasons=${fmtList(c.reasons)}`,
      })),
    ],
    ...(focusCandidate !== undefined
      ? {
          candidateEditSurface: {
            touchedFiles: focusCandidate.files,
            touchedSymbols: [...(focusCandidate.touchedSymbols ?? [])],
          },
        }
      : {}),
    missingEvidence,
  })
}

/** The phase-DECISION question the router actually asks. Mirrors the router
 *  instruction ("choose the single best next PHASE") so the packet contract and
 *  the surrounding prompt agree. */
export const PHASE_ROUTING_QUESTION =
  "Choose the single best NEXT PHASE for this bounded fix controller, given the bounded evidence below. You are ROUTING (selecting a phase), not explaining a past outcome and not submitting."

/**
 * A10 — re-contract an evidence packet for the adaptive PHASE ROUTER. The router
 * consumes the `selection_explanation` evidence BODY but asks a phase-DECISION
 * question, so the original packet's `stage:"selection_explanation"` /
 * `question:"Explain…"` / `allowedActions:["explain_…"]` are a STALE, misleading
 * contract for that consumer. This rewrites exactly those three fields to the
 * routing contract — `stage:"phase_routing"`, the phase-decision
 * {@link PHASE_ROUTING_QUESTION}, and the closed routing action menu (`routingActions`,
 * supplied by the caller so this module need not couple to the router's action
 * union) — while preserving every EVIDENCE field (issue facts, owner evidence,
 * proof receipts, etc.) byte-for-byte. The result is re-cleaned, so blindness
 * still holds. The original (report-RCA) packet is untouched: callers build a
 * separate packet for the report.
 */
export const toPhaseRoutingContract = (
  packet: LlmEvidencePacket,
  routingActions: readonly string[],
): LlmEvidencePacket =>
  cleanPacket({
    ...packet,
    stage: "phase_routing",
    question: PHASE_ROUTING_QUESTION,
    allowedActions: routingActions,
  })
