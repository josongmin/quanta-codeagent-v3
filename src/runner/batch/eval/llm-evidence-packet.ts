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
  if (packet.candidateEditSurface !== undefined) {
    out.push(
      ...packet.candidateEditSurface.touchedFiles,
      ...packet.candidateEditSurface.touchedSymbols,
    )
    if (packet.candidateEditSurface.patchSummary !== undefined) {
      out.push(packet.candidateEditSurface.patchSummary)
    }
  }
  if (packet.verificationTarget !== undefined) {
    const steps = [
      ...(packet.verificationTarget.primaryRail ? [packet.verificationTarget.primaryRail] : []),
      ...packet.verificationTarget.required,
      ...packet.verificationTarget.optional,
    ]
    for (const st of steps) {
      if (st.cmd !== undefined) out.push(st.cmd)
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

const LLM_EVIDENCE_STAGE_ORDER: readonly LlmEvidencePacketStage[] = [
  "intake",
  "candidate_generation",
  "candidate_review",
  "candidate_post_review",
  "repair_seed",
  "selection_explanation",
]

const stagePackets = (
  artifacts: LlmEvidenceArtifacts,
  stage: LlmEvidencePacketStage,
): readonly LlmEvidencePacket[] => {
  if (stage === "intake") return artifacts.intake !== undefined ? [artifacts.intake] : []
  if (stage === "candidate_review") {
    if ((artifacts.candidateReviewHistory?.length ?? 0) > 0)
      return artifacts.candidateReviewHistory ?? []
    return artifacts.candidateReview !== undefined ? [artifacts.candidateReview] : []
  }
  if (stage === "candidate_post_review") {
    if ((artifacts.candidatePostReviewHistory?.length ?? 0) > 0) {
      return artifacts.candidatePostReviewHistory ?? []
    }
    return artifacts.candidatePostReview !== undefined ? [artifacts.candidatePostReview] : []
  }
  if (stage === "candidate_generation") {
    if ((artifacts.candidateGenerationHistory?.length ?? 0) > 0)
      return artifacts.candidateGenerationHistory ?? []
    return artifacts.candidateGeneration !== undefined ? [artifacts.candidateGeneration] : []
  }
  if (stage === "repair_seed") {
    if ((artifacts.repairSeedHistory?.length ?? 0) > 0) return artifacts.repairSeedHistory ?? []
    return artifacts.repairSeed !== undefined ? [artifacts.repairSeed] : []
  }
  if (stage === "selection_explanation") {
    if ((artifacts.selectionExplanationHistory?.length ?? 0) > 0) {
      return artifacts.selectionExplanationHistory ?? []
    }
    return artifacts.selectionExplanation !== undefined ? [artifacts.selectionExplanation] : []
  }
  return []
}

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

export const recordLlmEvidencePacket = (
  artifacts: Partial<LlmEvidenceArtifacts>,
  packet: LlmEvidencePacket,
): void => {
  const sink = artifacts as MutableLlmEvidenceArtifacts
  if (packet.stage === "intake" && sink.intake === undefined) {
    sink.intake = packet
  } else if (packet.stage === "candidate_review" && sink.candidateReview === undefined) {
    sink.candidateReview = packet
    sink.candidateReviewHistory = [packet]
  } else if (packet.stage === "candidate_review") {
    sink.candidateReviewHistory = [
      ...(sink.candidateReviewHistory ??
        (sink.candidateReview !== undefined ? [sink.candidateReview] : [])),
      packet,
    ]
  } else if (packet.stage === "candidate_post_review" && sink.candidatePostReview === undefined) {
    sink.candidatePostReview = packet
    sink.candidatePostReviewHistory = [packet]
  } else if (packet.stage === "candidate_post_review") {
    sink.candidatePostReviewHistory = [
      ...(sink.candidatePostReviewHistory ??
        (sink.candidatePostReview !== undefined ? [sink.candidatePostReview] : [])),
      packet,
    ]
  } else if (packet.stage === "candidate_generation" && sink.candidateGeneration === undefined) {
    sink.candidateGeneration = packet
    sink.candidateGenerationHistory = [packet]
  } else if (packet.stage === "candidate_generation") {
    sink.candidateGenerationHistory = [
      ...(sink.candidateGenerationHistory ??
        (sink.candidateGeneration !== undefined ? [sink.candidateGeneration] : [])),
      packet,
    ]
  } else if (packet.stage === "repair_seed" && sink.repairSeed === undefined) {
    sink.repairSeed = packet
    sink.repairSeedHistory = [packet]
  } else if (packet.stage === "repair_seed") {
    sink.repairSeedHistory = [
      ...(sink.repairSeedHistory ?? (sink.repairSeed !== undefined ? [sink.repairSeed] : [])),
      packet,
    ]
  } else if (packet.stage === "selection_explanation" && sink.selectionExplanation === undefined) {
    sink.selectionExplanation = packet
    sink.selectionExplanationHistory = [packet]
  } else if (packet.stage === "selection_explanation") {
    sink.selectionExplanationHistory = [
      ...(sink.selectionExplanationHistory ??
        (sink.selectionExplanation !== undefined ? [sink.selectionExplanation] : [])),
      packet,
    ]
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
): MissingEvidenceFact[] =>
  ownerEvidence
    .filter((o) => o.sourceSlice === undefined)
    .map((o) => ({ kind: "owner_slice", reason: `no_resolvable_slice:${o.file}` }))

const firstNonEmptyLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)

const boundHead = (text: string, max = 220): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

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

/**
 * Static-witness-backed owner evidence. Carries witness kind/provenance/authority
 * and attaches an exact symbol slice when the witnessed symbol is statically
 * resolvable in that file.
 */
export const assembleStaticWitnessOwnerEvidence = (args: {
  readonly witnesses: readonly StaticWitness[]
  readonly readSource?: (rel: string) => string | null
}): OwnerEvidenceFact[] => {
  const out: OwnerEvidenceFact[] = []
  for (const witness of args.witnesses) {
    const files = uniqueLines(witness.subjectFiles)
    const symbols = uniqueLines(witness.subjectSymbols)
    for (const file of files) {
      const source = args.readSource?.(file) ?? null
      const slice =
        source === null
          ? undefined
          : symbols.map((symbol) => extractSymbolSlice(source, symbol)).find((s) => s !== undefined)
      out.push({
        file,
        symbols,
        provenance: `static-witness:${witness.kind}/${witness.provenance}/${witness.authority}`,
        ...(slice !== undefined ? { sourceSlice: slice } : {}),
      })
    }
  }
  return uniqueObjects(out)
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
  const toStep = (step: VerificationStep): VerificationStepFact => {
    const cmdIsBlind = step.kind === "repro"
    return {
      kind: step.kind,
      ...(cmdIsBlind ? { cmd: step.cmd } : { cmdWithheld: true }),
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
      ...(repro.sampleStdoutTail !== undefined
        ? { stdoutTail: boundHead(repro.sampleStdoutTail, 600) }
        : {}),
      ...(repro.sampleStderrTail !== undefined
        ? { stderrTail: boundHead(repro.sampleStderrTail, 600) }
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

export interface SelectionGenerationPacketInput {
  readonly problemStatement: string
  readonly ownerEvidence: readonly OwnerEvidenceFact[]
  readonly contracts: readonly ContractFact[]
  readonly verificationTarget?: VerificationTargetFact
  readonly reproCommand?: string
  readonly validatedReproScripts?: readonly string[]
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
  ])
  const missingEvidence: MissingEvidenceFact[] = [
    ...(input.reproCommand === undefined
      ? [{ kind: "public_repro", reason: "no_executable_public_repro_hint" }]
      : []),
    ...(input.verificationTarget === undefined
      ? [{ kind: "verification_target", reason: "no_verification_plan_available" }]
      : []),
    ...ownerSliceMissingEvidence(input.ownerEvidence),
  ]
  const proofReceipts: ProofReceiptFact[] =
    input.reproCommand === undefined
      ? []
      : [
          {
            source: "public_mwe",
            state: input.baseValidatedRed === true ? "base_red" : "static_only",
            command: input.reproCommand,
            ...(input.baseValidatedRed !== undefined
              ? { baseValidatedRed: input.baseValidatedRed }
              : {}),
          },
        ]
  return cleanPacket({
    stage: "candidate_generation",
    instanceIdHash: opaqueInstanceIdHash(input.problemStatement),
    evidenceRevision: "selection-generation-v2",
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
    publicIssueFacts: [
      ...describeIssueFacts(input.problemStatement, "candidate_generation"),
      ...(input.closureHint !== undefined && input.closureHint.trim() !== ""
        ? [`co-change hint: ${boundHead(input.closureHint, 400)}`]
        : []),
      ...(input.envCaveats ?? []).map((c) => `env caveat: ${c}`),
    ],
    ownerEvidence: input.ownerEvidence,
    proofReceipts,
    contractFacts: input.contracts,
    staticFacts: [
      // Evidence-toned framing for the scripts below (the old aggressive
      // "MUST pass" contract-seed was removed; a short note keeps the LLM
      // context-aware WITHOUT inviting reward-hacking the self-generated oracle).
      ...((input.validatedReproScripts ?? []).some((s) => s.trim() !== "")
        ? [
            {
              kind: "validated_public_repro_note",
              value:
                "Scripts below reproduce the issue on the UNPATCHED tree — they reflect the bug's observable behavior. Use them to understand the ROOT CAUSE; a correct fix should make them report `Issue resolved`, but fix the root cause rather than contorting the patch to satisfy any single script.",
            },
          ]
        : []),
      ...(input.validatedReproScripts ?? [])
        .map((source) => source.trim())
        .filter((source) => source !== "")
        .slice(0, 2)
        .map((source, i) => ({
          kind: "validated_public_repro",
          value: `script ${i + 1}: ${boundHead(source, 1200)}`,
        })),
      ...(input.seed !== undefined && input.seed.trim() !== ""
        ? [{ kind: "diversity_seed", value: boundHead(input.seed, 400) }]
        : []),
    ],
    ...(input.verificationTarget !== undefined
      ? { verificationTarget: input.verificationTarget }
      : {}),
    missingEvidence,
  })
}

export const buildSelectionGenerationPacket = (input: SelectionGenerationPacketInput): string =>
  renderLlmEvidencePacket(buildSelectionGenerationLlmEvidencePacket(input))

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
    ...(input.closureHint !== undefined ? { closureHint: input.closureHint } : {}),
    ...(input.envCaveats !== undefined && input.envCaveats.length > 0
      ? { envCaveats: input.envCaveats }
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

export const buildCandidateReviewPacket = (input: CandidateReviewPacketInput): string =>
  renderLlmEvidencePacket(buildCandidateReviewLlmEvidencePacket(input))

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
  readonly missingEvidence?: readonly MissingEvidenceFact[]
}

export const buildCandidatePostReviewLlmEvidencePacket = (
  input: CandidatePostReviewPacketInput,
): LlmEvidencePacket =>
  cleanPacket({
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
    ],
  })

export const buildCandidatePostReviewPacket = (input: CandidatePostReviewPacketInput): string =>
  renderLlmEvidencePacket(buildCandidatePostReviewLlmEvidencePacket(input))

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

export const buildRepairSeedPacket = (input: RepairSeedPacketInput): string =>
  renderLlmEvidencePacket(buildRepairSeedLlmEvidencePacket(input))

/* ------------------------------------------------------------------ */
/* Selection explanation packet (report-only RCA)                      */
/* ------------------------------------------------------------------ */

export interface SelectionExplanationCandidateInput {
  readonly id: string
  readonly files: readonly string[]
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
  return [
    ...(() => {
      const state = publicMweReceiptState(summary.publicMweState)
      return state === undefined ? [] : [{ source: "public_mwe", state }]
    })(),
    ...(() => {
      const state = publicRegressionReceiptState(summary.publicRegressionState)
      return state === undefined ? [] : [{ source: "discovered_regression", state }]
    })(),
    ...(() => {
      const state = reproConsensusReceiptState(summary.reproConsensusState)
      return state === undefined ? [] : [{ source: "repro_consensus", state }]
    })(),
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
      ...input.candidates.map((c) => ({
        kind: `candidate:${c.id}`,
        value: `admissible=${c.admissible}; files=${fmtList(c.files)}; reasons=${fmtList(c.reasons)}`,
      })),
    ],
    missingEvidence,
  })
}
