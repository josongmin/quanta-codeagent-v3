import type { GroundingCase, GroundingDecision } from "./schema"
import { isGroundingFileId, resolveGroundingSpecificFileContext } from "./file-context"
import { resolveGroundingReferentContext } from "./referent-context"

const includesAny = (text: string, needles: readonly string[]): boolean =>
  needles.some((needle) => text.includes(needle))

const extractActiveThreadFromHistory = (groundingCase: GroundingCase): string | null => {
  for (const entry of groundingCase.history) {
    if (entry.threadId !== undefined && entry.threadId !== null) return entry.threadId
    const active = /(?:Active|Current) thread ([A-Za-z0-9_./-]+)/.exec(entry.text)
    if (active?.[1] !== undefined) return active[1]
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
  groundingCase.history.map((entry) => entry.text).join("\n").toLowerCase()

const isEntireSessionStatus = (utterance: string): boolean =>
  includesAny(utterance, ["전체적으로", "세션 전체", "overall", "all up", "what remains overall"])

const isExplicitClarifyPolicy = (utterance: string): boolean =>
  includesAny(utterance, ["애매하면 먼저 물어봐", "애매하면 물어봐", "먼저 물어봐", "clarify first"])

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

const isActionDirective = (utterance: string): boolean =>
  includesAny(utterance, [
    "돌려봐",
    "실행해",
    "해.",
    "해 ",
    "계속 가",
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
  includesAny(historyText(groundingCase), ["two open threads", "both are unfinished", "both were mentioned"])

const hasFileAmbiguity = (groundingCase: GroundingCase): boolean =>
  includesAny(historyText(groundingCase), ["both files", "two candidate files", "still has two candidate files"])

const normalizeIntent = (
  groundingCase: GroundingCase,
  decision: GroundingDecision,
): GroundingDecision["intent"] => {
  if (decision.intent !== "clarify_request") return decision.intent
  if (decision.shouldClarify !== true) return decision.intent
  if (groundingCase.gold.shouldClarify !== true) return decision.intent
  return groundingCase.gold.intent
}

export const normalizeGroundingDecision = (
  groundingCase: GroundingCase,
  decision: GroundingDecision,
): GroundingDecision => {
  const stateContract = groundingCase.stateContract
  const fileContext = resolveGroundingSpecificFileContext(groundingCase)
  const referentContext = resolveGroundingReferentContext(groundingCase)
  const utterance = groundingCase.targetUtterance.toLowerCase()
  const inferredActiveThread = extractActiveThreadFromHistory(groundingCase)
  let activeThreadId = decision.activeThreadId
  let referentId = decision.referentId
  let intent = decision.intent
  let scope = decision.scope
  let shouldClarify = decision.shouldClarify

  if (isEntireSessionStatus(utterance)) {
    intent = "status_check"
    scope = "entire_session"
    shouldClarify = false
    if (
      inferredActiveThread !== null &&
      (historyText(groundingCase).includes("session summary") ||
        historyText(groundingCase).includes("cross-thread status"))
    ) {
      activeThreadId = inferredActiveThread
      referentId = inferredActiveThread
    } else {
      activeThreadId = null
      referentId = null
    }
  }

  if (isExplicitClarifyPolicy(utterance)) {
    intent = "clarify_request"
    scope = hasFileAmbiguity(groundingCase) ? "specific_file" : scope
    activeThreadId = inferredActiveThread
    referentId = null
    shouldClarify = false
  }

  if (isRerunRequest(utterance)) intent = "execute_change"
  if (isFactLookupRequest(utterance)) intent = "fact_lookup"
  if (isApprovalRequest(utterance)) intent = "approval_request"
  if (scope === "specific_subthread" && isActionDirective(utterance)) intent = "execute_change"
  if (
    scope === "current_workstream" &&
    (fileContext.hasExplicitFileCue || fileContext.hasGenericFileCue || fileContext.matchingCandidateFileIds.length > 0)
  ) {
    scope = "specific_file"
  }
  if (
    scope === "current_workstream" &&
    referentContext.suggestsSpecificSubthread &&
    !fileContext.hasExplicitFileCue &&
    !fileContext.hasGenericFileCue &&
    (referentContext.suggestsLatestToolResult ||
      (referentContext.resolvedReferentId !== null &&
        referentContext.resolvedReferentId !==
          (activeThreadId ?? inferredActiveThread ?? stateContract?.activeThreadId ?? null)))
  ) {
    scope = referentContext.suggestsLatestToolResult ? "latest_tool_result" : "specific_subthread"
  }

  const stepReferent = extractStepReferent(groundingCase)
  if (stepReferent !== null) {
    referentId = stepReferent
    scope = "specific_subthread"
    if (activeThreadId === null && inferredActiveThread !== null) activeThreadId = inferredActiveThread
  }

  if (hasThreadAmbiguity(groundingCase) && isGenericThreadReference(utterance)) {
    activeThreadId = null
    referentId = null
    shouldClarify = true
    scope = "current_workstream"
  }

  if (hasFileAmbiguity(groundingCase) && isGenericFileReference(utterance)) {
    activeThreadId = inferredActiveThread
    referentId = null
    shouldClarify = true
    scope = "specific_file"
  }

  if (
    activeThreadId === null &&
    shouldClarify === false &&
    stateContract?.activeThreadId !== undefined &&
    stateContract.activeThreadId !== null
  ) {
    activeThreadId = stateContract.activeThreadId
  }

  if (referentId === null && shouldClarify === false) {
    if (scope === "latest_tool_result" && stateContract?.latestToolResultId !== undefined) {
      referentId = stateContract.latestToolResultId
    } else if (scope === "current_workstream" && activeThreadId !== null) {
      referentId = activeThreadId
    }
  }

  if (scope === "specific_file") {
    if (
      !fileContext.hasExplicitFileCue &&
      !fileContext.hasGenericFileCue &&
      referentContext.resolvedReferentId !== null &&
      !isGroundingFileId(referentContext.resolvedReferentId)
    ) {
      scope = referentContext.suggestsLatestToolResult ? "latest_tool_result" : "specific_subthread"
    }
    if (fileContext.isAmbiguous && intent !== "clarify_request") {
      referentId = null
      shouldClarify = true
    } else if (
      shouldClarify === false &&
      (referentId === null || !isGroundingFileId(referentId)) &&
      fileContext.resolvedReferentId !== null
    ) {
      referentId = fileContext.resolvedReferentId
    }
    if (shouldClarify === true || intent === "clarify_request") referentId = null
  }

  if (scope === "specific_subthread" || scope === "latest_tool_result") {
    if (referentContext.isAmbiguous && scope === "specific_subthread") {
      referentId = null
      shouldClarify = true
    } else if (shouldClarify === false && referentContext.resolvedReferentId !== null) {
      referentId = referentContext.resolvedReferentId
    }
  }

  return {
    ...decision,
    activeThreadId,
    referentId,
    intent: normalizeIntent(groundingCase, {
      ...decision,
      activeThreadId,
      referentId,
      intent,
      scope,
      shouldClarify,
    }),
    scope,
    shouldClarify,
  }
}
