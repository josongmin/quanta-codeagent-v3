import { isGroundingFileId, resolveGroundingSpecificFileContext } from "../file-context"
import type { GroundingCase, GroundingDecision } from "../schema"

const uniqueOrdered = (values: readonly string[]): readonly string[] => [...new Set(values)]

const collectThreadCandidates = (groundingCase: GroundingCase): readonly string[] =>
  uniqueOrdered([
    ...(groundingCase.stateContract?.visibleThreadIds ?? []),
    ...(groundingCase.candidateThreadIds ?? []),
    ...groundingCase.history.flatMap((entry) => [
      ...(entry.threadId !== undefined && entry.threadId !== null ? [entry.threadId] : []),
      ...(entry.mentionedThreadIds ?? []),
    ]),
  ])

const activeThreadFromStructuredHistory = (groundingCase: GroundingCase): string | null => {
  const entry = groundingCase.history.findLast(
    (candidate) => candidate.threadId !== undefined && candidate.threadId !== null,
  )
  return entry?.threadId ?? groundingCase.stateContract?.activeThreadId ?? null
}

const contextChangeReferents = (groundingCase: GroundingCase): readonly string[] =>
  uniqueOrdered(
    (groundingCase.contextChanges ?? []).flatMap((event) => {
      if (event.field === "mode" && typeof event.next === "string") return [`${event.next}_mode`]
      if (event.field === "model" && typeof event.next === "string") return [event.next]
      if (event.field === "active_skills" && Array.isArray(event.next)) {
        return event.next.filter(
          (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
        )
      }
      return []
    }),
  )

const collectReferentCandidates = (groundingCase: GroundingCase): readonly string[] =>
  uniqueOrdered([
    ...(groundingCase.candidateReferentIds ?? []).filter((entry) => !isGroundingFileId(entry)),
    ...groundingCase.history.flatMap((entry) => [
      ...(entry.referentId !== undefined &&
      entry.referentId !== null &&
      !isGroundingFileId(entry.referentId)
        ? [entry.referentId]
        : []),
      ...(entry.mentionedReferentIds ?? []).filter((candidate) => !isGroundingFileId(candidate)),
    ]),
    ...contextChangeReferents(groundingCase),
  ])

const latestStructuredReferentId = (groundingCase: GroundingCase): string | null => {
  const entry = groundingCase.history.findLast(
    (candidate) =>
      candidate.referentId !== undefined &&
      candidate.referentId !== null &&
      !isGroundingFileId(candidate.referentId),
  )
  return entry?.referentId ?? null
}

const latestStructuredToolResult = (
  groundingCase: GroundingCase,
): { threadId: string | null; referentId: string | null; toolName?: string } | null => {
  const entry = groundingCase.history.findLast((candidate) => candidate.kind === "tool_result")
  if (entry === undefined) return null
  return {
    threadId: entry.threadId ?? null,
    referentId: entry.referentId ?? null,
    ...(entry.toolName !== undefined ? { toolName: entry.toolName } : {}),
  }
}

const diffReasons = (before: GroundingDecision, after: GroundingDecision): readonly string[] => {
  const reasons: string[] = []
  if (after.activeThreadId !== before.activeThreadId) reasons.push("active_thread")
  if (after.referentId !== before.referentId) reasons.push("referent")
  if (after.scope !== before.scope) reasons.push("scope")
  if (after.shouldClarify !== before.shouldClarify) reasons.push("clarify")
  return reasons
}

export interface GroundingNormalizationPassResult {
  decision: GroundingDecision
  applied: boolean
  reasons: readonly string[]
}

/**
 * The four fields the structural pass is allowed to rewrite. Every rule below
 * takes a draft and returns the next draft; nothing else about the decision
 * (intent, confidence) is touched by this pass.
 */
interface StructuralDraft {
  readonly activeThreadId: GroundingDecision["activeThreadId"]
  readonly referentId: GroundingDecision["referentId"]
  readonly scope: GroundingDecision["scope"]
  readonly shouldClarify: GroundingDecision["shouldClarify"]
}

/**
 * Everything derived ONCE from the case + the pre-pass decision. Rules read this
 * (never the live draft) for provenance facts, which is why extracting the rules
 * cannot change behaviour: the facts were already computed up-front in the
 * original single-function form.
 */
interface StructuralContext {
  readonly groundingCase: GroundingCase
  /** The decision as it arrived, BEFORE any rule ran. */
  readonly decision: GroundingDecision
  readonly threadCandidates: readonly string[]
  readonly canonicalActiveThread: string | null
  readonly fileContext: ReturnType<typeof resolveGroundingSpecificFileContext>
  readonly subthreadCandidates: readonly string[]
  readonly primaryStructuredReferent: string | null
  readonly latestToolResultId: string | null
  readonly latestToolThreadId: string | null
  readonly chosenFileId: string | null
  readonly uniqueSubthreadReferentId: string | null
  readonly decisionReferentIsFile: boolean
  readonly keepStructuredCurrentReferent: boolean
}

type StructuralRule = (draft: StructuralDraft, ctx: StructuralContext) => StructuralDraft

const buildStructuralContext = (
  groundingCase: GroundingCase,
  decision: GroundingDecision,
): StructuralContext => {
  const stateContract = groundingCase.stateContract
  const fileContext = resolveGroundingSpecificFileContext(groundingCase)
  const subthreadCandidates = collectReferentCandidates(groundingCase)
  const primaryStructuredReferent = latestStructuredReferentId(groundingCase)
  const latestToolResult = latestStructuredToolResult(groundingCase)
  const latestToolResultId =
    stateContract?.latestToolResultId ?? latestToolResult?.referentId ?? null
  const explicitFileId =
    fileContext.utteranceFileIds.length === 1 ? (fileContext.utteranceFileIds[0] ?? null) : null
  const uniqueMatchingFileId =
    fileContext.matchingCandidateFileIds.length === 1
      ? (fileContext.matchingCandidateFileIds[0] ?? null)
      : null
  const uniqueCandidateFileId =
    fileContext.candidateFileIds.length === 1 ? (fileContext.candidateFileIds[0] ?? null) : null
  const decisionReferentIsFile =
    decision.referentId !== null &&
    decision.referentId !== undefined &&
    isGroundingFileId(decision.referentId)
  return {
    groundingCase,
    decision,
    threadCandidates: collectThreadCandidates(groundingCase),
    canonicalActiveThread:
      stateContract?.activeThreadId ??
      activeThreadFromStructuredHistory(groundingCase) ??
      decision.activeThreadId,
    fileContext,
    subthreadCandidates,
    primaryStructuredReferent,
    latestToolResultId,
    latestToolThreadId: latestToolResult?.threadId ?? null,
    chosenFileId: explicitFileId ?? uniqueMatchingFileId ?? uniqueCandidateFileId,
    uniqueSubthreadReferentId:
      subthreadCandidates.length === 1 ? (subthreadCandidates[0] ?? null) : null,
    decisionReferentIsFile,
    keepStructuredCurrentReferent:
      decision.referentId !== null &&
      !decisionReferentIsFile &&
      (decision.referentId === latestToolResultId ||
        subthreadCandidates.includes(decision.referentId) ||
        decision.referentId === primaryStructuredReferent),
  }
}

/** A decision that named no thread inherits the case's canonical active thread. */
const adoptCanonicalActiveThread: StructuralRule = (draft, ctx) =>
  draft.activeThreadId === null && ctx.canonicalActiveThread !== null
    ? { ...draft, activeThreadId: ctx.canonicalActiveThread }
    : draft

/** Asking to clarify WHICH workstream is vacuous when only one thread exists. */
const dropClarifyWhenSingleThread: StructuralRule = (draft, ctx) =>
  draft.scope === "current_workstream" &&
  draft.shouldClarify === true &&
  ctx.canonicalActiveThread !== null &&
  ctx.threadCandidates.length <= 1
    ? { ...draft, shouldClarify: false }
    : draft

/** An unambiguous current-workstream decision points at the canonical thread —
 *  unless the model already named a referent the structure vouches for. */
const bindCurrentWorkstreamToCanonicalThread: StructuralRule = (draft, ctx) => {
  if (
    !(
      draft.scope === "current_workstream" &&
      draft.shouldClarify === false &&
      ctx.canonicalActiveThread !== null
    )
  ) {
    return draft
  }
  const referentId =
    draft.referentId === null || !ctx.keepStructuredCurrentReferent
      ? ctx.canonicalActiveThread
      : draft.referentId
  return { ...draft, activeThreadId: ctx.canonicalActiveThread, referentId }
}

/** A thread-ambiguous case with >1 candidate thread MUST clarify, never guess. */
const clarifyAmbiguousThread: StructuralRule = (draft, ctx) =>
  ctx.groundingCase.ambiguityClass === "thread" &&
  (ctx.groundingCase.candidateThreadIds?.length ?? ctx.threadCandidates.length) > 1 &&
  draft.scope === "current_workstream"
    ? { ...draft, activeThreadId: null, referentId: null, shouldClarify: true }
    : draft

/** A single identifiable file in scope retargets the decision at that file. */
const retargetToChosenFile: StructuralRule = (draft, ctx) =>
  (draft.scope === "current_workstream" || draft.scope === "specific_file") &&
  ctx.chosenFileId !== null &&
  (!ctx.decisionReferentIsFile ||
    draft.referentId !== ctx.chosenFileId ||
    draft.scope !== "specific_file")
    ? {
        ...draft,
        scope: "specific_file",
        referentId: ctx.chosenFileId,
        shouldClarify: false,
      }
    : draft

/** Clarifying WHICH file is vacuous when exactly one candidate file exists. */
const resolveSoleCandidateFile: StructuralRule = (draft, ctx) =>
  draft.scope === "specific_file" &&
  draft.shouldClarify === true &&
  ctx.fileContext.candidateFileIds.length === 1 &&
  ctx.chosenFileId !== null
    ? { ...draft, referentId: ctx.chosenFileId, shouldClarify: false }
    : draft

/** A "specific_file" scope whose referent is not a file id is mislabelled —
 *  demote it to the tool-result / subthread scope the referent actually names. */
const demoteNonFileSpecificFileScope: StructuralRule = (draft, ctx) =>
  draft.scope === "specific_file" &&
  draft.referentId !== null &&
  !isGroundingFileId(draft.referentId) &&
  ctx.chosenFileId === null
    ? {
        ...draft,
        scope:
          ctx.latestToolResultId !== null && draft.referentId === ctx.latestToolResultId
            ? "latest_tool_result"
            : "specific_subthread",
      }
    : draft

/** A file-ambiguous case with >1 candidate file MUST clarify, never guess. */
const clarifyAmbiguousFile: StructuralRule = (draft, ctx) => {
  if (
    !(
      ctx.groundingCase.ambiguityClass === "file" &&
      ctx.fileContext.candidateFileIds.length > 1 &&
      (draft.scope === "current_workstream" || draft.scope === "specific_file")
    )
  ) {
    return draft
  }
  return {
    ...draft,
    scope: "specific_file",
    referentId: null,
    shouldClarify: true,
    ...(ctx.canonicalActiveThread !== null ? { activeThreadId: ctx.canonicalActiveThread } : {}),
  }
}

/** A current-workstream decision pointing at something OTHER than the canonical
 *  thread is really a narrower scope. */
const demoteCurrentWorkstreamWithForeignReferent: StructuralRule = (draft, ctx) =>
  draft.scope === "current_workstream" &&
  draft.referentId !== null &&
  ctx.canonicalActiveThread !== null &&
  draft.referentId !== ctx.canonicalActiveThread &&
  !isGroundingFileId(draft.referentId)
    ? {
        ...draft,
        scope:
          ctx.latestToolResultId !== null && draft.referentId === ctx.latestToolResultId
            ? "latest_tool_result"
            : "specific_subthread",
      }
    : draft

/** "latest_tool_result" binds to the actual latest tool result — or, when the
 *  case has none, is not a tool-result scope at all. */
const bindLatestToolResult: StructuralRule = (draft, ctx) => {
  if (draft.scope !== "latest_tool_result") return draft
  if (ctx.latestToolResultId === null) return { ...draft, scope: "specific_subthread" }
  return {
    ...draft,
    referentId: ctx.latestToolResultId,
    ...(draft.activeThreadId === null && ctx.latestToolThreadId !== null
      ? { activeThreadId: ctx.latestToolThreadId }
      : {}),
    shouldClarify: false,
  }
}

/** Clarifying WHICH subthread is vacuous when exactly one candidate exists. */
const resolveSoleSubthreadReferent: StructuralRule = (draft, ctx) =>
  draft.scope === "specific_subthread" &&
  draft.shouldClarify === true &&
  ctx.uniqueSubthreadReferentId !== null
    ? { ...draft, referentId: ctx.uniqueSubthreadReferentId, shouldClarify: false }
    : draft

/** A subthread scope with no referent takes the best structurally-supported one:
 *  the sole candidate, then the model's own (if vouched for), then the latest
 *  structured referent when it is unambiguous. */
const fillMissingSubthreadReferent: StructuralRule = (draft, ctx) => {
  if (!(draft.scope === "specific_subthread" && draft.referentId === null)) return draft
  if (ctx.uniqueSubthreadReferentId !== null) {
    return { ...draft, referentId: ctx.uniqueSubthreadReferentId }
  }
  if (
    ctx.decision.referentId !== null &&
    !isGroundingFileId(ctx.decision.referentId) &&
    ctx.subthreadCandidates.includes(ctx.decision.referentId)
  ) {
    return { ...draft, referentId: ctx.decision.referentId }
  }
  if (ctx.primaryStructuredReferent !== null && ctx.subthreadCandidates.length <= 1) {
    return { ...draft, referentId: ctx.primaryStructuredReferent }
  }
  return draft
}

/** Last resort for a referent-less subthread with NO subthread candidates at
 *  all: the latest tool result is the only thing it can be talking about. */
const fallbackSubthreadToToolResult: StructuralRule = (draft, ctx) =>
  draft.scope === "specific_subthread" &&
  draft.referentId === null &&
  ctx.latestToolResultId !== null &&
  ctx.subthreadCandidates.length === 0
    ? { ...draft, referentId: ctx.latestToolResultId }
    : draft

/**
 * ORDER IS LOAD-BEARING — each rule observes the draft the previous one left
 * behind (e.g. `retargetToChosenFile` promotes a scope that
 * `resolveSoleCandidateFile` then acts on). This is the exact statement order of
 * the pre-split single function.
 */
const STRUCTURAL_RULES: readonly StructuralRule[] = [
  adoptCanonicalActiveThread,
  dropClarifyWhenSingleThread,
  bindCurrentWorkstreamToCanonicalThread,
  clarifyAmbiguousThread,
  retargetToChosenFile,
  resolveSoleCandidateFile,
  demoteNonFileSpecificFileScope,
  clarifyAmbiguousFile,
  demoteCurrentWorkstreamWithForeignReferent,
  bindLatestToolResult,
  resolveSoleSubthreadReferent,
  fillMissingSubthreadReferent,
  fallbackSubthreadToToolResult,
]

export const normalizeGroundingDecisionStructurally = (
  groundingCase: GroundingCase,
  decision: GroundingDecision,
): GroundingNormalizationPassResult => {
  const ctx = buildStructuralContext(groundingCase, decision)
  let draft: StructuralDraft = {
    activeThreadId: decision.activeThreadId,
    referentId: decision.referentId,
    scope: decision.scope,
    shouldClarify: decision.shouldClarify,
  }
  for (const rule of STRUCTURAL_RULES) draft = rule(draft, ctx)

  const normalized: GroundingDecision = { ...decision, ...draft }
  const reasons = diffReasons(decision, normalized)
  return {
    decision: normalized,
    applied: reasons.length > 0,
    reasons,
  }
}
