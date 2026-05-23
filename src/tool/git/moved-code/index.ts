/**
 * Moved-code classifier — ADR-0109 (PR-review canvas §2 "moved" category).
 *
 * Public API:
 *   - `classifyDiff(hunks, options?)` — main classifier; pure, deterministic.
 *   - `parseUnifiedDiff(text)` — re-exported for convenience.
 *   - All types from `./types`.
 *
 * Algorithm (matches ADR-0109 §결정):
 *
 *   1. Group input hunks by polarity: `removed[]` and `added[]`.
 *   2. Each side is normalized → token-list. Hunks whose normalized line
 *      count falls below `minLines` cannot participate as a moved-pair side
 *      (would be a false-positive trap on short blocks).
 *   3. For every (r, a) pair compute Jaccard token similarity. If the pair
 *      product `|removed|×|added|` exceeds `maxPairs`, skip detection
 *      entirely (everything → logic). This bounds worst-case to O(N×M)
 *      tokenize-and-compare work at the cap.
 *   4. Build a sorted candidate list (highest similarity first), greedily
 *      lock 1:1 (best-first) — each `-`/`+` hunk participates in at most
 *      ONE moved pair. Ties broken by (lowest fromStartLine, lowest
 *      toStartLine) for determinism.
 *   5. Surviving paired hunks → `moved[]`. Unpaired hunks → `logic[]`.
 *   6. `mechanical[]` is currently always empty (follow-up; see ADR §결과).
 *
 * Determinism: input order does not affect output other than the final
 * ordering of `logic` (we preserve input order for `logic`, and emit
 * `moved` in best-similarity-first order).
 */
import { normalizeBody, normalizeLines, tokenize } from "./normalize"
import { jaccardSimilarity } from "./similarity"
import type { ClassifyOptions, DiffClassification, DiffHunk, MovedBlock } from "./types"

export { parseUnifiedDiff } from "./parse-unified-diff"
export type {
  ClassifyOptions,
  DiffClassification,
  DiffHunk,
  MovedBlock,
} from "./types"

const DEFAULT_MIN_LINES = 5
const DEFAULT_MIN_SIMILARITY = 0.85
const DEFAULT_MAX_PAIRS = 10_000

interface Prepped {
  readonly hunk: DiffHunk
  readonly normLineCount: number
  readonly tokens: readonly string[]
}

interface Candidate {
  readonly r: number // index into removed[]
  readonly a: number // index into added[]
  readonly similarity: number
}

const prep = (hunks: readonly DiffHunk[]): Prepped[] =>
  hunks.map((h) => ({
    hunk: h,
    normLineCount: normalizeLines(h.body).length,
    tokens: tokenize(h.body),
  }))

/** Polarity-split input hunks, preserving order. */
const splitByKind = (hunks: readonly DiffHunk[]): { removed: DiffHunk[]; added: DiffHunk[] } => {
  const removed: DiffHunk[] = []
  const added: DiffHunk[] = []
  for (const h of hunks) {
    if (h.kind === "removed") removed.push(h)
    else added.push(h)
  }
  return { removed, added }
}

/** O(N×M) Jaccard pass; emits only pairs that clear minLines + minSimilarity. */
const generateCandidates = (
  removedPrep: readonly Prepped[],
  addedPrep: readonly Prepped[],
  minLines: number,
  minSimilarity: number,
): Candidate[] => {
  const out: Candidate[] = []
  for (let r = 0; r < removedPrep.length; r += 1) {
    const rp = removedPrep[r]
    if (rp === undefined || rp.normLineCount < minLines) continue
    for (let a = 0; a < addedPrep.length; a += 1) {
      const ap = addedPrep[a]
      if (ap === undefined || ap.normLineCount < minLines) continue
      const sim = jaccardSimilarity(rp.tokens, ap.tokens)
      if (sim >= minSimilarity) out.push({ r, a, similarity: sim })
    }
  }
  return out
}

