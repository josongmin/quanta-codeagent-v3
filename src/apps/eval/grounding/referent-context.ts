import { isGroundingFileId } from "./file-context"
import type { GroundingCase } from "./schema"

const GENERIC_SUBTHREAD_CUES = [
  "그거",
  "그 모델",
  "that model",
  "그 스킬",
  "that skill",
  "그 로그",
  "that log",
  "그 제약",
  "that constraint",
  "그 서브스레드",
  "that subthread",
  "다시 돌려",
  "다시 실행",
  "계속 가",
  "설명해",
  "뭘 바꿨",
  "기준으로",
  "끝났냐",
  "읽어",
  "닫아",
  "유지하냐",
  "모델 기준",
  "skill",
  "model",
  "log",
  "subthread",
  "constraint",
  "policy",
  "rerun",
  "read it",
  "close it",
  "what changed",
  "what rule",
  "what should i review",
  "what was switched",
  "what remains",
  "what broke",
  "broken point",
  "깨진 지점",
] as const

const TOOL_RESULT_CUES = [
  "깨진 지점",
  "tool output",
  "여기서",
  "failed case",
  "parseerror",
] as const

const uniqueOrdered = (values: readonly string[]): readonly string[] => [...new Set(values)]

const includesAny = (text: string, needles: readonly string[]): boolean =>
  needles.some((needle) => text.includes(needle))

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

const memoryContextReferents = (groundingCase: GroundingCase): readonly string[] => {
  if (groundingCase.memoryContext === undefined) return []
  const match = /([A-Za-z0-9._-]+)\s+means/i.exec(groundingCase.memoryContext)
  return match?.[1] === undefined ? [] : [match[1]]
}

const historyReferents = (groundingCase: GroundingCase): readonly string[] =>
  uniqueOrdered(
    groundingCase.history.flatMap((entry) => [
      ...(entry.referentId !== undefined &&
      entry.referentId !== null &&
      !isGroundingFileId(entry.referentId)
        ? [entry.referentId]
        : []),
      ...(entry.mentionedReferentIds ?? []),
    ]),
  )

const currentHistoryReferent = (groundingCase: GroundingCase): string | null => {
  const entry = groundingCase.history.findLast(
    (candidate) =>
      candidate.referentId !== undefined &&
      candidate.referentId !== null &&
      !isGroundingFileId(candidate.referentId),
  )
  if (entry?.referentId !== undefined && entry.referentId !== null) return entry.referentId
  const contextReferents = contextChangeReferents(groundingCase)
  if (contextReferents.length > 0) return contextReferents.at(-1) ?? null
  const memoryReferents = memoryContextReferents(groundingCase)
  if (memoryReferents.length > 0) return memoryReferents[0] ?? null
  return null
}

export interface GroundingReferentContext {
  candidateReferentIds: readonly string[]
  primaryReferentId: string | null
  resolvedReferentId: string | null
  isAmbiguous: boolean
  suggestsSpecificSubthread: boolean
  suggestsLatestToolResult: boolean
}

export const resolveGroundingReferentContext = (
  groundingCase: GroundingCase,
): GroundingReferentContext => {
  const utterance = groundingCase.targetUtterance.toLowerCase()
  const history = historyReferents(groundingCase)
  const fromContextChanges = contextChangeReferents(groundingCase)
  const fromMemory = memoryContextReferents(groundingCase)
  const candidates = uniqueOrdered([...history, ...fromContextChanges, ...fromMemory])
  const primaryReferentId = currentHistoryReferent(groundingCase)
  const suggestsLatestToolResult =
    groundingCase.history.some((entry) => entry.kind === "tool_result") ||
    includesAny(utterance, TOOL_RESULT_CUES)
  const suggestsSpecificSubthread =
    includesAny(utterance, GENERIC_SUBTHREAD_CUES) ||
    primaryReferentId !== null ||
    fromContextChanges.length > 0 ||
    fromMemory.length > 0

  let resolvedReferentId: string | null = null
  let isAmbiguous = false

  if (candidates.length === 1) {
    resolvedReferentId = candidates[0] ?? null
  } else if (primaryReferentId !== null && suggestsSpecificSubthread) {
    resolvedReferentId = primaryReferentId
  } else if (
    candidates.length > 1 &&
    groundingCase.history.some((entry) => entry.mentionedReferentIds !== undefined) &&
    includesAny(utterance, ["그거", "그 서브스레드", "that subthread", "닫아"])
  ) {
    isAmbiguous = true
  }

  return {
    candidateReferentIds: candidates,
    primaryReferentId,
    resolvedReferentId,
    isAmbiguous,
    suggestsSpecificSubthread,
    suggestsLatestToolResult,
  }
}
