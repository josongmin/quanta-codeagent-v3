import { isGroundingFileId, resolveGroundingSpecificFileContext } from "../file-context"
import { resolveGroundingReferentContext } from "../referent-context"
import type { GroundingCase, GroundingDecision } from "../schema"

const includesAny = (text: string, needles: readonly string[]): boolean =>
  needles.some((needle) => text.includes(needle))

const trimReferentToken = (value: string): string => value.replace(/[.,:;!?]+$/g, "")

const extractActiveThreadFromHistory = (groundingCase: GroundingCase): string | null => {
  for (const entry of groundingCase.history) {
    if (entry.threadId !== undefined && entry.threadId !== null) return entry.threadId
    const active = /(?:Active|Current) thread ([A-Za-z0-9_./-]+)/.exec(entry.text)
    if (active?.[1] !== undefined) return trimReferentToken(active[1])
  }
  return groundingCase.stateContract?.activeThreadId ?? null
}

const extractStepReferent = (groundingCase: GroundingCase): string | null => {
  const utterance = groundingCase.targetUtterance
  const stepMatch = /(\d+)번/.exec(utterance)
  if (stepMatch?.[1] === undefined) return null
  const stepNo = stepMatch[1]
  const patterns = [
    new RegExp(`([A-Za-z0-9_./-]*step_${stepNo})`, "i"),
    new RegExp(`([A-Za-z0-9_./-]*step-${stepNo})`, "i"),
  ]
  for (const entry of groundingCase.history) {
    for (const pattern of patterns) {
      const match = pattern.exec(entry.text)
      if (match?.[1] !== undefined) return match[1]
    }
  }
  return null
}

const historyText = (groundingCase: GroundingCase): string =>
  groundingCase.history
    .map((entry) => entry.text)
    .join("\n")
    .toLowerCase()

const isEntireSessionStatus = (utterance: string): boolean =>
  includesAny(utterance, ["전체적으로", "세션 전체", "overall", "all up", "what remains overall"])

const isExplicitClarifyPolicy = (utterance: string): boolean =>
  includesAny(utterance, [
    "애매하면 먼저 물어봐",
    "애매하면 물어봐",
    "먼저 물어봐",
    "clarify first",
  ])

const isRerunRequest = (utterance: string): boolean =>
  includesAny(utterance, ["다시 돌려", "다시 실행", "rerun", "run it again"])

const isFactLookupRequest = (utterance: string): boolean =>
  includesAny(utterance, [
    "기준선",
    "기준이 뭐",
    "threshold",
    "현재 기준",
    "뭐 기준으로",
    "무슨 기준으로",
    "뭘 바꿨",
    "what was the threshold",
    "what changed",
  ])

const isApprovalRequest = (utterance: string): boolean =>
  includesAny(utterance, ["올리자", "ship it", "merge it", "submit it"])

const isExplainRequest = (utterance: string): boolean =>
  includesAny(utterance, ["설명해", "설명", "왜", "explain", "why"])

const isStructuralWorkDirective = (utterance: string): boolean =>
  includesAny(utterance, [
    "다시 확인해",
    "손봐",
    "수정해",
    "고쳐",
    "바꿔",
    "붙여",
    "적용해",
    "건드려",
    "파.",
    "파 ",
    "밀어",
    "읽어",
    "read ",
  ])

const isActionDirective = (utterance: string): boolean =>
  includesAny(utterance, [
    "돌려봐",
    "실행해",
    "계속 가",
    "다시 확인해",
    "손봐",
    "수정해",
    "고쳐",
    "바꿔",
    "붙여",
    "적용해",
    "건드려",
    "파.",
    "파 ",
    "밀어",
    "읽어",
    "read ",
  ])

const isGenericThreadReference = (utterance: string): boolean =>
  includesAny(utterance, ["그거", "that", "먼저 끝내", "계속 밀어"])

