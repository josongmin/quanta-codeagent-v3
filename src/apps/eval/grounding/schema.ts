import type { AgentMode } from "@/agent"
import type { WorkingState } from "@/agent/working-state"
import type { ContextUpdateField } from "@/memory/typed-event"
import { isRecord } from "@/shared"
import type { UseCaseId } from "../types"

export const GROUNDING_SCHEMA_VERSION = 2 as const
export const GROUNDING_USECASE = "persistent-context.conversation-state.thread-grounding" as const

export const GROUNDING_INTENTS = [
  "status_check",
  "execute_change",
  "explain",
  "approval_request",
  "clarify_request",
  "fact_lookup",
] as const
export type GroundingIntent = (typeof GROUNDING_INTENTS)[number]

export const GROUNDING_SCOPES = [
  "current_workstream",
  "entire_session",
  "latest_tool_result",
  "specific_file",
  "specific_subthread",
] as const
export type GroundingScope = (typeof GROUNDING_SCOPES)[number]

export const GROUNDING_CONFIDENCE = ["high", "medium", "low"] as const
export type GroundingConfidence = (typeof GROUNDING_CONFIDENCE)[number]

export const GROUNDING_BUCKETS = [
  "ellipsis",
  "reference",
  "multi_workstream",
  "topic_switch_return",
  "tool_noise",
  "summary_equivalence",
  "stale_context_trap",
  "must_clarify",
  "wrong_thread_adversarial",
] as const
export type GroundingBucket = (typeof GROUNDING_BUCKETS)[number]

export const GROUNDING_SEVERITIES = ["critical", "high", "medium"] as const
export type GroundingSeverity = (typeof GROUNDING_SEVERITIES)[number]

export const GROUNDING_SUITES = ["canary", "nightly"] as const
export type GroundingSuite = (typeof GROUNDING_SUITES)[number]

export const GROUNDING_CORPORA = [
  "canary",
  "nightly",
  "replay_critical",
  "replay_nightly",
  "adversarial_canary",
  "adversarial_nightly",
] as const
export type GroundingCorpus = (typeof GROUNDING_CORPORA)[number]

export const GROUNDING_MODES = ["raw", "engine", "assisted"] as const
export type GroundingMode = (typeof GROUNDING_MODES)[number]

export const GROUNDING_PROBE_PROFILES = ["minimal", "runtime_parity", "assisted"] as const
export type GroundingProbeProfile = (typeof GROUNDING_PROBE_PROFILES)[number]

export const GROUNDING_NORMALIZATION_PROFILES = ["none", "structural", "heuristic"] as const
export type GroundingNormalizationProfile = (typeof GROUNDING_NORMALIZATION_PROFILES)[number]

export const GROUNDING_OUTPUT_PROTOCOLS = ["exact_json", "provider_structured_object"] as const
export type GroundingOutputProtocol = (typeof GROUNDING_OUTPUT_PROTOCOLS)[number]

export const GROUNDING_AMBIGUITY_CLASSES = [
  "none",
  "thread",
  "file",
  "subthread",
  "tool_result",
] as const
export type GroundingAmbiguityClass = (typeof GROUNDING_AMBIGUITY_CLASSES)[number]

export const GROUNDING_PAIR_ROLES = ["raw", "summary"] as const
export type GroundingPairRole = (typeof GROUNDING_PAIR_ROLES)[number]

export const GROUNDING_HISTORY_KINDS = ["message", "directive", "tool_result", "summary"] as const
export type GroundingHistoryKind = (typeof GROUNDING_HISTORY_KINDS)[number]

export const GROUNDING_HISTORY_METADATA_FIELDS = [
  "kind",
  "threadId",
  "referentId",
  "mentionedFileIds",
  "mentionedReferentIds",
  "toolName",
  "mentionedThreadIds",
  "policyMarkers",
] as const

