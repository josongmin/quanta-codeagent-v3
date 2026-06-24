import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { splitHunks } from "@/runner/diff-ops"
import { filesFromUnifiedDiff } from "@/shared"
import type { CandidateFamily } from "./candidate-families"
import type { ChaRepairTarget } from "./cha-multisite"
import { withCandidatePatch } from "./rematerialize"
import type { Candidate } from "./selection-types"
import { gitStageAndDiffCached } from "./snapshot"

const MAX_DONOR_HUNKS = 4
const MAX_HUNK_LINES = 12

interface ExactReplayHunk {
  readonly removed: readonly string[]
  readonly added: readonly string[]
  readonly beforeAnchor: string | undefined
  readonly afterAnchor: string | undefined
}

const linesOf = (text: string): string[] => (text === "" ? [] : text.split("\n"))

const exactReplayHunks = (before: string, after: string): readonly ExactReplayHunk[] => {
  const beforeLines = linesOf(before)
  return splitHunks(before, after)
    .map((hunk) => {
      const removed = hunk.ops.filter((op) => op.kind === "del").map((op) => op.line)
      const added = hunk.ops.filter((op) => op.kind === "add").map((op) => op.line)
      const removedCount = removed.length
      const beforeAnchorIndex = removedCount > 0 ? hunk.oldStart - 2 : hunk.oldStart - 1
      const afterAnchorIndex = removedCount > 0 ? hunk.oldStart - 1 + removedCount : hunk.oldStart
      return {
        removed,
        added,
        beforeAnchor: beforeAnchorIndex >= 0 ? beforeLines[beforeAnchorIndex] : undefined,
        afterAnchor:
          afterAnchorIndex >= 0 && afterAnchorIndex < beforeLines.length
            ? beforeLines[afterAnchorIndex]
            : undefined,
      }
    })
    .filter((hunk) => hunk.removed.length + hunk.added.length > 0)
}

const insertionAnchorMatch = (
  lines: readonly string[],
  index: number,
  beforeAnchor: string | undefined,
  afterAnchor: string | undefined,
): boolean => {
  const beforeOk = beforeAnchor === undefined || (index > 0 && lines[index - 1] === beforeAnchor)
  const afterOk =
    afterAnchor === undefined || (index < lines.length && lines[index] === afterAnchor)
  return beforeOk && afterOk
}

const matchingInsertIndices = (
  lines: readonly string[],
  beforeAnchor: string | undefined,
  afterAnchor: string | undefined,
): number[] => {
  if (lines.length === 0) return [0]
  const matches: number[] = []
  for (let i = 0; i <= lines.length; i += 1) {
    if (insertionAnchorMatch(lines, i, beforeAnchor, afterAnchor)) matches.push(i)
  }
  return matches
}

const blockMatchesAt = (
  lines: readonly string[],
  index: number,
  block: readonly string[],
  beforeAnchor: string | undefined,
  afterAnchor: string | undefined,
): boolean => {
  for (let j = 0; j < block.length; j += 1) {
    if (lines[index + j] !== block[j]) return false
  }
  const beforeOk = beforeAnchor === undefined || (index > 0 && lines[index - 1] === beforeAnchor)
  const afterIndex = index + block.length
  const afterOk =
    afterAnchor === undefined || (afterIndex < lines.length && lines[afterIndex] === afterAnchor)
  return beforeOk && afterOk
}

const matchingBlockIndices = (
  lines: readonly string[],
  block: readonly string[],
  beforeAnchor: string | undefined,
  afterAnchor: string | undefined,
): number[] => {
  const matches: number[] = []
  for (let i = 0; i + block.length <= lines.length; i += 1) {
    if (blockMatchesAt(lines, i, block, beforeAnchor, afterAnchor)) matches.push(i)
  }
  return matches
}

const findExactBlock = (
  lines: readonly string[],
  block: readonly string[],
  beforeAnchor: string | undefined,
  afterAnchor: string | undefined,
): number | undefined => {
  const matches =
    block.length === 0
      ? matchingInsertIndices(lines, beforeAnchor, afterAnchor)
      : matchingBlockIndices(lines, block, beforeAnchor, afterAnchor)
  return matches.length === 1 ? matches[0] : undefined
}

const boundedReplayHunks = (
  donorBefore: string,
  donorAfter: string,
): readonly ExactReplayHunk[] | undefined => {
  const hunks = exactReplayHunks(donorBefore, donorAfter)
  if (hunks.length === 0 || hunks.length > MAX_DONOR_HUNKS) return undefined
  if (hunks.some((hunk) => hunk.removed.length + hunk.added.length > MAX_HUNK_LINES))
    return undefined
  return hunks
}