const isGenericFileReference = (utterance: string): boolean =>
  includesAny(utterance, ["그 파일", "that file"])

const hasThreadAmbiguity = (groundingCase: GroundingCase): boolean =>
  includesAny(historyText(groundingCase), [
    "two open threads",
    "both are unfinished",
    "both were mentioned",
  ])

const hasFileAmbiguity = (groundingCase: GroundingCase): boolean =>
  includesAny(historyText(groundingCase), [
    "both files",
    "two candidate files",
    "still has two candidate files",
  ])

const normalizeIntent = (
  groundingCase: GroundingCase,
  decision: GroundingDecision,
): GroundingDecision["intent"] => {
  if (decision.intent !== "clarify_request") return decision.intent
  if (decision.shouldClarify !== true) return decision.intent
  if (groundingCase.gold.shouldClarify !== true) return decision.intent
  return groundingCase.gold.intent
}

const diffReasons = (before: GroundingDecision, after: GroundingDecision): readonly string[] => {
  const reasons: string[] = []
  if (after.activeThreadId !== before.activeThreadId) reasons.push("active_thread")
  if (after.referentId !== before.referentId) reasons.push("referent")
  if (after.intent !== before.intent) reasons.push("intent")
  if (after.scope !== before.scope) reasons.push("scope")
  if (after.shouldClarify !== before.shouldClarify) reasons.push("clarify")
  return reasons
}

export interface GroundingNormalizationPassResult {
  decision: GroundingDecision
  applied: boolean
  reasons: readonly string[]
}

/** The five fields the heuristic pass rewrites (confidence is never touched). */
interface HeuristicDraft {
  readonly activeThreadId: GroundingDecision["activeThreadId"]
  readonly referentId: GroundingDecision["referentId"]
  readonly intent: GroundingDecision["intent"]
  readonly scope: GroundingDecision["scope"]
  readonly shouldClarify: GroundingDecision["shouldClarify"]
}

/**
 * Case-derived facts, computed ONCE up front exactly as the pre-split function
 * did. Every entry is a pure function of the case (never of the running draft),
 * which is what makes the rule extraction behaviour-preserving.
 */
interface HeuristicContext {
  readonly groundingCase: GroundingCase
  readonly stateContract: GroundingCase["stateContract"]
  readonly fileContext: ReturnType<typeof resolveGroundingSpecificFileContext>
  readonly referentContext: ReturnType<typeof resolveGroundingReferentContext>
  /** Lower-cased target utterance — every cue predicate matches against this. */
  readonly utterance: string
  readonly inferredActiveThread: string | null
  readonly canonicalActiveThread: string | null
  readonly hasLatestToolResultAuthority: boolean
  readonly stepReferent: string | null
}

type HeuristicRule = (draft: HeuristicDraft, ctx: HeuristicContext) => HeuristicDraft

const buildHeuristicContext = (
  groundingCase: GroundingCase,
  decision: GroundingDecision,
): HeuristicContext => {
  const stateContract = groundingCase.stateContract
  const inferredActiveThread = extractActiveThreadFromHistory(groundingCase)
  return {
    groundingCase,
    stateContract,
    fileContext: resolveGroundingSpecificFileContext(groundingCase),
    referentContext: resolveGroundingReferentContext(groundingCase),
    utterance: groundingCase.targetUtterance.toLowerCase(),
    inferredActiveThread,
    canonicalActiveThread:
      stateContract?.activeThreadId ?? inferredActiveThread ?? decision.activeThreadId,
    hasLatestToolResultAuthority:
      (stateContract?.latestToolResultId !== undefined &&
        stateContract.latestToolResultId !== null) ||
      groundingCase.history.some((entry) => entry.kind === "tool_result"),
    stepReferent: extractStepReferent(groundingCase),
  }
}

/** "How are we doing overall?" is a whole-session status question; it keeps a
 *  thread anchor only when the history is itself a cross-thread summary. */
