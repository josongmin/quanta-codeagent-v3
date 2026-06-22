import { createHash } from "node:crypto"
import { extractIssueHint } from "@/agent/issue-hint"
import type { FaultEvidencePacket } from "@/agent/fault-evidence"
import { extractIssueReproSeed } from "@/agent/verification-plan"
import type { VerificationPlan } from "@/agent/verification-plan"
import { normalizePublicIssueText } from "@/shared"

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
  | "repair_seed"
  | "selection_explanation"

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

export interface ProofReceiptFact {
  /** "public_mwe" | "repro_consensus" | "discovered_regression" | "verification_plan" | "selector_hard_reason" … */
  readonly source: string
  readonly state: ProofReceiptState
  readonly command?: string
  readonly baseValidatedRed?: boolean
  readonly stdoutTail?: string
  readonly stderrTail?: string
  readonly candidatePatchHash?: string
}

/** A typed, provenance-carrying public obligation (mirrors PublicContract). */
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

/** One step of the typed VerificationPlan, flattened for the LLM. */
export interface VerificationStepFact {
  readonly kind: string
  readonly cmd: string
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
  readonly missingEvidence: readonly MissingEvidenceFact[]
}

export interface LlmEvidenceArtifacts {
  readonly intake?: LlmEvidencePacket
  readonly selectionExplanation?: LlmEvidencePacket
}

/* ------------------------------------------------------------------ */
/* Benchmark-blindness guard (HARD)                                    */
/* ------------------------------------------------------------------ */

/**
 * Structural SWE-bench dataset keys. These are not natural-language tokens —
 * their presence inside an EVIDENCE field means a hidden-oracle leak (the packet
 * was built from a forbidden source). Matched only against evidence content,
 * never the meta menu (`forbiddenSources` legitimately *names* `gold_patch`
 * etc. as things the LLM must not use).
 */
export const FORBIDDEN_PACKET_MARKERS: readonly string[] = [
  "FAIL_TO_PASS",
  "PASS_TO_PASS",
  "test_patch",
]

export class PacketBlindnessViolation extends Error {
  constructor(
    readonly marker: string,
    readonly stage: LlmEvidencePacketStage,
  ) {
    super(`packet blindness violation: forbidden marker "${marker}" leaked into ${stage} evidence`)
    this.name = "PacketBlindnessViolation"
  }
}

/** All strings drawn from EVIDENCE fields only (not the meta action menu). */
const evidenceStrings = (packet: LlmEvidencePacket): string[] => {
  const out: string[] = [...packet.publicIssueFacts]
  for (const o of packet.ownerEvidence) {
    out.push(o.file, o.provenance, ...o.symbols)
    if (o.sourceSlice !== undefined) out.push(o.sourceSlice)
  }
  for (const r of packet.proofReceipts) {
    out.push(r.source, r.state)
    if (r.command !== undefined) out.push(r.command)
    if (r.stdoutTail !== undefined) out.push(r.stdoutTail)
    if (r.stderrTail !== undefined) out.push(r.stderrTail)
  }
  for (const c of packet.contractFacts) out.push(c.contractId, c.authority)
  for (const s of packet.staticFacts) out.push(s.kind, s.value)
  for (const m of packet.missingEvidence) out.push(m.kind, m.reason)
  if (packet.verificationTarget !== undefined) {
    const steps = [
      ...(packet.verificationTarget.primaryRail ? [packet.verificationTarget.primaryRail] : []),
      ...packet.verificationTarget.required,
      ...packet.verificationTarget.optional,
    ]
    for (const st of steps) {
      out.push(st.cmd)
      if (st.successPredicate !== undefined) out.push(st.successPredicate)
    }
  }
  return out
}

/**
 * Throw if any forbidden benchmark marker leaked into an evidence field. HARD
 * guard (the easiest place to reintroduce answer-key leakage). A leak is a
 * construction bug that would corrupt measurement, so it fails LOUD rather than
 * silently scrubbing. Scans evidence only; the action menu may still name
 * forbidden sources. Run by every packet through {@link cleanPacket}.
 */
