import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { SessionSnapshotLite } from "@/protocol/session/snapshot"
import type { TrajectoryEvent } from "@/shared"
import { loadSession } from "../trajectory/source"
import { stableJson } from "./stable-json"
import type {
  GroundingAmbiguityClass,
  GroundingBucket,
  GroundingCase,
  GroundingCorpus,
  GroundingDecision,
  GroundingSeverity,
  GroundingSourceProvenance,
  GroundingStateContract,
} from "./schema"
import { parseGroundingCase } from "./schema"

export interface BuildGroundingReplayScaffoldOpts {
  source: string
  id: string
  corpus: Extract<GroundingCorpus, "replay_critical" | "replay_nightly">
  targetUtterance: string
  bucket: GroundingBucket
  severity: GroundingSeverity
  gold: GroundingDecision
  stateContract?: GroundingStateContract
  sessionSnapshotPath?: string
  candidateThreadIds?: readonly string[]
  candidateReferentIds?: readonly string[]
  ambiguityClass?: GroundingAmbiguityClass
  blockingEligible?: boolean
}

export interface WriteGroundingReplayScaffoldOpts extends BuildGroundingReplayScaffoldOpts {
  outPath: string
}

export interface GroundingReplayScaffoldResult {
  fixture: GroundingCase
  fixtureText: string
  outPath: string
}

const parseJsonFile = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8")) as T

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

const collectAssistantHistory = (
  events: readonly TrajectoryEvent[],
): GroundingCase["history"] => {
  const out: GroundingCase["history"][number][] = []
  let assistantText = ""
  const flushAssistantText = (): void => {
    const text = assistantText.trim()
    if (text !== "") out.push({ role: "assistant", text })
    assistantText = ""
  }
  for (const event of events) {
    if (event.kind === "turn_start") flushAssistantText()
    if (event.kind === "assistant_text") {
      const delta = typeof event.data["delta"] === "string" ? event.data["delta"] : ""
      assistantText += delta
      continue
    }
    if (event.kind !== "tool_result") continue
    flushAssistantText()
    const toolName =
      typeof event.data["name"] === "string" ? (event.data["name"] as string) : "unknown_tool"
    const ok = event.data["ok"] === true
    const stdoutTail =
      typeof event.data["stdoutTail"] === "string" ? (event.data["stdoutTail"] as string) : ""
    const stderrTail =
      typeof event.data["stderrTail"] === "string" ? (event.data["stderrTail"] as string) : ""
    const tail = [stdoutTail.trim(), stderrTail.trim()].filter((value) => value !== "")[0]
    out.push({
      role: "assistant",
      kind: "tool_result",
      toolName,
      text: `Tool ${toolName} ${ok ? "ok" : "error"}${tail !== "" ? `: ${tail}` : ""}`,
    })
  }
  flushAssistantText()
  return out
}

const deriveStateContract = (
  opts: BuildGroundingReplayScaffoldOpts,
  snapshot: SessionSnapshotLite | undefined,
  assistantHistory: GroundingCase["history"],
): GroundingStateContract | undefined => {
  if (opts.stateContract !== undefined) return opts.stateContract
  const activeThreadId =
    snapshot?.state.lastLlmRequest?.policy?.mode !== undefined && opts.gold.activeThreadId !== null
      ? opts.gold.activeThreadId
      : opts.gold.activeThreadId
  const latestToolResult = [...assistantHistory]
    .reverse()
    .find((entry) => entry.kind === "tool_result")
  const policyMarkers = toPolicyMarkers(snapshot)
  if (
    activeThreadId === null &&
    opts.candidateThreadIds === undefined &&
    latestToolResult === undefined &&
    policyMarkers === undefined
  ) {
    return undefined
  }
  return {
    activeThreadId,
    ...(opts.candidateThreadIds !== undefined
      ? { visibleThreadIds: [...opts.candidateThreadIds].sort() }
      : {}),
    ...(policyMarkers !== undefined ? { policyMarkers } : {}),
    ...(latestToolResult !== undefined && opts.gold.scope === "latest_tool_result" && opts.gold.referentId !== null
      ? { latestToolResultId: opts.gold.referentId }
      : {}),
    ...(latestToolResult?.toolName !== undefined ? { latestToolName: latestToolResult.toolName } : {}),
  }
}

export const buildGroundingReplayScaffold = (
  opts: BuildGroundingReplayScaffoldOpts,
): GroundingCase => {
  const session = loadSession(opts.source)
  const snapshot =
    opts.sessionSnapshotPath === undefined
      ? undefined
      : parseJsonFile<SessionSnapshotLite>(opts.sessionSnapshotPath)
  const history: GroundingCase["history"][number][] = []
  const promptText = session.meta?.userPrompt ?? snapshot?.state.lastUserText
  if (typeof promptText === "string" && promptText.trim() !== "") {
    history.push({ role: "user", text: promptText.trim() })
  }
  history.push(...collectAssistantHistory(session.events))
  if (history.length === 0) {
    history.push({
      role: "assistant",
      text: `Scaffolded replay fixture from session ${session.sessionId}.`,
    })
  }
  const stateContract = deriveStateContract(opts, snapshot, history)
  const provenance: GroundingSourceProvenance = {
    kind: opts.sessionSnapshotPath === undefined ? "trajectory_freeze" : "session_freeze",
    sessionId: session.sessionId,
    ...(session.events.length > 0
      ? { seqRange: [session.events[0]!.seq, session.events[session.events.length - 1]!.seq] as const }
      : {}),
  }
  const fixture = parseGroundingCase({
    schema: 2,
    id: opts.id,
    usecase: "persistent-context.conversation-state.thread-grounding",
    corpus: opts.corpus,
    history,
    targetUtterance: opts.targetUtterance,
    gold: opts.gold,
    bucket: opts.bucket,
    severity: opts.severity,
    ...(stateContract !== undefined ? { stateContract } : {}),
    ...(opts.candidateThreadIds !== undefined ? { candidateThreadIds: opts.candidateThreadIds } : {}),
    ...(opts.candidateReferentIds !== undefined
      ? { candidateReferentIds: opts.candidateReferentIds }
      : {}),
    ...(opts.ambiguityClass !== undefined ? { ambiguityClass: opts.ambiguityClass } : {}),
    blockingEligible: opts.blockingEligible ?? false,
    sourceProvenance: provenance,
    humanAudit: { status: "none" },
  })
  return fixture
}

export const writeGroundingReplayScaffold = (
  opts: WriteGroundingReplayScaffoldOpts,
): GroundingReplayScaffoldResult => {
  const fixture = buildGroundingReplayScaffold(opts)
  const outPath = resolve(process.cwd(), opts.outPath)
  const fixtureText = `${stableJson(fixture)}\n`
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, fixtureText)
  return { fixture, fixtureText, outPath }
}
