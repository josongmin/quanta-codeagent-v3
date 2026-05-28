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
  for (let index = groundingCase.history.length - 1; index >= 0; index -= 1) {
    const entry = groundingCase.history[index]!
    if (entry.threadId !== undefined && entry.threadId !== null) return entry.threadId
  }
  return groundingCase.stateContract?.activeThreadId ?? null
}

const contextChangeReferents = (groundingCase: GroundingCase): readonly string[] =>
  uniqueOrdered(
    (groundingCase.contextChanges ?? []).flatMap((event) => {
      if (event.field === "mode" && typeof event.next === "string") return [`${event.next}_mode`]
      if (event.field === "model" && typeof event.next === "string") return [event.next]
      if (event.field === "active_skills" && Array.isArray(event.next)) {
        return event.next.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      }
      return []
    }),
  )

const collectReferentCandidates = (groundingCase: GroundingCase): readonly string[] =>
  uniqueOrdered([
    ...(groundingCase.candidateReferentIds ?? []).filter((entry) => !isGroundingFileId(entry)),
    ...groundingCase.history.flatMap((entry) => [
      ...(entry.referentId !== undefined && entry.referentId !== null && !isGroundingFileId(entry.referentId)
        ? [entry.referentId]
        : []),
      ...(entry.mentionedReferentIds ?? []).filter((candidate) => !isGroundingFileId(candidate)),
    ]),
    ...contextChangeReferents(groundingCase),
  ])

const latestStructuredReferentId = (groundingCase: GroundingCase): string | null => {
  for (let index = groundingCase.history.length - 1; index >= 0; index -= 1) {
    const entry = groundingCase.history[index]!
    if (entry.referentId !== undefined && entry.referentId !== null && !isGroundingFileId(entry.referentId)) {
      return entry.referentId
    }
  }
  return null
}

