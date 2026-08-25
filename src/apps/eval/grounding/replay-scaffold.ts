import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { SessionSnapshotLite } from "@/protocol/session/snapshot"
import type { TrajectoryEvent } from "@/shared"
import { loadSession } from "../trajectory/source"
import {
  GROUNDING_USECASE,
  type GroundingAmbiguityClass,
  type GroundingBucket,
  type GroundingCase,
  type GroundingCorpus,
  type GroundingDecision,
  type GroundingHistoryEntry,
  type GroundingHumanAudit,
  type GroundingSeverity,
  type GroundingSourceProvenance,
  type GroundingStateContract,
  parseGroundingCase,
} from "./schema"
import { stableJson } from "./stable-json"

export interface GroundingReplayDraft {
  schema: GroundingCase["schema"]
  id: string
  usecase: GroundingCase["usecase"]
  history: readonly GroundingHistoryEntry[]
  targetUtterance: string
  bucket: GroundingBucket
  severity: GroundingSeverity
  stateContract?: GroundingStateContract
  candidateThreadIds?: readonly string[]
  candidateReferentIds?: readonly string[]
  ambiguityClass?: GroundingAmbiguityClass
  sourceProvenance: GroundingSourceProvenance
  humanAudit: GroundingHumanAudit
}

export interface BuildGroundingReplayDraftOpts {
  source: string
  id: string
  targetUtterance: string
  bucket: GroundingBucket
  severity: GroundingSeverity
  stateContract?: GroundingStateContract
  sessionSnapshotPath?: string
  candidateThreadIds?: readonly string[]
  candidateReferentIds?: readonly string[]
  ambiguityClass?: GroundingAmbiguityClass
}

export interface WriteGroundingReplayDraftOpts extends BuildGroundingReplayDraftOpts {
  outPath: string
}

export interface PromoteGroundingReplayDraftOpts {
  draft: GroundingReplayDraft
  gold: GroundingDecision
  corpus: Extract<GroundingCorpus, "replay_critical" | "replay_nightly">
  blockingEligible?: boolean
  humanAudit?: GroundingHumanAudit
}

export interface WritePromotedGroundingReplayCaseOpts extends PromoteGroundingReplayDraftOpts {
  outPath: string
}

export interface GroundingReplayDraftResult {
  draft: GroundingReplayDraft
  draftText: string
  outPath: string
}

export interface GroundingReplayPromotionResult {
  fixture: GroundingCase
  fixtureText: string
  outPath: string
}

const DUMMY_GOLD: GroundingDecision = {
  activeThreadId: null,
  referentId: null,
  intent: "status_check",
  scope: "current_workstream",
  shouldClarify: false,
  confidence: "high",
}

const parseJsonFile = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T

const toPolicyMarkers = (
  snapshot: SessionSnapshotLite | undefined,
): readonly string[] | undefined => {
  const policy = snapshot?.state.lastLlmRequest?.policy
  if (policy === undefined) return undefined
  const out = new Set<string>()
  out.add(`mode:${policy.mode}`)
  out.add(`summary:${policy.summaryPrefix}`)
  for (const name of policy.selectedGlobRuleNames) out.add(`glob:${name}`)
  for (const name of policy.activeSkillNames) out.add(`skill:${name}`)
  return out.size === 0 ? undefined : [...out].sort()
}

/** `TrajectoryEvent.data` is untyped JSON, so every field read needs the same
 *  "string, else fall back" coercion. One helper instead of five inline
 *  ternaries each paying the collector loop's nesting surcharge. */
const dataString = (data: Record<string, unknown>, key: string, fallback: string): string => {
  const value = data[key]
  return typeof value === "string" ? value : fallback
}

/** Projects one `tool_result` event payload into a history entry. Its own unit
 *  because it is the only branch of the collector that reads four separate
 *  `data` fields, and because its empty-tail behaviour is a quirk worth
 *  stating: when BOTH tails are blank the filtered array is empty, so `tail`
 *  is `undefined`, `tail !== ""` is still TRUE, and the rendered text ends in
 *  the literal `": undefined"`. Recorded fixtures contain that string, so it
 *  is preserved verbatim rather than "fixed" here. */