export const GROUNDING_STATE_CONTRACT_FIELDS = [
  "activeThreadId",
  "visibleThreadIds",
  "pausedThreadIds",
  "latestToolResultId",
  "latestToolName",
  "candidateFileIds",
  "primaryFileId",
  "policyMarkers",
] as const

export const GROUNDING_HARNESS_CONTRACT = {
  schemaVersion: GROUNDING_SCHEMA_VERSION,
  usecase: GROUNDING_USECASE,
  intents: GROUNDING_INTENTS,
  scopes: GROUNDING_SCOPES,
  confidence: GROUNDING_CONFIDENCE,
  buckets: GROUNDING_BUCKETS,
  severities: GROUNDING_SEVERITIES,
  corpora: GROUNDING_CORPORA,
  modes: GROUNDING_MODES,
  probeProfiles: GROUNDING_PROBE_PROFILES,
  normalizationProfiles: GROUNDING_NORMALIZATION_PROFILES,
  outputProtocols: GROUNDING_OUTPUT_PROTOCOLS,
  ambiguityClasses: GROUNDING_AMBIGUITY_CLASSES,
  suites: GROUNDING_SUITES,
  pairRoles: GROUNDING_PAIR_ROLES,
  historyKinds: GROUNDING_HISTORY_KINDS,
  historyMetadataFields: GROUNDING_HISTORY_METADATA_FIELDS,
  stateContractFields: GROUNDING_STATE_CONTRACT_FIELDS,
  gateProfiles: ["canary"],
  regressionProfiles: ["strict"],
} as const

const AGENT_MODES = ["default", "plan", "review", "audit", "architect", "editor"] as const

export interface GroundingHistoryEntry {
  role: "user" | "assistant"
  text: string
  kind?: GroundingHistoryKind
  threadId?: string | null
  referentId?: string | null
  mentionedFileIds?: readonly string[]
  mentionedReferentIds?: readonly string[]
  toolName?: string
  mentionedThreadIds?: readonly string[]
  policyMarkers?: readonly string[]
}

export interface GroundingStateContract {
  activeThreadId: string | null
  visibleThreadIds?: readonly string[]
  pausedThreadIds?: readonly string[]
  latestToolResultId?: string | null
  latestToolName?: string
  candidateFileIds?: readonly string[]
  primaryFileId?: string | null
  policyMarkers?: readonly string[]
}

export interface GroundingSourceProvenance {
  kind: "manual" | "trajectory_freeze" | "session_freeze"
  sessionId?: string
  seqRange?: readonly [number, number]
}

export interface GroundingHumanAudit {
  status: "none" | "reviewed"
  reviewer?: string
  reviewedAt?: string
}

export interface GroundingContextChange {
  field: ContextUpdateField
  prev: unknown
  next: unknown
  at?: number
}

export interface GroundingDecision {
  activeThreadId: string | null
  referentId: string | null
  intent: GroundingIntent
  scope: GroundingScope
  shouldClarify: boolean
  confidence: GroundingConfidence
}

export interface GroundingCase {
  schema: typeof GROUNDING_SCHEMA_VERSION
  id: string
  usecase: UseCaseId
  corpus?: GroundingCorpus
  history: readonly GroundingHistoryEntry[]
  targetUtterance: string
  gold: GroundingDecision
  bucket: GroundingBucket
  severity: GroundingSeverity
  mode?: AgentMode
  cwd?: string
  memoryContext?: string
  workingState?: WorkingState
  repoRulesText?: string
  contextChanges?: readonly GroundingContextChange[]
  stateContract?: GroundingStateContract
  candidateThreadIds?: readonly string[]
  candidateReferentIds?: readonly string[]
  ambiguityClass?: GroundingAmbiguityClass
  blockingEligible?: boolean
  sourceProvenance?: GroundingSourceProvenance
  humanAudit?: GroundingHumanAudit
  pairId?: string
  pairRole?: GroundingPairRole
}

const isOneOf = <T extends readonly string[]>(value: unknown, items: T): value is T[number] =>
  typeof value === "string" && (items as readonly string[]).includes(value)