/** Strict total order on candidates: similarity ↓, fromStartLine ↑, toStartLine ↑, r ↑, a ↑. */
const compareCandidates = (
  removed: readonly DiffHunk[],
  added: readonly DiffHunk[],
  x: Candidate,
  y: Candidate,
): number => {
  if (y.similarity !== x.similarity) return y.similarity - x.similarity
  const rx = removed[x.r]
  const ry = removed[y.r]
  const ax = added[x.a]
  const ay = added[y.a]
  if (rx !== undefined && ry !== undefined && rx.startLine !== ry.startLine) {
    return rx.startLine - ry.startLine
  }
  if (ax !== undefined && ay !== undefined && ax.startLine !== ay.startLine) {
    return ax.startLine - ay.startLine
  }
  if (x.r !== y.r) return x.r - y.r
  return x.a - y.a
}

/** Greedy 1:1 lock — caller pre-sorts. */
const greedyMatch = (
  candidates: readonly Candidate[],
  removed: readonly DiffHunk[],
  added: readonly DiffHunk[],
): { moved: MovedBlock[]; usedRemoved: Set<number>; usedAdded: Set<number> } => {
  const usedRemoved = new Set<number>()
  const usedAdded = new Set<number>()
  const moved: MovedBlock[] = []
  for (const c of candidates) {
    if (usedRemoved.has(c.r) || usedAdded.has(c.a)) continue
    const r = removed[c.r]
    const a = added[c.a]
    if (r === undefined || a === undefined) continue
    usedRemoved.add(c.r)
    usedAdded.add(c.a)
    moved.push({
      fromFile: r.file,
      fromStartLine: r.startLine,
      fromEndLine: r.endLine,
      toFile: a.file,
      toStartLine: a.startLine,
      toEndLine: a.endLine,
      similarity: c.similarity,
      body: normalizeBody(a.body),
    })
  }
  return { moved, usedRemoved, usedAdded }
}

/** Collect unpaired input hunks, preserving the original input order. */
const collectLogic = (
  hunks: readonly DiffHunk[],
  removed: readonly DiffHunk[],
  added: readonly DiffHunk[],
  usedRemoved: ReadonlySet<number>,
  usedAdded: ReadonlySet<number>,
): DiffHunk[] => {
  const usedHunks = new Set<DiffHunk>()
  for (const idx of usedRemoved) {
    const h = removed[idx]
    if (h !== undefined) usedHunks.add(h)
  }
  for (const idx of usedAdded) {
    const h = added[idx]
    if (h !== undefined) usedHunks.add(h)
  }
  const logic: DiffHunk[] = []
  for (const h of hunks) {
    if (!usedHunks.has(h)) logic.push(h)
  }
  return logic
}

const allLogic = (hunks: readonly DiffHunk[]): DiffClassification => ({
  logic: hunks,
  moved: [],
  mechanical: [],
})

export const classifyDiff = (
  hunks: readonly DiffHunk[],
  options?: ClassifyOptions,
): DiffClassification => {
  const minLines = options?.minLines ?? DEFAULT_MIN_LINES
  const minSimilarity = options?.minSimilarity ?? DEFAULT_MIN_SIMILARITY
  const maxPairs = options?.maxPairs ?? DEFAULT_MAX_PAIRS

  if (hunks.length === 0) {
    return { logic: [], moved: [], mechanical: [] }
  }

  const { removed, added } = splitByKind(hunks)

  // No pairing possible if either side is empty → everything is logic.
  // O(N×M) cap (ADR §함정). When breached, surface everything as logic.
  if (removed.length === 0 || added.length === 0 || removed.length * added.length > maxPairs) {
    return allLogic(hunks)
  }

  const removedPrep = prep(removed)
  const addedPrep = prep(added)
  const candidates = generateCandidates(removedPrep, addedPrep, minLines, minSimilarity)
  candidates.sort((x, y) => compareCandidates(removed, added, x, y))

  const { moved, usedRemoved, usedAdded } = greedyMatch(candidates, removed, added)
  const logic = collectLogic(hunks, removed, added, usedRemoved, usedAdded)

  return { logic, moved, mechanical: [] }
}