const toToolResultEntry = (data: Record<string, unknown>): GroundingHistoryEntry => {
  const toolName = dataString(data, "name", "unknown_tool")
  const ok = data.ok === true
  const tail = [
    dataString(data, "stdoutTail", "").trim(),
    dataString(data, "stderrTail", "").trim(),
  ].filter((value) => value !== "")[0]
  return {
    role: "assistant",
    kind: "tool_result",
    toolName,
    text: `Tool ${toolName} ${ok ? "ok" : "error"}${tail !== "" ? `: ${tail}` : ""}`,
  }
}

/** Walks the trajectory once, keeping ONE piece of state: the assistant text
 *  accumulated since the last boundary. `turn_start` and `tool_result` are
 *  both boundaries — they flush the buffer before doing their own work — so
 *  the flush lives in a closure rather than being spelled at three sites. */
const collectAssistantHistory = (events: readonly TrajectoryEvent[]): GroundingHistoryEntry[] => {
  const out: GroundingHistoryEntry[] = []
  let assistantText = ""
  const flushAssistantText = (): void => {
    const text = assistantText.trim()
    if (text !== "") out.push({ role: "assistant", text })
    assistantText = ""
  }
  for (const event of events) {
    if (event.kind === "turn_start") flushAssistantText()
    if (event.kind === "assistant_text") {
      assistantText += dataString(event.data, "delta", "")
      continue
    }
    if (event.kind !== "tool_result") continue
    flushAssistantText()
    out.push(toToolResultEntry(event.data))
  }
  flushAssistantText()
  return out
}

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)].sort()

const lastToolResult = (
  history: readonly GroundingHistoryEntry[],
): GroundingHistoryEntry | undefined =>
  [...history].reverse().find((entry) => entry.kind === "tool_result")

const deriveActiveThreadId = (
  explicit: GroundingStateContract | undefined,
  history: readonly GroundingHistoryEntry[],
): string | null | undefined => {
  if (explicit?.activeThreadId !== undefined) return explicit.activeThreadId
  const threadIds = unique(
    history
      .map((entry) => entry.threadId)
      .filter((value): value is string => typeof value === "string" && value !== ""),
  )
  const [onlyThreadId, ...otherThreadIds] = threadIds
  if (onlyThreadId !== undefined && otherThreadIds.length === 0) return onlyThreadId
  return undefined
}

const deriveVisibleThreadIds = (
  explicit: GroundingStateContract | undefined,
  history: readonly GroundingHistoryEntry[],
  candidateThreadIds: readonly string[] | undefined,
): readonly string[] | undefined => {
  if (explicit?.visibleThreadIds !== undefined) return [...explicit.visibleThreadIds].sort()
  const derived = unique([
    ...(candidateThreadIds ?? []),
    ...history
      .map((entry) => entry.threadId)
      .filter((value): value is string => typeof value === "string" && value !== ""),
  ])
  return derived.length === 0 ? undefined : derived
}

const deriveLatestToolResultId = (
  explicit: GroundingStateContract | undefined,
  history: readonly GroundingHistoryEntry[],
): string | null | undefined => {
  if (explicit?.latestToolResultId !== undefined) return explicit.latestToolResultId
  const latest = lastToolResult(history)
  return latest?.referentId
}

const deriveLatestToolName = (
  explicit: GroundingStateContract | undefined,
  history: readonly GroundingHistoryEntry[],
): string | undefined => explicit?.latestToolName ?? lastToolResult(history)?.toolName