const parseStringList = (raw: unknown, label: string): readonly string[] => {
  if (!Array.isArray(raw)) throw new Error(`${label} must be an array of strings`)
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`${label} must be an array of strings`)
    }
    out.push(entry)
  }
  return out
}

/** The history entry's optional METADATA, already validated by the caller — so
 *  this step only decides which keys are present, never whether they are legal. */
const historyEntryMetadata = (
  raw: Record<string, unknown>,
  narrowed: {
    readonly kind: GroundingHistoryKind | undefined
    readonly threadId: unknown
    readonly referentId: unknown
    readonly toolName: string | undefined
  },
): Omit<GroundingHistoryEntry, "role" | "text"> => ({
  ...(narrowed.kind !== undefined ? { kind: narrowed.kind } : {}),
  ...(narrowed.threadId !== undefined ? { threadId: narrowed.threadId as string | null } : {}),
  ...(narrowed.referentId !== undefined
    ? { referentId: narrowed.referentId as string | null }
    : {}),
  ...(raw.mentionedFileIds !== undefined
    ? { mentionedFileIds: parseStringList(raw.mentionedFileIds, "history entry mentionedFileIds") }
    : {}),
  ...(raw.mentionedReferentIds !== undefined
    ? {
        mentionedReferentIds: parseStringList(
          raw.mentionedReferentIds,
          "history entry mentionedReferentIds",
        ),
      }
    : {}),
  ...(narrowed.toolName !== undefined ? { toolName: narrowed.toolName } : {}),
  ...(raw.mentionedThreadIds !== undefined
    ? {
        mentionedThreadIds: parseStringList(
          raw.mentionedThreadIds,
          "history entry mentionedThreadIds",
        ),
      }
    : {}),
  ...(raw.policyMarkers !== undefined
    ? { policyMarkers: parseStringList(raw.policyMarkers, "history entry policyMarkers") }
    : {}),
})

const parseHistoryEntry = (raw: unknown): GroundingHistoryEntry => {
  if (!isRecord(raw)) throw new Error("history entry must be an object")
  const role = raw.role
  const text = raw.text
  if ((role !== "user" && role !== "assistant") || typeof text !== "string") {
    throw new Error("history entry requires role=user|assistant and text:string")
  }
  const kind = raw.kind
  if (kind !== undefined && !isOneOf(kind, GROUNDING_HISTORY_KINDS)) {
    throw new Error(`history entry kind must be one of ${GROUNDING_HISTORY_KINDS.join(", ")}`)
  }
  if ((kind === "summary" || kind === "tool_result") && role !== "assistant") {
    throw new Error(`history entry kind=${String(kind)} requires role=assistant`)
  }
  const threadId = raw.threadId
  if (threadId !== undefined && threadId !== null && typeof threadId !== "string") {
    throw new Error("history entry threadId must be string|null when present")
  }
  const referentId = raw.referentId
  if (referentId !== undefined && referentId !== null && typeof referentId !== "string") {
    throw new Error("history entry referentId must be string|null when present")
  }
  const toolName = raw.toolName
  if (toolName !== undefined && typeof toolName !== "string") {
    throw new Error("history entry toolName must be a string when present")
  }
  return {
    role,
    text,
    ...historyEntryMetadata(raw, { kind, threadId, referentId, toolName }),
  }
}

/** Everything the state contract may carry BESIDES the required active thread.
 *  Already validated by the caller; this step is pure projection. */