export const assertPacketBlind = (packet: LlmEvidencePacket): LlmEvidencePacket => {
  const haystack = evidenceStrings(packet)
  for (const marker of FORBIDDEN_PACKET_MARKERS) {
    if (haystack.some((s) => s.includes(marker))) {
      throw new PacketBlindnessViolation(marker, packet.stage)
    }
  }
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

/** Normalize + dedupe + HARD blindness check. Idempotent. */
export const cleanPacket = (packet: LlmEvidencePacket): LlmEvidencePacket =>
  assertPacketBlind({
    ...packet,
    allowedActions: uniqueLines(packet.allowedActions),
    forbiddenSources: uniqueLines(packet.forbiddenSources),
    publicIssueFacts: uniqueLines(packet.publicIssueFacts),
    ownerEvidence: uniqueObjects(packet.ownerEvidence),
    proofReceipts: uniqueObjects(packet.proofReceipts),
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

/* ------------------------------------------------------------------ */
/* Typed evidence assembly helpers (shared by all builders)            */
/* ------------------------------------------------------------------ */

const firstNonEmptyLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)

const bounded = (text: string, max = 220): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

const fmtList = (values: readonly string[], empty = "<none>"): string =>
  values.length === 0 ? empty : values.join(", ")

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Actual normalized public issue facts — never a placeholder pointer. */
export const describeIssueFacts = (problemStatement: string): string[] => {
  const normalized = normalizePublicIssueText(problemStatement)?.trim() ?? problemStatement.trim()
  const hint = extractIssueHint(problemStatement)
  return [
    `issue summary: ${bounded(firstNonEmptyLine(normalized) ?? "<empty issue text>")}`,
    `issue symbols: ${fmtList(hint.symbols)}`,
    `issue files: ${fmtList(hint.files)}`,
  ]
}

/**
 * Exact definition/symbol block for a Python `def`/`class` symbol — the bounded
 * source slice rule (no broad windows, no whole-file bodies). Returns undefined
 * when the symbol is not statically resolvable in the source.
 */
export const extractSymbolSlice = (
  source: string,
  symbol: string,
  maxLines = 40,
): string | undefined => {
  const lines = source.split(/\r?\n/)
  const re = new RegExp(`^(\\s*)(?:async\\s+)?(?:def|class)\\s+${escapeRe(symbol)}\\b`)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const m = line.match(re)
    if (m === null) continue
    const indent = (m[1] ?? "").length
    const block: string[] = [line]
    for (let j = i + 1; j < lines.length && block.length < maxLines; j++) {
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
    return block.join("\n").trimEnd()
  }
  return undefined
}

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
  const out: OwnerEvidenceFact[] = []
  for (const file of args.ownerFiles) {
    if (file.trim() === "") continue
    const source = args.readSource?.(file) ?? null
    const definedSymbols =
      source === null
        ? []
        : issueSymbols.filter((sym) =>
            new RegExp(`^\\s*(?:async\\s+)?(?:def|class)\\s+${escapeRe(sym)}\\b`, "m").test(source),
          )
    const slice =
      source === null
        ? undefined
        : definedSymbols.map((sym) => extractSymbolSlice(source, sym)).find((s) => s !== undefined)
    out.push({
      file,
      symbols: definedSymbols,
      provenance,
      ...(slice !== undefined ? { sourceSlice: slice } : {}),
    })
  }
  return out
}

/** Flatten the typed VerificationPlan into the active proof target. */
export const verificationTargetFromPlan = (
  plan: VerificationPlan | undefined,
): VerificationTargetFact | undefined => {
  if (plan === undefined) return undefined
  const toStep = (step: {
    kind: string
    cmd: string
    authority?: string
    successPredicate?: { type: string }
  }): VerificationStepFact => ({
    kind: step.kind,
    cmd: step.cmd,
    ...(step.authority !== undefined ? { authority: step.authority } : {}),
    ...(step.successPredicate !== undefined ? { successPredicate: step.successPredicate.type } : {}),
  })
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
  if (repro === undefined) return [{ source: "public_mwe", state: "not_run" }]
  if (repro.installed) {
    return [
      {
        source: "public_mwe",
        state: repro.reproducedCount > 0 ? "base_red" : "base_green",
        command: repro.path,
      },
    ]
  }
  return [
    {
      source: "public_mwe",
      state: repro.reason.includes("env") ? "env_prep_failed" : "execution_failed",
      ...(repro.sampleStdoutTail !== undefined ? { stdoutTail: bounded(repro.sampleStdoutTail, 600) } : {}),
      ...(repro.sampleStderrTail !== undefined ? { stderrTail: bounded(repro.sampleStderrTail, 600) } : {}),
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
    forbiddenSources: ["hidden_tests", "gold_patch", "official_harness_results", "contaminated_case_labels"],
    publicIssueFacts: describeIssueFacts(input.problemStatement),
    ownerEvidence: ownerEvidenceFromFaultEvidence(input),
    proofReceipts: [
      {
        source: "public_mwe",
        state: "static_only",
        ...(issueReproSeed !== undefined ? { command: `issue-seed:${issueReproSeed.provenance}` } : {}),
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

export interface SelectionGenerationPacketInput {
  readonly problemStatement: string
  readonly ownerEvidence: readonly OwnerEvidenceFact[]
  readonly contracts: readonly ContractFact[]
  readonly verificationTarget?: VerificationTargetFact
  readonly reproCommand?: string
  readonly baseValidatedRed?: boolean
  readonly closureHint?: string
  readonly seed?: string
  readonly envCaveats?: readonly string[]
}

/**
 * The single shared candidate_generation packet builder. SELF-CONTAINED: it
 * carries actual public issue facts + the active proof target, so it never
 * points back to ambient prompt text. Returns the rendered prompt string.
 */
export const buildSelectionGenerationPacket = (input: SelectionGenerationPacketInput): string => {
  const missingEvidence: MissingEvidenceFact[] = [
    ...(input.reproCommand === undefined
      ? [{ kind: "public_repro", reason: "no_executable_public_repro_hint" }]
      : []),
    ...(input.verificationTarget === undefined
      ? [{ kind: "verification_target", reason: "no_verification_plan_available" }]
      : []),
    ...input.ownerEvidence
      .filter((o) => o.sourceSlice === undefined)
      .map((o) => ({ kind: "owner_slice", reason: `no_resolvable_slice:${o.file}` })),
  ]
  const proofReceipts: ProofReceiptFact[] =
    input.reproCommand === undefined
      ? []
      : [
          {
            source: "public_mwe",
            state: input.baseValidatedRed === true ? "base_red" : "static_only",
            command: input.reproCommand,
            ...(input.baseValidatedRed !== undefined ? { baseValidatedRed: input.baseValidatedRed } : {}),
          },
        ]
  return renderLlmEvidencePacket({
    stage: "candidate_generation",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "selection-generation-v2",
    question: "Produce one minimal candidate patch that satisfies the active proof target against the bounded owner surface below.",
    allowedActions: ["edit_candidate_sandbox_only", "inspect_named_owner_files", "produce_minimal_patch"],
    forbiddenSources: [
      "hidden_tests",
      "gold_patch",
      "official_harness_results",
      "benchmark_case_tables",
      "broad_multifile_drift_without_public_evidence",
    ],
    publicIssueFacts: [
      ...describeIssueFacts(input.problemStatement),
      ...(input.closureHint !== undefined && input.closureHint.trim() !== ""
        ? [`co-change hint: ${bounded(input.closureHint, 400)}`]
        : []),
      ...(input.envCaveats ?? []).map((c) => `env caveat: ${c}`),
    ],
    ownerEvidence: input.ownerEvidence,
    proofReceipts,
    contractFacts: input.contracts,
    staticFacts: [
      ...(input.seed !== undefined && input.seed.trim() !== ""
        ? [{ kind: "diversity_seed", value: bounded(input.seed, 400) }]
        : []),
    ],
    ...(input.verificationTarget !== undefined ? { verificationTarget: input.verificationTarget } : {}),
    missingEvidence,
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
  readonly verificationTarget?: VerificationTargetFact
  readonly missingEvidence?: readonly MissingEvidenceFact[]
}

/**
 * The single post-exec LLM action in the v4 minimum: turn a deterministic
 * proof/contract failure into one bounded next candidate. SELF-CONTAINED (real
 * issue facts) and instanceIdHash is the SAME opaque problem-statement hash as
 * every other stage; candidate identity lives in `candidatePatchHash`.
 */
export const buildRepairSeedPacket = (input: RepairSeedPacketInput): string =>
  renderLlmEvidencePacket({
    stage: "repair_seed",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "selector-repair-v2",
    candidatePatchHash: input.candidatePatchHash,
    question: "Generate a bounded repair instruction for the next candidate that satisfies the named public proof.",
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
    publicIssueFacts: describeIssueFacts(input.problemStatement),
    ownerEvidence: input.ownerEvidence,
    proofReceipts: input.proofReceipts,
    contractFacts: input.contracts,
    staticFacts: [],
    ...(input.verificationTarget !== undefined ? { verificationTarget: input.verificationTarget } : {}),
    missingEvidence:
      input.missingEvidence ??
      (input.proofReceipts.every((r) => r.state !== "candidate_red" && r.state !== "base_red")
        ? [{ kind: "executed_public_proof", reason: "no_positive_executed_public_proof_attached" }]
        : []),
  })

/* ------------------------------------------------------------------ */
/* Selection explanation packet (report-only RCA)                      */
/* ------------------------------------------------------------------ */

export interface SelectionExplanationCandidateInput {
  readonly id: string
  readonly files: readonly string[]
  readonly admissible: boolean
  readonly reasons: readonly string[]
  readonly proofState?: string
  readonly proofSource?: string
  readonly requiredContractsSatisfied?: number
  readonly contractsSatisfied?: number
}

export interface SelectionExplanationProofSummaryInput {
  readonly proofState: string
  readonly proofSource: string
  readonly proofRequiredMissing: boolean
  readonly contractOnlySubmitted: boolean
  readonly contractOnlyBlocked: boolean
  readonly publicMweState?: string
  readonly publicRegressionState?: string
  readonly reproConsensusState?: string
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
}

const proofSummaryReceipts = (
  summary: SelectionExplanationProofSummaryInput | undefined,
): ProofReceiptFact[] => {
  if (summary === undefined) return [{ source: "selection", state: "not_run" }]
  const mapState = (s: string | undefined): ProofReceiptState =>
    s === undefined
      ? "not_run"
      : s.includes("infra") || s.includes("env")
        ? "env_prep_failed"
        : s.includes("green") || s.includes("resolved")
          ? "candidate_green"
          : s.includes("red") || s.includes("unresolved")
            ? "candidate_red"
            : "not_run"
  return [
    ...(summary.publicMweState !== undefined
      ? [{ source: "public_mwe", state: mapState(summary.publicMweState) }]
      : []),
    ...(summary.publicRegressionState !== undefined
      ? [{ source: "discovered_regression", state: mapState(summary.publicRegressionState) }]
      : []),
    ...(summary.reproConsensusState !== undefined
      ? [{ source: "repro_consensus", state: mapState(summary.reproConsensusState) }]
      : []),
  ]
}

export const buildSelectionExplanationPacket = (
  input: SelectionExplanationLlmEvidenceInput,
): LlmEvidencePacket => {
  const missingEvidence: MissingEvidenceFact[] = [
    ...(input.winnerId === null ? [{ kind: "winner", reason: "no_selected_candidate" }] : []),
    ...(input.proofSummary?.proofRequiredMissing === true
      ? [{ kind: "executed_public_proof", reason: "no_positive_executed_public_proof" }]
      : []),
    ...(input.proofSummary?.proofState === "infra_blocked"
      ? [{ kind: "public_proof", reason: "public_proof_infra_blocked" }]
      : []),
  ]
  return cleanPacket({
    stage: "selection_explanation",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "selection-explanation-v2",
    question: "Explain the deterministic selection outcome and the remaining missing public evidence.",
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
    publicIssueFacts: describeIssueFacts(input.problemStatement),
    ownerEvidence: input.ownerFiles.map((file) => ({ file, symbols: [], provenance: "selection-owner" })),
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
      ...input.candidates.map((c) => ({
        kind: `candidate:${c.id}`,
        value: `admissible=${c.admissible}; files=${fmtList(c.files)}; reasons=${fmtList(c.reasons)}`,
      })),
    ],
    missingEvidence,
  })
}