const deriveStateContract = (
  opts: BuildGroundingReplayDraftOpts,
  snapshot: SessionSnapshotLite | undefined,
  history: readonly GroundingHistoryEntry[],
): GroundingStateContract | undefined => {
  const explicit = opts.stateContract
  const activeThreadId = deriveActiveThreadId(explicit, history)
  const visibleThreadIds = deriveVisibleThreadIds(explicit, history, opts.candidateThreadIds)
  const latestToolResultId = deriveLatestToolResultId(explicit, history)
  const latestToolName = deriveLatestToolName(explicit, history)
  const policyMarkers = explicit?.policyMarkers ?? toPolicyMarkers(snapshot)
  const candidateFileIds = explicit?.candidateFileIds
  const primaryFileId = explicit?.primaryFileId
  const pausedThreadIds = explicit?.pausedThreadIds
  if (
    activeThreadId === undefined &&
    visibleThreadIds === undefined &&
    latestToolResultId === undefined &&
    latestToolName === undefined &&
    policyMarkers === undefined &&
    candidateFileIds === undefined &&
    primaryFileId === undefined &&
    pausedThreadIds === undefined
  ) {
    return undefined
  }
  return {
    activeThreadId: activeThreadId ?? null,
    ...(visibleThreadIds !== undefined ? { visibleThreadIds } : {}),
    ...(pausedThreadIds !== undefined ? { pausedThreadIds: [...pausedThreadIds].sort() } : {}),
    ...(latestToolResultId !== undefined ? { latestToolResultId } : {}),
    ...(latestToolName !== undefined ? { latestToolName } : {}),
    ...(candidateFileIds !== undefined ? { candidateFileIds: [...candidateFileIds].sort() } : {}),
    ...(primaryFileId !== undefined ? { primaryFileId } : {}),
    ...(policyMarkers !== undefined ? { policyMarkers } : {}),
  }
}

const validateReplayDraft = (raw: unknown): GroundingReplayDraft => {
  if (typeof raw !== "object" || raw === null)
    throw new Error("grounding replay draft must be an object")
  const obj = raw as Record<string, unknown>
  if ("gold" in obj) throw new Error("grounding replay draft must not include gold")
  if ("corpus" in obj) throw new Error("grounding replay draft must not include corpus")
  if ("blockingEligible" in obj) {
    throw new Error("grounding replay draft must not include blockingEligible")
  }
  const parsed = parseGroundingCase({
    ...obj,
    corpus: "replay_critical",
    gold: DUMMY_GOLD,
    blockingEligible: false,
  })
  return {
    schema: parsed.schema,
    id: parsed.id,
    usecase: parsed.usecase,
    history: parsed.history,
    targetUtterance: parsed.targetUtterance,
    bucket: parsed.bucket,
    severity: parsed.severity,
    ...(parsed.stateContract !== undefined ? { stateContract: parsed.stateContract } : {}),
    ...(parsed.candidateThreadIds !== undefined
      ? { candidateThreadIds: parsed.candidateThreadIds }
      : {}),
    ...(parsed.candidateReferentIds !== undefined
      ? { candidateReferentIds: parsed.candidateReferentIds }
      : {}),
    ...(parsed.ambiguityClass !== undefined ? { ambiguityClass: parsed.ambiguityClass } : {}),
    sourceProvenance: parsed.sourceProvenance ?? { kind: "manual" },
    humanAudit: parsed.humanAudit ?? { status: "none" },
  }
}

export const readGroundingReplayDraft = (path: string): GroundingReplayDraft =>
  validateReplayDraft(parseJsonFile<unknown>(path))

