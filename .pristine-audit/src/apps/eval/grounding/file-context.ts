import { posix } from "node:path"
import type { GroundingCase } from "./schema"

const FILE_ID_PATTERN =
  /(?:^|[\s("'`])((?:\/)?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+)/g

const GENERIC_FILE_CUES = [
  "그 파일",
  "that file",
  "this file",
  "해당 파일",
  "file부터",
  "파일부터",
  "파일만",
  "파일 다시",
  "파일 쪽",
  "index 쪽",
  "엔트리포인트",
  "entrypoint",
  "path",
] as const

const uniqueOrdered = (values: readonly string[]): readonly string[] => [...new Set(values)]

const includesAny = (text: string, needles: readonly string[]): boolean =>
  needles.some((needle) => text.includes(needle))

// Grounding file IDs are always POSIX-style (see FILE_ID_PATTERN /
// isGroundingFileId), so `posix.basename` is the deterministic, platform-stable
// choice — it never re-splits on a Windows backslash that can't appear here.
const basename = (value: string): string => posix.basename(value) || value

const stem = (value: string): string => {
  const base = basename(value)
  const dot = base.lastIndexOf(".")
  return dot <= 0 ? base : base.slice(0, dot)
}

export const isGroundingFileId = (value: string): boolean =>
  value.includes("/") && /(?:^|\/)[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+$/.test(value)

export const extractGroundingFileIds = (text: string): readonly string[] => {
  const out: string[] = []
  for (const match of text.matchAll(FILE_ID_PATTERN)) {
    if (match[1] !== undefined) out.push(match[1])
  }
  return uniqueOrdered(out)
}

const entryFileCandidates = (groundingCase: GroundingCase): readonly string[] =>
  uniqueOrdered(
    groundingCase.history.flatMap((entry) => [
      ...(entry.referentId !== undefined &&
      entry.referentId !== null &&
      isGroundingFileId(entry.referentId)
        ? [entry.referentId]
        : []),
      ...(entry.mentionedFileIds ?? []).filter(isGroundingFileId),
      ...extractGroundingFileIds(entry.text),
    ]),
  )

const primaryFileId = (
  groundingCase: GroundingCase,
  historyCandidates: readonly string[],
): string | null => {
  const fromState = groundingCase.stateContract?.primaryFileId
  if (fromState !== undefined && fromState !== null && isGroundingFileId(fromState))
    return fromState
  const fromOwners = groundingCase.workingState?.ownerShortlist[0]?.file
  if (fromOwners !== undefined && isGroundingFileId(fromOwners)) return fromOwners
  const fromHistory = groundingCase.history.find(
    (entry) =>
      entry.referentId !== undefined &&
      entry.referentId !== null &&
      isGroundingFileId(entry.referentId),
  )?.referentId
  if (fromHistory !== undefined && fromHistory !== null) return fromHistory
  if (historyCandidates.length === 1) return historyCandidates[0] ?? null
  return null
}

const candidateFileIds = (
  groundingCase: GroundingCase,
  historyCandidates: readonly string[],
): readonly string[] =>
  uniqueOrdered([
    ...(groundingCase.stateContract?.candidateFileIds ?? []).filter(isGroundingFileId),
    ...(groundingCase.stateContract?.primaryFileId !== undefined &&
    groundingCase.stateContract.primaryFileId !== null &&
    isGroundingFileId(groundingCase.stateContract.primaryFileId)
      ? [groundingCase.stateContract.primaryFileId]
      : []),
    ...(groundingCase.workingState?.ownerShortlist ?? [])
      .map((entry) => entry.file)
      .filter(isGroundingFileId),
    ...historyCandidates,
  ])

const matchingCandidates = (utterance: string, candidates: readonly string[]): readonly string[] =>
  candidates.filter((candidate) => {
    const fileBasename = basename(candidate).toLowerCase()
    const fileStem = stem(candidate).toLowerCase()
    return (
      utterance.includes(candidate.toLowerCase()) ||
      utterance.includes(fileBasename) ||
      (fileStem.length >= 3 && utterance.includes(fileStem))
    )
  })

export interface GroundingSpecificFileContext {
  utteranceFileIds: readonly string[]
  candidateFileIds: readonly string[]
  matchingCandidateFileIds: readonly string[]
  primaryFileId: string | null
  resolvedReferentId: string | null
  hasExplicitFileCue: boolean
  hasGenericFileCue: boolean
  isAmbiguous: boolean
}

export const resolveGroundingSpecificFileContext = (
  groundingCase: GroundingCase,
): GroundingSpecificFileContext => {
  const utterance = groundingCase.targetUtterance.toLowerCase()
  const utteranceFileIds = extractGroundingFileIds(groundingCase.targetUtterance)
  const historyCandidates = entryFileCandidates(groundingCase)
  const primary = primaryFileId(groundingCase, historyCandidates)
  const candidates = candidateFileIds(groundingCase, historyCandidates)
  const matching = matchingCandidates(utterance, candidates)
  const hasExplicitFileCue = utteranceFileIds.length > 0
  const hasGenericFileCue = includesAny(utterance, GENERIC_FILE_CUES)

  let resolvedReferentId: string | null = null
  let isAmbiguous = false

  if (utteranceFileIds.length === 1) {
    resolvedReferentId = utteranceFileIds[0] ?? null
  } else if (utteranceFileIds.length > 1) {
    isAmbiguous = true
  } else if (matching.length === 1) {
    resolvedReferentId = matching[0] ?? null
  } else if (matching.length > 1) {
    isAmbiguous = true
  } else if (hasGenericFileCue && primary !== null) {
    resolvedReferentId = primary
  } else if (candidates.length === 1) {
    resolvedReferentId = candidates[0] ?? null
  } else if (hasGenericFileCue && candidates.length > 1) {
    isAmbiguous = true
  }

  return {
    utteranceFileIds,
    candidateFileIds: candidates,
    matchingCandidateFileIds: matching,
    primaryFileId: primary,
    resolvedReferentId,
    hasExplicitFileCue,
    hasGenericFileCue,
    isAmbiguous,
  }
}