const stateContractOptionalFields = (
  raw: Record<string, unknown>,
  narrowed: {
    readonly latestToolResultId: unknown
    readonly latestToolName: string | undefined
    readonly primaryFileId: unknown
  },
): Omit<GroundingStateContract, "activeThreadId"> => ({
  ...(raw.visibleThreadIds !== undefined
    ? {
        visibleThreadIds: parseStringList(
          raw.visibleThreadIds,
          "grounding case stateContract.visibleThreadIds",
        ),
      }
    : {}),
  ...(raw.pausedThreadIds !== undefined
    ? {
        pausedThreadIds: parseStringList(
          raw.pausedThreadIds,
          "grounding case stateContract.pausedThreadIds",
        ),
      }
    : {}),
  ...(narrowed.latestToolResultId !== undefined
    ? { latestToolResultId: narrowed.latestToolResultId as string | null }
    : {}),
  ...(narrowed.latestToolName !== undefined ? { latestToolName: narrowed.latestToolName } : {}),
  ...(raw.candidateFileIds !== undefined
    ? {
        candidateFileIds: parseStringList(
          raw.candidateFileIds,
          "grounding case stateContract.candidateFileIds",
        ),
      }
    : {}),
  ...(narrowed.primaryFileId !== undefined
    ? { primaryFileId: narrowed.primaryFileId as string | null }
    : {}),
  ...(raw.policyMarkers !== undefined
    ? {
        policyMarkers: parseStringList(
          raw.policyMarkers,
          "grounding case stateContract.policyMarkers",
        ),
      }
    : {}),
})

const parseStateContract = (raw: unknown): GroundingStateContract => {
  if (!isRecord(raw)) throw new Error("grounding case stateContract must be an object")
  const activeThreadId = raw.activeThreadId
  if (activeThreadId !== null && typeof activeThreadId !== "string") {
    throw new Error("grounding case stateContract.activeThreadId must be string|null")
  }
  const latestToolResultId = raw.latestToolResultId
  if (
    latestToolResultId !== undefined &&
    latestToolResultId !== null &&
    typeof latestToolResultId !== "string"
  ) {
    throw new Error(
      "grounding case stateContract.latestToolResultId must be string|null when present",
    )
  }
  const latestToolName = raw.latestToolName
  if (latestToolName !== undefined && typeof latestToolName !== "string") {
    throw new Error("grounding case stateContract.latestToolName must be a string when present")
  }
  const primaryFileId = raw.primaryFileId
  if (primaryFileId !== undefined && primaryFileId !== null && typeof primaryFileId !== "string") {
    throw new Error("grounding case stateContract.primaryFileId must be string|null when present")
  }
  return {
    activeThreadId,
    ...stateContractOptionalFields(raw, { latestToolResultId, latestToolName, primaryFileId }),
  }
}

const parseSourceProvenance = (raw: unknown): GroundingSourceProvenance => {
  if (!isRecord(raw)) throw new Error("grounding case sourceProvenance must be an object")
  const kind = raw.kind
  if (kind !== "manual" && kind !== "trajectory_freeze" && kind !== "session_freeze") {
    throw new Error(
      "grounding case sourceProvenance.kind must be manual|trajectory_freeze|session_freeze",
    )
  }
  const sessionId = raw.sessionId
  if (sessionId !== undefined && typeof sessionId !== "string") {
    throw new Error("grounding case sourceProvenance.sessionId must be a string when present")
  }
  const seqRange = raw.seqRange
  if (
    seqRange !== undefined &&
    (!Array.isArray(seqRange) ||
      seqRange.length !== 2 ||
      typeof seqRange[0] !== "number" ||
      typeof seqRange[1] !== "number")
  ) {
    throw new Error(
      "grounding case sourceProvenance.seqRange must be a [number, number] tuple when present",
    )
  }
  return {
    kind,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(seqRange !== undefined ? { seqRange: [seqRange[0], seqRange[1]] as [number, number] } : {}),
  }
}

const parseHumanAudit = (raw: unknown): GroundingHumanAudit => {
  if (!isRecord(raw)) throw new Error("grounding case humanAudit must be an object")
  const status = raw.status
  if (status !== "none" && status !== "reviewed") {
    throw new Error("grounding case humanAudit.status must be none|reviewed")
  }
  const reviewer = raw.reviewer
  if (reviewer !== undefined && typeof reviewer !== "string") {
    throw new Error("grounding case humanAudit.reviewer must be a string when present")
  }
  const reviewedAt = raw.reviewedAt
  if (reviewedAt !== undefined && typeof reviewedAt !== "string") {
    throw new Error("grounding case humanAudit.reviewedAt must be a string when present")
  }
  return {
    status,
    ...(reviewer !== undefined ? { reviewer } : {}),
    ...(reviewedAt !== undefined ? { reviewedAt } : {}),
  }
}