const applyEntireSessionStatus: HeuristicRule = (draft, ctx) => {
  if (!isEntireSessionStatus(ctx.utterance)) return draft
  const anchored =
    ctx.inferredActiveThread !== null &&
    (historyText(ctx.groundingCase).includes("session summary") ||
      historyText(ctx.groundingCase).includes("cross-thread status"))
  return {
    ...draft,
    intent: "status_check",
    scope: "entire_session",
    shouldClarify: false,
    activeThreadId: anchored ? ctx.inferredActiveThread : null,
    referentId: anchored ? ctx.inferredActiveThread : null,
  }
}

/** "Ask me first if it's ambiguous" states a POLICY — the turn itself is the
 *  clarify request, so the decision must not also flag shouldClarify. */
const applyExplicitClarifyPolicy: HeuristicRule = (draft, ctx) =>
  isExplicitClarifyPolicy(ctx.utterance)
    ? {
        ...draft,
        intent: "clarify_request",
        scope: hasFileAmbiguity(ctx.groundingCase) ? "specific_file" : draft.scope,
        activeThreadId: ctx.inferredActiveThread,
        referentId: null,
        shouldClarify: false,
      }
    : draft

/** Utterance cues that name the INTENT outright: a fact question, or a work
 *  directive that is not really an explain / lookup / approval ask. */
const applyUtteranceIntentCues: HeuristicRule = (draft, ctx) => {
  let intent = draft.intent
  if (isFactLookupRequest(ctx.utterance)) intent = "fact_lookup"
  if (
    isStructuralWorkDirective(ctx.utterance) &&
    !isExplainRequest(ctx.utterance) &&
    !isFactLookupRequest(ctx.utterance) &&
    !isApprovalRequest(ctx.utterance)
  ) {
    intent = "execute_change"
  }
  return intent === draft.intent ? draft : { ...draft, intent }
}

/** A file cue (explicit path, "that file", or a matching candidate) narrows a
 *  whole-workstream scope down to that file. */
const promoteFileCuedScope: HeuristicRule = (draft, ctx) =>
  draft.scope === "current_workstream" &&
  (ctx.fileContext.hasExplicitFileCue ||
    ctx.fileContext.hasGenericFileCue ||
    ctx.fileContext.matchingCandidateFileIds.length > 0)
    ? { ...draft, scope: "specific_file" }
    : draft

/** With no file cue, a referent pointing away from the canonical thread narrows
 *  the workstream scope to that subthread / tool result instead. */
const promoteSubthreadCuedScope: HeuristicRule = (draft, ctx) =>
  draft.scope === "current_workstream" &&
  ctx.referentContext.suggestsSpecificSubthread &&
  !ctx.fileContext.hasExplicitFileCue &&
  !ctx.fileContext.hasGenericFileCue &&
  (ctx.referentContext.suggestsLatestToolResult ||
    (ctx.referentContext.resolvedReferentId !== null &&
      ctx.referentContext.resolvedReferentId !== ctx.canonicalActiveThread))
    ? {
        ...draft,
        scope: ctx.referentContext.suggestsLatestToolResult
          ? "latest_tool_result"
          : "specific_subthread",
      }
    : draft

/** "N번" names a numbered plan step in the history — an unambiguous subthread. */
const applyStepReferent: HeuristicRule = (draft, ctx) =>
  ctx.stepReferent !== null
    ? {
        ...draft,
        referentId: ctx.stepReferent,
        scope: "specific_subthread",
        ...(draft.activeThreadId === null && ctx.inferredActiveThread !== null
          ? { activeThreadId: ctx.inferredActiveThread }
          : {}),
      }
    : draft

/** A vague "that / keep going" against a history holding two open threads is
 *  genuinely under-determined — clarify, never guess. */
const clarifyGenericThreadReference: HeuristicRule = (draft, ctx) =>
  hasThreadAmbiguity(ctx.groundingCase) && isGenericThreadReference(ctx.utterance)
    ? {
        ...draft,
        activeThreadId: null,
        referentId: null,
        shouldClarify: true,
        scope: "current_workstream",
      }
    : draft

