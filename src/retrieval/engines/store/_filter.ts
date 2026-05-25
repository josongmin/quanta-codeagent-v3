/**
 * Shared store helpers — ADR-0261.
 *
 * `matchesFilter` + a small `StoredHit` constructor that picks the right
 * shape based on `metadata` presence (exactOptionalPropertyTypes-safe).
 */
import type { Filter, StoredHit } from "./types"

export const matchesFilter = (
  metadata: Readonly<Record<string, string | number | boolean>> | undefined,
  filter: Filter | undefined,
): boolean => {
  if (filter?.equals === undefined) return true
  if (metadata === undefined) return false
  for (const k in filter.equals) {
    if (metadata[k] !== filter.equals[k]) return false
  }
  return true
}

/** Build a `StoredHit`; omits `metadata` when undefined. */
export const makeHit = (
  id: string,
  score: number,
  metadata: Readonly<Record<string, string | number | boolean>> | undefined,
): StoredHit => (metadata === undefined ? { id, score } : { id, score, metadata })