const parseDecision = (raw: unknown, label: string): GroundingDecision => {
  if (!isRecord(raw)) throw new Error(`${label} must be an object`)
  const activeThreadId = raw.activeThreadId
  const referentId = raw.referentId
  const intent = raw.intent
  const scope = raw.scope
  const shouldClarify = raw.shouldClarify
  const confidence = raw.confidence
  if (activeThreadId !== null && typeof activeThreadId !== "string") {
    throw new Error(`${label}.activeThreadId must be string|null`)
  }
  if (referentId !== null && typeof referentId !== "string") {
    throw new Error(`${label}.referentId must be string|null`)
  }
  if (!isOneOf(intent, GROUNDING_INTENTS)) {
    throw new Error(`${label}.intent must be one of ${GROUNDING_INTENTS.join(", ")}`)
  }
  if (!isOneOf(scope, GROUNDING_SCOPES)) {
    throw new Error(`${label}.scope must be one of ${GROUNDING_SCOPES.join(", ")}`)
  }
  if (typeof shouldClarify !== "boolean") {
    throw new Error(`${label}.shouldClarify must be boolean`)
  }
  if (!isOneOf(confidence, GROUNDING_CONFIDENCE)) {
    throw new Error(`${label}.confidence must be one of ${GROUNDING_CONFIDENCE.join(", ")}`)
  }
  return { activeThreadId, referentId, intent, scope, shouldClarify, confidence }
}

const parseContextChange = (raw: unknown): GroundingContextChange => {
  if (!isRecord(raw)) throw new Error("contextChanges entry must be an object")
  const field = raw.field
  if (
    field !== "cwd" &&
    field !== "mode" &&
    field !== "repo_rules" &&
    field !== "active_skills" &&
    field !== "model"
  ) {
    throw new Error("contextChanges.field must be one of cwd|mode|repo_rules|active_skills|model")
  }
  const at = raw.at
  if (at !== undefined && (typeof at !== "number" || !Number.isFinite(at))) {
    throw new Error("contextChanges.at must be a finite number when present")
  }
  return {
    field,
    prev: raw.prev,
    next: raw.next,
    ...(typeof at === "number" ? { at } : {}),
  }
}

/** The case's REQUIRED spine: the fields without which it is not a case at all. */
interface GroundingCaseSpine {
  readonly id: string
  readonly history: readonly unknown[]
  readonly targetUtterance: string
  readonly bucket: GroundingBucket
  readonly severity: GroundingSeverity
}

const parseCaseSpine = (raw: Record<string, unknown>): GroundingCaseSpine => {
  const schema = raw.schema
  if (schema !== GROUNDING_SCHEMA_VERSION) {
    throw new Error(
      `grounding case schema mismatch: got ${String(schema)}, want ${GROUNDING_SCHEMA_VERSION}`,
    )
  }
  const id = raw.id
  const usecase = raw.usecase
  const history = raw.history
  const targetUtterance = raw.targetUtterance
  const bucket = raw.bucket
  const severity = raw.severity
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error("grounding case id must be a non-empty string")
  }
  if (usecase !== GROUNDING_USECASE) {
    throw new Error(`grounding case usecase must equal ${GROUNDING_USECASE}`)
  }
  if (!Array.isArray(history)) throw new Error("grounding case history must be an array")
  if (typeof targetUtterance !== "string" || targetUtterance.trim() === "") {
    throw new Error("grounding case targetUtterance must be a non-empty string")
  }
  if (!isOneOf(bucket, GROUNDING_BUCKETS)) {
    throw new Error(`grounding case bucket must be one of ${GROUNDING_BUCKETS.join(", ")}`)
  }
  if (!isOneOf(severity, GROUNDING_SEVERITIES)) {
    throw new Error(`grounding case severity must be one of ${GROUNDING_SEVERITIES.join(", ")}`)
  }
  return { id, history, targetUtterance, bucket, severity }
}