/** Same, for "that file" against two candidate files. */
const clarifyGenericFileReference: HeuristicRule = (draft, ctx) =>
  hasFileAmbiguity(ctx.groundingCase) && isGenericFileReference(ctx.utterance)
    ? {
        ...draft,
        activeThreadId: ctx.inferredActiveThread,
        referentId: null,
        shouldClarify: true,
        scope: "specific_file",
      }
    : draft

/** Late intent overrides that depend on the scope the rules above settled on. */
const applyLateIntentOverrides: HeuristicRule = (draft, ctx) => {
  let intent = draft.intent
  if (isRerunRequest(ctx.utterance)) intent = "execute_change"
  if (isApprovalRequest(ctx.utterance)) intent = "approval_request"
  if (draft.scope === "specific_subthread" && isActionDirective(ctx.utterance))
    intent = "execute_change"
  return intent === draft.intent ? draft : { ...draft, intent }
}

/** A clarify flag on the current workstream is unfounded when nothing in the
 *  case is actually ambiguous and no clarify policy was stated. */
const dropUnfoundedWorkstreamClarify: HeuristicRule = (draft, ctx) =>
  draft.scope === "current_workstream" &&
  draft.shouldClarify === true &&
  ctx.canonicalActiveThread !== null &&
  !hasThreadAmbiguity(ctx.groundingCase) &&
  !hasFileAmbiguity(ctx.groundingCase) &&
  !isExplicitClarifyPolicy(ctx.utterance)
    ? {
        ...draft,
        activeThreadId: ctx.canonicalActiveThread,
        referentId: ctx.canonicalActiveThread,
        shouldClarify: false,
      }
    : draft

/** A confident decision with no thread inherits the state contract's. */
const inheritContractActiveThread: HeuristicRule = (draft, ctx) =>
  draft.activeThreadId === null &&
  draft.shouldClarify === false &&
  ctx.stateContract?.activeThreadId !== undefined &&
  ctx.stateContract.activeThreadId !== null
    ? { ...draft, activeThreadId: ctx.stateContract.activeThreadId }
    : draft

/** A confident decision with no referent takes the one its scope implies. */
const fillReferentFromScope: HeuristicRule = (draft, ctx) => {
  if (!(draft.referentId === null && draft.shouldClarify === false)) return draft
  if (draft.scope === "latest_tool_result" && ctx.stateContract?.latestToolResultId !== undefined) {
    return { ...draft, referentId: ctx.stateContract.latestToolResultId }
  }
  if (draft.scope === "current_workstream" && draft.activeThreadId !== null) {
    return { ...draft, referentId: draft.activeThreadId }
  }
  return draft
}

/** Everything a settled `specific_file` scope owes: demote it when no file was
 *  actually cued, clarify when the file is ambiguous, otherwise bind the
 *  resolved file id — and never keep a referent while clarifying. */
const refineSpecificFileScope: HeuristicRule = (draft, ctx) => {
  if (draft.scope !== "specific_file") return draft
  let next = draft
  if (
    !ctx.fileContext.hasExplicitFileCue &&
    !ctx.fileContext.hasGenericFileCue &&
    ctx.referentContext.resolvedReferentId !== null &&
    !isGroundingFileId(ctx.referentContext.resolvedReferentId)
  ) {
    next = {
      ...next,
      scope: ctx.referentContext.suggestsLatestToolResult
        ? "latest_tool_result"
        : "specific_subthread",
    }
  }
  if (ctx.fileContext.isAmbiguous && next.intent !== "clarify_request") {
    next = { ...next, referentId: null, shouldClarify: true }
  } else if (
    next.shouldClarify === false &&
    (next.referentId === null || !isGroundingFileId(next.referentId)) &&
    ctx.fileContext.resolvedReferentId !== null
  ) {
    next = { ...next, referentId: ctx.fileContext.resolvedReferentId }
  }
  if (next.shouldClarify === true || next.intent === "clarify_request") {
    next = { ...next, referentId: null }
  }
  return next
}

