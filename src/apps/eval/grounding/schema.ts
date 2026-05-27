import type { AgentMode } from "@/agent"
import type { WorkingState } from "@/agent/working-state"
import type { ContextUpdateField } from "@/memory/typed-event"
import type { UseCaseId } from "../types"

export const GROUNDING_SCHEMA_VERSION = 1 as const
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

export const GROUNDING_PAIR_ROLES = ["raw", "summary"] as const
export type GroundingPairRole = (typeof GROUNDING_PAIR_ROLES)[number]

const AGENT_MODES = ["default", "plan", "review", "audit", "architect", "editor"] as const

export interface GroundingHistoryEntry {
  role: "user" | "assistant"
  text: string
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
  pairId?: string
  pairRole?: GroundingPairRole
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isOneOf = <T extends readonly string[]>(value: unknown, items: T): value is T[number] =>
  typeof value === "string" && (items as readonly string[]).includes(value)

const parseHistoryEntry = (raw: unknown): GroundingHistoryEntry => {
  if (!isRecord(raw)) throw new Error("history entry must be an object")
  const role = raw["role"]
  const text = raw["text"]
  if ((role !== "user" && role !== "assistant") || typeof text !== "string") {
    throw new Error("history entry requires role=user|assistant and text:string")
  }
  return { role, text }
}

const parseDecision = (raw: unknown, label: string): GroundingDecision => {
  if (!isRecord(raw)) throw new Error(`${label} must be an object`)
  const activeThreadId = raw["activeThreadId"]
  const referentId = raw["referentId"]
  const intent = raw["intent"]
  const scope = raw["scope"]
  const shouldClarify = raw["shouldClarify"]
  const confidence = raw["confidence"]
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
  const field = raw["field"]
  if (
    field !== "cwd" &&
    field !== "mode" &&
    field !== "repo_rules" &&
    field !== "active_skills" &&
    field !== "model"
  ) {
    throw new Error("contextChanges.field must be one of cwd|mode|repo_rules|active_skills|model")
  }
  const at = raw["at"]
  if (at !== undefined && (typeof at !== "number" || !Number.isFinite(at))) {
    throw new Error("contextChanges.at must be a finite number when present")
  }
  return {
    field,
    prev: raw["prev"],
    next: raw["next"],
    ...(typeof at === "number" ? { at } : {}),
  }
}

export const parseGroundingCase = (raw: unknown): GroundingCase => {
  if (!isRecord(raw)) throw new Error("grounding case must be an object")
  const schema = raw["schema"]
  if (schema !== GROUNDING_SCHEMA_VERSION) {
    throw new Error(
      `grounding case schema mismatch: got ${String(schema)}, want ${GROUNDING_SCHEMA_VERSION}`,
    )
  }
  const id = raw["id"]
  const usecase = raw["usecase"]
  const history = raw["history"]
  const targetUtterance = raw["targetUtterance"]
  const bucket = raw["bucket"]
  const severity = raw["severity"]
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
  const mode = raw["mode"]
  if (mode !== undefined && !isOneOf(mode, AGENT_MODES)) {
    throw new Error(`grounding case mode must be one of ${AGENT_MODES.join(", ")}`)
  }
  const cwd = raw["cwd"]
  if (cwd !== undefined && typeof cwd !== "string") {
    throw new Error("grounding case cwd must be a string when present")
  }
  const memoryContext = raw["memoryContext"]
  if (memoryContext !== undefined && typeof memoryContext !== "string") {
    throw new Error("grounding case memoryContext must be a string when present")
  }
  const repoRulesText = raw["repoRulesText"]
  if (repoRulesText !== undefined && typeof repoRulesText !== "string") {
    throw new Error("grounding case repoRulesText must be a string when present")
  }
  const pairId = raw["pairId"]
  const pairRole = raw["pairRole"]
  if (pairId !== undefined && typeof pairId !== "string") {
    throw new Error("grounding case pairId must be a string when present")
  }
  if (pairRole !== undefined && !isOneOf(pairRole, GROUNDING_PAIR_ROLES)) {
    throw new Error(`grounding case pairRole must be one of ${GROUNDING_PAIR_ROLES.join(", ")}`)
  }
  if (pairRole !== undefined && pairId === undefined) {
    throw new Error("grounding case pairRole requires pairId")
  }
  return {
    schema: GROUNDING_SCHEMA_VERSION,
    id,
    usecase: GROUNDING_USECASE,
    history: history.map(parseHistoryEntry),
    targetUtterance,
    gold: parseDecision(raw["gold"], "gold"),
    bucket,
    severity,
    ...(mode !== undefined ? { mode } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(memoryContext !== undefined ? { memoryContext } : {}),
    ...(raw["workingState"] !== undefined ? { workingState: raw["workingState"] as WorkingState } : {}),
    ...(repoRulesText !== undefined ? { repoRulesText } : {}),
    ...(Array.isArray(raw["contextChanges"])
      ? { contextChanges: raw["contextChanges"].map(parseContextChange) }
      : {}),
    ...(pairId !== undefined ? { pairId } : {}),
    ...(pairRole !== undefined ? { pairRole } : {}),
  }
}