/** The run-context descriptors: which corpus/mode the case belongs to and the
 *  free-text environment it was captured in. All optional, all validated here. */
interface GroundingCaseDescriptors {
  readonly corpus: GroundingCorpus | undefined
  readonly mode: AgentMode | undefined
  readonly cwd: string | undefined
  readonly memoryContext: string | undefined
  readonly repoRulesText: string | undefined
}

const parseCaseDescriptors = (raw: Record<string, unknown>): GroundingCaseDescriptors => {
  const corpus = raw.corpus
  if (corpus !== undefined && !isOneOf(corpus, GROUNDING_CORPORA)) {
    throw new Error(`grounding case corpus must be one of ${GROUNDING_CORPORA.join(", ")}`)
  }
  const mode = raw.mode
  if (mode !== undefined && !isOneOf(mode, AGENT_MODES)) {
    throw new Error(`grounding case mode must be one of ${AGENT_MODES.join(", ")}`)
  }
  const cwd = raw.cwd
  if (cwd !== undefined && typeof cwd !== "string") {
    throw new Error("grounding case cwd must be a string when present")
  }
  const memoryContext = raw.memoryContext
  if (memoryContext !== undefined && typeof memoryContext !== "string") {
    throw new Error("grounding case memoryContext must be a string when present")
  }
  const repoRulesText = raw.repoRulesText
  if (repoRulesText !== undefined && typeof repoRulesText !== "string") {
    throw new Error("grounding case repoRulesText must be a string when present")
  }
  return { corpus, mode, cwd, memoryContext, repoRulesText }
}

/** The ambiguity/pairing markers, plus the two cross-field rules they carry:
 *  a pair ROLE is meaningless without a pair ID, and a paired case needs a
 *  state contract for the pair's two halves to be comparable at all. */
interface GroundingCaseMarkers {
  readonly ambiguityClass: GroundingAmbiguityClass | undefined
  readonly blockingEligible: boolean | undefined
  readonly pairId: string | undefined
  readonly pairRole: GroundingPairRole | undefined
}

const parseCaseMarkers = (raw: Record<string, unknown>): GroundingCaseMarkers => {
  const ambiguityClass = raw.ambiguityClass
  if (ambiguityClass !== undefined && !isOneOf(ambiguityClass, GROUNDING_AMBIGUITY_CLASSES)) {
    throw new Error(
      `grounding case ambiguityClass must be one of ${GROUNDING_AMBIGUITY_CLASSES.join(", ")}`,
    )
  }
  const blockingEligible = raw.blockingEligible
  if (blockingEligible !== undefined && typeof blockingEligible !== "boolean") {
    throw new Error("grounding case blockingEligible must be a boolean when present")
  }
  const pairId = raw.pairId
  const pairRole = raw.pairRole
  if (pairId !== undefined && typeof pairId !== "string") {
    throw new Error("grounding case pairId must be a string when present")
  }
  if (pairRole !== undefined && !isOneOf(pairRole, GROUNDING_PAIR_ROLES)) {
    throw new Error(`grounding case pairRole must be one of ${GROUNDING_PAIR_ROLES.join(", ")}`)
  }
  if (pairRole !== undefined && pairId === undefined) {
    throw new Error("grounding case pairRole requires pairId")
  }
  if (pairId !== undefined && raw.stateContract === undefined) {
    throw new Error("grounding case pairId requires stateContract")
  }
  return { ambiguityClass, blockingEligible, pairId, pairRole }
}

/** Projection of the descriptor block + the two raw passthrough fields that sit
 *  interleaved with it in the case's key order. */