const latestStructuredToolResult = (
  groundingCase: GroundingCase,
): { threadId: string | null; referentId: string | null; toolName?: string } | null => {
  for (let index = groundingCase.history.length - 1; index >= 0; index -= 1) {
    const entry = groundingCase.history[index]!
    if (entry.kind !== "tool_result") continue
    return {
      threadId: entry.threadId ?? null,
      referentId: entry.referentId ?? null,
      ...(entry.toolName !== undefined ? { toolName: entry.toolName } : {}),
    }
  }
  return null
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

export const normalizeGroundingDecisionStructurally = (
  groundingCase: GroundingCase,
  decision: GroundingDecision,
): GroundingNormalizationPassResult => {
  const stateContract = groundingCase.stateContract
  const threadCandidates = collectThreadCandidates(groundingCase)
  const canonicalActiveThread =
    stateContract?.activeThreadId ?? activeThreadFromStructuredHistory(groundingCase) ?? decision.activeThreadId
  const fileContext = resolveGroundingSpecificFileContext(groundingCase)
  const subthreadCandidates = collectReferentCandidates(groundingCase)
  const primaryStructuredReferent = latestStructuredReferentId(groundingCase)
  const latestToolResult = latestStructuredToolResult(groundingCase)
  const latestToolResultId = stateContract?.latestToolResultId ?? latestToolResult?.referentId ?? null
  const latestToolThreadId = latestToolResult?.threadId ?? null
  const explicitFileId = fileContext.utteranceFileIds.length === 1 ? (fileContext.utteranceFileIds[0] ?? null) : null
  const uniqueMatchingFileId =
    fileContext.matchingCandidateFileIds.length === 1
      ? (fileContext.matchingCandidateFileIds[0] ?? null)
      : null
  const uniqueCandidateFileId =
    fileContext.candidateFileIds.length === 1 ? (fileContext.candidateFileIds[0] ?? null) : null
  const chosenFileId = explicitFileId ?? uniqueMatchingFileId ?? uniqueCandidateFileId
  const uniqueSubthreadReferentId =
    subthreadCandidates.length === 1 ? (subthreadCandidates[0] ?? null) : null
  const decisionReferentIsFile =
    decision.referentId !== null && decision.referentId !== undefined && isGroundingFileId(decision.referentId)
  const keepStructuredCurrentReferent =
    decision.referentId !== null &&
    !decisionReferentIsFile &&
    (decision.referentId === latestToolResultId ||
      subthreadCandidates.includes(decision.referentId) ||
      decision.referentId === primaryStructuredReferent)

  let activeThreadId = decision.activeThreadId
  let referentId = decision.referentId
  let scope = decision.scope
  let shouldClarify = decision.shouldClarify

  if (activeThreadId === null && canonicalActiveThread !== null) {
    activeThreadId = canonicalActiveThread
  }

  if (
    scope === "current_workstream" &&
    shouldClarify === true &&
    canonicalActiveThread !== null &&
    threadCandidates.length <= 1
  ) {
    shouldClarify = false
  }

  if (scope === "current_workstream" && shouldClarify === false && canonicalActiveThread !== null) {
    activeThreadId = canonicalActiveThread
    if (referentId === null || !keepStructuredCurrentReferent) referentId = canonicalActiveThread
  }

  if (
    (scope === "current_workstream" || scope === "specific_file") &&
    chosenFileId !== null &&
    (!decisionReferentIsFile || referentId !== chosenFileId || scope !== "specific_file")
  ) {
    scope = "specific_file"
    referentId = chosenFileId
    shouldClarify = false
  }

  if (
    scope === "specific_file" &&
    shouldClarify === true &&
    fileContext.candidateFileIds.length === 1 &&
    chosenFileId !== null
  ) {
    referentId = chosenFileId
    shouldClarify = false
  }

  if (
    scope === "specific_file" &&
    referentId !== null &&
    !isGroundingFileId(referentId) &&
    chosenFileId === null
  ) {
    scope =
      latestToolResultId !== null && referentId === latestToolResultId
        ? "latest_tool_result"
        : "specific_subthread"
  }

  if (
    scope === "current_workstream" &&
    referentId !== null &&
    canonicalActiveThread !== null &&
    referentId !== canonicalActiveThread &&
    !isGroundingFileId(referentId)
  ) {
    scope = latestToolResultId !== null && referentId === latestToolResultId ? "latest_tool_result" : "specific_subthread"
  }

  if (scope === "latest_tool_result") {
    if (latestToolResultId !== null) {
      referentId = latestToolResultId
      if (activeThreadId === null && latestToolThreadId !== null) activeThreadId = latestToolThreadId
      shouldClarify = false
    } else {
      scope = "specific_subthread"
    }
  }

  if (
    scope === "specific_subthread" &&
    shouldClarify === true &&
    uniqueSubthreadReferentId !== null
  ) {
    referentId = uniqueSubthreadReferentId
    shouldClarify = false
  }

  if (scope === "specific_subthread" && referentId === null) {
    if (uniqueSubthreadReferentId !== null) {
      referentId = uniqueSubthreadReferentId
    } else if (
      decision.referentId !== null &&
      !isGroundingFileId(decision.referentId) &&
      subthreadCandidates.includes(decision.referentId)
    ) {
      referentId = decision.referentId
    } else if (primaryStructuredReferent !== null && subthreadCandidates.length <= 1) {
      referentId = primaryStructuredReferent
    }
  }

  if (
    scope === "specific_subthread" &&
    referentId === null &&
    latestToolResultId !== null &&
    subthreadCandidates.length === 0
  ) {
    referentId = latestToolResultId
  }

  const normalized: GroundingDecision = {
    ...decision,
    activeThreadId,
    referentId,
    scope,
    shouldClarify,
  }
  const reasons = diffReasons(decision, normalized)
  return {
    decision: normalized,
    applied: reasons.length > 0,
    reasons,
  }
}