const applyExactReplay = (
  targetText: string,
  donorBefore: string,
  donorAfter: string,
): string | undefined => {
  const hunks = boundedReplayHunks(donorBefore, donorAfter)
  if (hunks === undefined) return undefined
  const targetLines = linesOf(targetText)
  let changed = false
  for (const hunk of hunks) {
    const at = findExactBlock(targetLines, hunk.removed, hunk.beforeAnchor, hunk.afterAnchor)
    if (at === undefined) return undefined
    targetLines.splice(at, hunk.removed.length, ...hunk.added)
    changed = true
  }
  return changed ? targetLines.join("\n") : undefined
}

const baseFileText = (sandbox: string, relPath: string): string | undefined => {
  try {
    return readFileSync(join(sandbox, relPath), "utf8")
  } catch {
    return undefined
  }
}

const donorTargetsOf = (args: {
  readonly candidate: Candidate
  readonly family: CandidateFamily
  readonly missingFiles: readonly string[]
  readonly preferredTargets: readonly ChaRepairTarget[]
}): readonly { file: string; missingFiles: readonly string[] }[] => {
  const familyDonors = args.candidate.files.filter((file) => args.family.ownerFiles.includes(file))
  if (familyDonors.length === 0) return []
  const preferred = args.preferredTargets
    .filter((target) => familyDonors.includes(target.file))
    .map((target) => ({
      file: target.file,
      missingFiles: args.missingFiles.filter((file) =>
        target.sites.some((site) => site.file === file),
      ),
    }))
    .filter((target) => target.missingFiles.length > 0)
  if (preferred.length > 0) return preferred
  return familyDonors.map((file) => ({ file, missingFiles: args.missingFiles }))
}

const applyDonorReplayToMissingFiles = (args: {
  readonly patchedSandbox: string
  readonly donorBefore: string
  readonly donorAfter: string
  readonly missingFiles: readonly string[]
}): readonly string[] => {
  if (args.donorBefore === args.donorAfter) return []
  const changedTargets: string[] = []
  for (const missingFile of args.missingFiles) {
    const targetBefore = baseFileText(args.patchedSandbox, missingFile)
    if (targetBefore === undefined) continue
    const targetAfter = applyExactReplay(targetBefore, args.donorBefore, args.donorAfter)
    if (targetAfter === undefined || targetAfter === targetBefore) continue
    writeFileSync(join(args.patchedSandbox, missingFile), targetAfter, "utf8")
    changedTargets.push(missingFile)
  }
  return changedTargets
}

const coeditedCandidateFromSandbox = async (args: {
  readonly patchedSandbox: string
  readonly candidate: Candidate
  readonly donors: readonly { file: string; missingFiles: readonly string[] }[]
  readonly donorBase: ReadonlyMap<string, string>
  readonly timeoutMs: number
}): Promise<Candidate | undefined> => {
  const changedTargets = new Set<string>()
  for (const donor of args.donors) {
    const donorBefore = args.donorBase.get(donor.file)
    const donorAfter = baseFileText(args.patchedSandbox, donor.file)
    if (donorBefore === undefined || donorAfter === undefined) continue
    for (const changedFile of applyDonorReplayToMissingFiles({
      patchedSandbox: args.patchedSandbox,
      donorBefore,
      donorAfter,
      missingFiles: donor.missingFiles,
    })) {
      changedTargets.add(changedFile)
    }
  }
  if (changedTargets.size === 0) return undefined
  const patch = await gitStageAndDiffCached(args.patchedSandbox, args.timeoutMs)
  if (patch.trim() === "") return undefined
  return {
    ...args.candidate,
    patch,
    files: filesFromUnifiedDiff(patch),
  }
}

export const coeditFamilyCoverageCandidate = async (args: {
  readonly sandbox: string
  readonly candidate: Candidate
  readonly family: CandidateFamily
  readonly missingFiles: readonly string[]
  readonly timeoutMs: number
  readonly baseCommit: string | undefined
  readonly repo: string | undefined
  readonly preferredTargets?: readonly ChaRepairTarget[]
}): Promise<Candidate | undefined> => {
  if (args.candidate.patch.trim() === "" || args.missingFiles.length === 0) return undefined
  const donors = donorTargetsOf({
    candidate: args.candidate,
    family: args.family,
    missingFiles: args.missingFiles,
    preferredTargets: args.preferredTargets ?? [],
  })
  if (donors.length === 0) return undefined
  const donorBase = new Map<string, string>()
  for (const donor of donors) {
    const text = baseFileText(args.sandbox, donor.file)
    if (text !== undefined) donorBase.set(donor.file, text)
  }
  if (donorBase.size === 0) return undefined
  return (
    (await withCandidatePatch({
      sandbox: args.sandbox,
      patch: args.candidate.patch,
      baseCommit: args.baseCommit,
      timeoutMs: args.timeoutMs,
      ...(args.repo !== undefined ? { repo: args.repo } : {}),
      probe: (patchedSandbox) =>
        coeditedCandidateFromSandbox({
          patchedSandbox,
          candidate: args.candidate,
          donors,
          donorBase,
          timeoutMs: args.timeoutMs,
        }),
    })) ?? undefined
  )
}

export const __private__ = {
  applyExactReplay,
  exactReplayHunks,
}
