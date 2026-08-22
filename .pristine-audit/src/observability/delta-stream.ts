/**
 * Generic id-keyed-map structural-delta reconciler.
 *
 * Computes additions / mutations / removals between two snapshots of an
 * id-keyed map, using STRUCTURAL (not reference) equality — the canonical
 * "diff two store reads into a wire delta" algorithm. Relocated from the
 * web-daemon's `observability-emitter.ts` (thin-surface audit): a push surface
 * should FORWARD a computed delta, not own the delta protocol. Reusable by any
 * push surface (web, CLI status stream, Tauri) that tails a store.
 *
 * Why structural equality: the upstream stores return a FRESHLY frozen object
 * on every read, so reference comparison would mark every entry as "changed"
 * on every tick and flood the wire with no-op deltas. `JSON.stringify` is
 * adequate for the data shapes this serves (no functions, cycles, or symbols).
 *
 * Pure: no I/O, no dependencies. `entry: null` in a delta row means "removed".
 */

/** Stable stringify for structural comparison; "" on any serialise failure
 *  (treated as not-equal-to-anything-real, which conservatively re-emits). */
const stringifyForEq = (value: unknown): string => {
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

/** Structural equality via {@link stringifyForEq}. Reference-equal fast path;
 *  `null` is only equal to `null`. */
export const valuesStructurallyEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (a === null || b === null) return false
  return stringifyForEq(a) === stringifyForEq(b)
}

/** Diff two id-keyed maps. Returns one row per added/changed entry
 *  (`{id, entry}`) and per removed entry (`{id, entry: null}`). Order:
 *  additions/mutations (next iteration order) then removals (prev order). */
export const diffMap = <T>(
  prev: Map<string, T>,
  next: Map<string, T>,
): Array<{ id: string; entry: T | null }> => {
  const out: Array<{ id: string; entry: T | null }> = []
  for (const [id, entry] of next) {
    const prior = prev.get(id)
    if (prior === undefined || !valuesStructurallyEqual(prior, entry)) {
      out.push({ id, entry })
    }
  }
  for (const id of prev.keys()) {
    if (!next.has(id)) out.push({ id, entry: null })
  }
  return out
}