const caseDescriptorFields = (
  raw: Record<string, unknown>,
  descriptors: GroundingCaseDescriptors,
): Pick<
  GroundingCase,
  "corpus" | "mode" | "cwd" | "memoryContext" | "workingState" | "repoRulesText" | "contextChanges"
> => ({
  ...(descriptors.corpus !== undefined ? { corpus: descriptors.corpus } : {}),
  ...(descriptors.mode !== undefined ? { mode: descriptors.mode } : {}),
  ...(descriptors.cwd !== undefined ? { cwd: descriptors.cwd } : {}),
  ...(descriptors.memoryContext !== undefined ? { memoryContext: descriptors.memoryContext } : {}),
  ...(raw.workingState !== undefined ? { workingState: raw.workingState as WorkingState } : {}),
  ...(descriptors.repoRulesText !== undefined ? { repoRulesText: descriptors.repoRulesText } : {}),
  ...(Array.isArray(raw.contextChanges)
    ? { contextChanges: raw.contextChanges.map(parseContextChange) }
    : {}),
})

/** Projection of the grounding-aid block: the state the case pins down and the
 *  candidate sets an ambiguous case offers. */
const caseGroundingAidFields = (
  raw: Record<string, unknown>,
  markers: GroundingCaseMarkers,
): Pick<
  GroundingCase,
  | "stateContract"
  | "candidateThreadIds"
  | "candidateReferentIds"
  | "ambiguityClass"
  | "blockingEligible"
> => ({
  ...(raw.stateContract !== undefined
    ? { stateContract: parseStateContract(raw.stateContract) }
    : {}),
  ...(raw.candidateThreadIds !== undefined
    ? {
        candidateThreadIds: parseStringList(
          raw.candidateThreadIds,
          "grounding case candidateThreadIds",
        ),
      }
    : {}),
  ...(raw.candidateReferentIds !== undefined
    ? {
        candidateReferentIds: parseStringList(
          raw.candidateReferentIds,
          "grounding case candidateReferentIds",
        ),
      }
    : {}),
  ...(markers.ambiguityClass !== undefined ? { ambiguityClass: markers.ambiguityClass } : {}),
  ...(markers.blockingEligible !== undefined ? { blockingEligible: markers.blockingEligible } : {}),
})

/** Projection of where the case CAME FROM and who signed off on it. */
const caseProvenanceFields = (
  raw: Record<string, unknown>,
  markers: GroundingCaseMarkers,
): Pick<GroundingCase, "sourceProvenance" | "humanAudit" | "pairId" | "pairRole"> => ({
  ...(raw.sourceProvenance !== undefined
    ? { sourceProvenance: parseSourceProvenance(raw.sourceProvenance) }
    : {}),
  ...(raw.humanAudit !== undefined ? { humanAudit: parseHumanAudit(raw.humanAudit) } : {}),
  ...(markers.pairId !== undefined ? { pairId: markers.pairId } : {}),
  ...(markers.pairRole !== undefined ? { pairRole: markers.pairRole } : {}),
})

/**
 * VALIDATE-THEN-PROJECT, in that order: every shape check runs (spine →
 * descriptors → markers) before the first nested parse, so a malformed case
 * still reports its FIRST structural error rather than a downstream one.
 */
export const parseGroundingCase = (raw: unknown): GroundingCase => {
  if (!isRecord(raw)) throw new Error("grounding case must be an object")
  const spine = parseCaseSpine(raw)
  const descriptors = parseCaseDescriptors(raw)
  const markers = parseCaseMarkers(raw)
  return {
    schema: GROUNDING_SCHEMA_VERSION,
    id: spine.id,
    usecase: GROUNDING_USECASE,
    history: spine.history.map(parseHistoryEntry),
    targetUtterance: spine.targetUtterance,
    gold: parseDecision(raw.gold, "gold"),
    bucket: spine.bucket,
    severity: spine.severity,
    ...caseDescriptorFields(raw, descriptors),
    ...caseGroundingAidFields(raw, markers),
    ...caseProvenanceFields(raw, markers),
  }
}