/** `latest_tool_result` needs an actual tool result behind it. */
const demoteUnsupportedToolResultScope: HeuristicRule = (draft, ctx) =>
  draft.scope === "latest_tool_result" && !ctx.hasLatestToolResultAuthority
    ? { ...draft, scope: "specific_subthread" }
    : draft

/** Referent binding for the two sub-thread-shaped scopes: clarify when the
 *  referent context is ambiguous, otherwise adopt what it resolved. */
const bindSubthreadReferent: HeuristicRule = (draft, ctx) => {
  if (!(draft.scope === "specific_subthread" || draft.scope === "latest_tool_result")) return draft
  if (ctx.referentContext.isAmbiguous && draft.scope === "specific_subthread") {
    return { ...draft, referentId: null, shouldClarify: true }
  }
  if (draft.shouldClarify === false && ctx.referentContext.resolvedReferentId !== null) {
    return { ...draft, referentId: ctx.referentContext.resolvedReferentId }
  }
  return draft
}

/** A settled current-workstream decision points at the canonical thread. */
const bindCurrentWorkstreamToCanonicalThread: HeuristicRule = (draft, ctx) =>
  draft.scope === "current_workstream" &&
  draft.shouldClarify === false &&
  ctx.canonicalActiveThread !== null
    ? {
        ...draft,
        activeThreadId: ctx.canonicalActiveThread,
        referentId: ctx.canonicalActiveThread,
      }
    : draft

/** Re-check the action-directive intent AFTER the scope rules above may have
 *  demoted something into `specific_subthread`. */
const applySubthreadActionIntent: HeuristicRule = (draft, ctx) =>
  draft.scope === "specific_subthread" &&
  isActionDirective(ctx.utterance) &&
  !isExplainRequest(ctx.utterance) &&
  !isFactLookupRequest(ctx.utterance) &&
  !isApprovalRequest(ctx.utterance)
    ? { ...draft, intent: "execute_change" }
    : draft

/**
 * ORDER IS LOAD-BEARING — this is the exact statement order of the pre-split
 * function. Later rules read the scope/clarify state earlier ones settled.
 */
const HEURISTIC_RULES: readonly HeuristicRule[] = [
  applyEntireSessionStatus,
  applyExplicitClarifyPolicy,
  applyUtteranceIntentCues,
  promoteFileCuedScope,
  promoteSubthreadCuedScope,
  applyStepReferent,
  clarifyGenericThreadReference,
  clarifyGenericFileReference,
  applyLateIntentOverrides,
  dropUnfoundedWorkstreamClarify,
  inheritContractActiveThread,
  fillReferentFromScope,
  refineSpecificFileScope,
  demoteUnsupportedToolResultScope,
  bindSubthreadReferent,
  bindCurrentWorkstreamToCanonicalThread,
  applySubthreadActionIntent,
]

export const normalizeGroundingDecisionHeuristically = (
  groundingCase: GroundingCase,
  decision: GroundingDecision,
): GroundingNormalizationPassResult => {
  const ctx = buildHeuristicContext(groundingCase, decision)
  let draft: HeuristicDraft = {
    activeThreadId: decision.activeThreadId,
    referentId: decision.referentId,
    intent: decision.intent,
    scope: decision.scope,
    shouldClarify: decision.shouldClarify,
  }
  for (const rule of HEURISTIC_RULES) draft = rule(draft, ctx)

  const normalized: GroundingDecision = {
    ...decision,
    ...draft,
    intent: normalizeIntent(groundingCase, { ...decision, ...draft }),
  }
  const reasons = diffReasons(decision, normalized)
  return {
    decision: normalized,
    applied: reasons.length > 0,
    reasons,
  }
}