export const buildGroundingReplayDraft = (
  opts: BuildGroundingReplayDraftOpts,
): GroundingReplayDraft => {
  const session = loadSession(opts.source)
  const snapshot =
    opts.sessionSnapshotPath === undefined
      ? undefined
      : parseJsonFile<SessionSnapshotLite>(opts.sessionSnapshotPath)
  const history: GroundingHistoryEntry[] = []
  const promptText = session.meta?.userPrompt ?? snapshot?.state.lastUserText
  if (typeof promptText === "string" && promptText.trim() !== "") {
    history.push({ role: "user", text: promptText.trim() })
  }
  history.push(...collectAssistantHistory(session.events))
  if (history.length === 0) {
    history.push({
      role: "assistant",
      text: `Replay draft scaffolded from session ${session.sessionId}.`,
    })
  }
  const stateContract = deriveStateContract(opts, snapshot, history)
  // `at()` returns the element or undefined, so the emptiness check and the
  // reads are the same fact — where `events.length > 0` left both endpoint
  // reads asserted.
  const firstEvent = session.events.at(0)
  const lastEvent = session.events.at(-1)
  const provenance: GroundingSourceProvenance = {
    kind: opts.sessionSnapshotPath === undefined ? "trajectory_freeze" : "session_freeze",
    sessionId: session.sessionId,
    ...(firstEvent !== undefined && lastEvent !== undefined
      ? { seqRange: [firstEvent.seq, lastEvent.seq] as const }
      : {}),
  }
  return validateReplayDraft({
    schema: 2,
    id: opts.id,
    usecase: GROUNDING_USECASE,
    history,
    targetUtterance: opts.targetUtterance,
    bucket: opts.bucket,
    severity: opts.severity,
    ...(stateContract !== undefined ? { stateContract } : {}),
    ...(opts.candidateThreadIds !== undefined
      ? { candidateThreadIds: opts.candidateThreadIds }
      : {}),
    ...(opts.candidateReferentIds !== undefined
      ? { candidateReferentIds: opts.candidateReferentIds }
      : {}),
    ...(opts.ambiguityClass !== undefined ? { ambiguityClass: opts.ambiguityClass } : {}),
    sourceProvenance: provenance,
    humanAudit: { status: "none" },
  })
}

export const writeGroundingReplayDraft = (
  opts: WriteGroundingReplayDraftOpts,
): GroundingReplayDraftResult => {
  const draft = buildGroundingReplayDraft(opts)
  const outPath = resolve(process.cwd(), opts.outPath)
  const draftText = `${stableJson(draft)}\n`
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, draftText)
  return { draft, draftText, outPath }
}

export const promoteGroundingReplayDraft = (
  opts: PromoteGroundingReplayDraftOpts,
): GroundingCase => {
  const humanAudit = opts.humanAudit ?? opts.draft.humanAudit ?? { status: "none" }
  const blockingEligible = opts.blockingEligible ?? false
  if (blockingEligible && humanAudit.status !== "reviewed") {
    throw new Error("blockingEligible replay cases require humanAudit.status=reviewed")
  }
  return parseGroundingCase({
    schema: opts.draft.schema,
    id: opts.draft.id,
    usecase: opts.draft.usecase,
    corpus: opts.corpus,
    history: opts.draft.history,
    targetUtterance: opts.draft.targetUtterance,
    gold: opts.gold,
    bucket: opts.draft.bucket,
    severity: opts.draft.severity,
    ...(opts.draft.stateContract !== undefined ? { stateContract: opts.draft.stateContract } : {}),
    ...(opts.draft.candidateThreadIds !== undefined
      ? { candidateThreadIds: opts.draft.candidateThreadIds }
      : {}),
    ...(opts.draft.candidateReferentIds !== undefined
      ? { candidateReferentIds: opts.draft.candidateReferentIds }
      : {}),
    ...(opts.draft.ambiguityClass !== undefined
      ? { ambiguityClass: opts.draft.ambiguityClass }
      : {}),
    blockingEligible,
    sourceProvenance: opts.draft.sourceProvenance,
    humanAudit,
  })
}

export const writePromotedGroundingReplayCase = (
  opts: WritePromotedGroundingReplayCaseOpts,
): GroundingReplayPromotionResult => {
  const fixture = promoteGroundingReplayDraft(opts)
  const outPath = resolve(process.cwd(), opts.outPath)
  const fixtureText = `${stableJson(fixture)}\n`
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, fixtureText)
  return { fixture, fixtureText, outPath }
}
