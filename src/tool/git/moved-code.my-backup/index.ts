/**
 * Moved-code detector — `classifyDiff` orchestrator (ADR-0109).
 *
 * Classifies a flat `DiffHunk[]` (typically from `parseUnifiedDiff`) into:
 *   - `moved`: removed/added hunk pairs with weighted-Jaccard similarity
 *     ≥ `minSimilarity` (default 0.85), both sides ≥ `minLines` (default 5).
 *   - `logic`: hunks that did NOT match (real change, surface in review).
 *   - `mechanical`: reserved for future expansion (empty today).
 *
 * Algorithm: greedy best-similarity-first 1:1 matching with strict total
 * order tie-break (similarity DESC → fromStartLine ASC → toStartLine ASC →
 * fromFile/toFile alphabetic). When `removed × added` count exceeds
 * `maxPairs` (default 10_000), the detector returns ALL hunks as logic —
 * no partial detection on a half-explored pair space.
 */

import { normalizeLines, tokenizeBody } from "./normalize"
import { parseUnifiedDiff } from "./parse-unified-diff"
import { weightedJaccard } from "./similarity"
import type { ClassifyOptions, DiffClassification, DiffHunk, MovedBlock } from "./types"

const DEFAULT_MIN_LINES = 5
const DEFAULT_MIN_SIMILARITY = 0.85
const DEFAULT_MAX_PAIRS = 10_000

interface CandidatePair {
  readonly removedIndex: number
  readonly addedIndex: number
  readonly similarity: number
  readonly fromStartLine: number
  readonly toStartLine: number
  readonly fromFile: string
  readonly toFile: string
}

/** Strict total order — primary similarity DESC, then ASC line + file
 *  alphabetic so the greedy lock is byte-stable across runs. */
const compareCandidates = (a: CandidatePair, b: CandidatePair): number => {
  if (a.similarity !== b.similarity) return b.similarity - a.similarity
  if (a.fromStartLine !== b.fromStartLine) return a.fromStartLine - b.fromStartLine
  if (a.toStartLine !== b.toStartLine) return a.toStartLine - b.toStartLine
  if (a.fromFile !== b.fromFile) return a.fromFile < b.fromFile ? -1 : 1
  if (a.toFile !== b.toFile) return a.toFile < b.toFile ? -1 : 1
  return 0
}

const countLines = (hunk: DiffHunk): number => normalizeLines(hunk.body).length

const buildMovedBlock = (removed: DiffHunk, added: DiffHunk, similarity: number): MovedBlock => ({
  fromFile: removed.file,
  fromStartLine: removed.startLine,
  fromEndLine: removed.endLine,
  toFile: added.file,
  toStartLine: added.startLine,
  toEndLine: added.endLine,
  similarity,
  body: normalizeLines(removed.body).join("\n"),
})

interface SplitHunks {
  removed: DiffHunk[]
  added: DiffHunk[]
}

const splitByKind = (hunks: readonly DiffHunk[]): SplitHunks => {
  const removed: DiffHunk[] = []
  const added: DiffHunk[] = []
  for (const h of hunks) {
    if (h.kind === "removed") removed.push(h)
    else added.push(h)
  }
  return { removed, added }
}

interface BuildCandidatesArgs {
  removed: readonly DiffHunk[]
  added: readonly DiffHunk[]
  minLines: number
  minSimilarity: number
}

const buildCandidates = (args: BuildCandidatesArgs): CandidatePair[] => {
  const { removed, added, minLines, minSimilarity } = args
  const candidates: CandidatePair[] = []
  for (let i = 0; i < removed.length; i++) {
    const r = removed[i]
    if (r === undefined || countLines(r) < minLines) continue
    const rTokens = tokenizeBody(normalizeLines(r.body))
    for (let j = 0; j < added.length; j++) {
      const a = added[j]
      if (a === undefined || countLines(a) < minLines) continue
      const aTokens = tokenizeBody(normalizeLines(a.body))
      const sim = weightedJaccard(rTokens, aTokens)
      if (sim < minSimilarity) continue
      candidates.push({
        removedIndex: i,
        addedIndex: j,
        similarity: sim,
        fromStartLine: r.startLine,
        toStartLine: a.startLine,
        fromFile: r.file,
        toFile: a.file,
      })
    }
  }
  return candidates
}

interface LockedSet {
  moved: MovedBlock[]
  removedLocked: Set<number>
  addedLocked: Set<number>
}

const pickLocked = (
  candidates: CandidatePair[],
  removed: readonly DiffHunk[],
  added: readonly DiffHunk[],
): LockedSet => {
  candidates.sort(compareCandidates)
  const removedLocked = new Set<number>()
  const addedLocked = new Set<number>()
  const moved: MovedBlock[] = []
  for (const c of candidates) {
    if (removedLocked.has(c.removedIndex) || addedLocked.has(c.addedIndex)) continue
    const r = removed[c.removedIndex]
    const a = added[c.addedIndex]
    if (r === undefined || a === undefined) continue
    removedLocked.add(c.removedIndex)
    addedLocked.add(c.addedIndex)
    moved.push(buildMovedBlock(r, a, c.similarity))
  }
  return { moved, removedLocked, addedLocked }
}

const collectLogic = (
  removed: readonly DiffHunk[],
  added: readonly DiffHunk[],
  removedLocked: ReadonlySet<number>,
  addedLocked: ReadonlySet<number>,
): DiffHunk[] => {
  const logic: DiffHunk[] = []
  for (let i = 0; i < removed.length; i++) {
    const h = removed[i]
    if (h !== undefined && !removedLocked.has(i)) logic.push(h)
  }
  for (let j = 0; j < added.length; j++) {
    const h = added[j]
    if (h !== undefined && !addedLocked.has(j)) logic.push(h)
  }
  return logic
}

/** Public seam. Classifies an arbitrary `DiffHunk[]` (e.g. from
 *  {@link parseUnifiedDiff}) into moved / logic / mechanical buckets. */
export const classifyDiff = (
  hunks: readonly DiffHunk[],
  options?: ClassifyOptions,
): DiffClassification => {
  const minLines = options?.minLines ?? DEFAULT_MIN_LINES
  const minSimilarity = options?.minSimilarity ?? DEFAULT_MIN_SIMILARITY
  const maxPairs = options?.maxPairs ?? DEFAULT_MAX_PAIRS

  const { removed, added } = splitByKind(hunks)

  // Pair-space DoS guard: large hunk count ⇒ skip detection, surface all as logic.
  if (removed.length * added.length > maxPairs) {
    return { logic: hunks, moved: [], mechanical: [] }
  }

  const candidates = buildCandidates({ removed, added, minLines, minSimilarity })
  const { moved, removedLocked, addedLocked } = pickLocked(candidates, removed, added)
  const logic = collectLogic(removed, added, removedLocked, addedLocked)

  return { logic, moved, mechanical: [] }
}

export { normalizeLine, normalizeLines, tokenize, tokenizeBody } from "./normalize"
export { parseUnifiedDiff } from "./parse-unified-diff"
export { bodySimilarity, weightedJaccard } from "./similarity"
export type {
  ClassifyOptions,
  DiffClassification,
  DiffHunk,
  MovedBlock,
} from "./types"
