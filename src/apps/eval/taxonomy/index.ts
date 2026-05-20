/**
 * Taxonomy tree helpers — pure, no I/O. The `TAXONOMY` array in `usecases.ts`
 * is the only source; everything here is a derived view. Memoised on first
 * access (the tree is frozen for the lifetime of the process).
 */
import type { UseCaseId } from "../types"
import { TAXONOMY, type UseCaseLeaf, type UseCaseMajor, type UseCaseMid } from "./usecases"

export type { UseCaseLeaf, UseCaseMajor, UseCaseMid }
export { TAXONOMY }

/** Flat ordered list of every leaf in the tree. Same order as `TAXONOMY`. */
let LEAVES_CACHE: readonly UseCaseLeaf[] | null = null
export const allLeaves = (): readonly UseCaseLeaf[] => {
  if (LEAVES_CACHE !== null) return LEAVES_CACHE
  const out: UseCaseLeaf[] = []
  for (const maj of TAXONOMY) for (const m of maj.mids) for (const l of m.leaves) out.push(l)
  LEAVES_CACHE = out
  return out
}

/** Map of `id → leaf`, built lazily once. */
let LEAVES_BY_ID: ReadonlyMap<UseCaseId, UseCaseLeaf> | null = null
export const leafById = (id: UseCaseId): UseCaseLeaf | undefined => {
  if (LEAVES_BY_ID === null) {
    LEAVES_BY_ID = new Map(allLeaves().map((l) => [l.id, l]))
  }
  return LEAVES_BY_ID.get(id)
}

/** Parse `major.mid.leaf` → its three id segments. Returns null on shape error
 *  (does NOT verify existence — callers compose with `leafById`). */
export const parseId = (id: UseCaseId): { major: string; mid: string; leaf: string } | null => {
  const parts = id.split(".")
  if (parts.length !== 3) return null
  const [major, mid, leaf] = parts
  if (!major || !mid || !leaf) return null
  return { major, mid, leaf }
}

/** Total leaf count — handy for coverage math and the audit matrix. */
export const leafCount = (): number => allLeaves().length

/** Aggregate empirical share for a major; undefined when not measured. */
export const majorShare = (majorId: string): number | undefined => {
  const m = TAXONOMY.find((x) => x.id === majorId)
  return m?.empiricalShare
}

/** Pretty header line for a leaf, used by reports and the classifier prompt. */
export const formatLeafLine = (l: UseCaseLeaf): string => {
  const examples = l.examples.length > 0 ? ` — e.g. "${l.examples[0]}"` : ""
  return `${l.id}: ${l.label}${examples}`
}

export type { ClassifyOpts, ClassifyResult } from "./classifier"
export { classifyQuery } from "./classifier"
