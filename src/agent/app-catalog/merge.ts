/**
 * ADR-0342 — Pure merge primitive: base catalog + workspace override.
 *
 * Composes {@link DEFAULT_APP_CATALOG} (or any base array) with a
 * workspace-supplied override array. Pure — no I/O, no clock, no
 * throws. Returns a fresh array; the input references are
 * never mutated.
 *
 * Precedence policy: **workspace wins on `id` collision.**
 *
 * This is the OPPOSITE of ADR-0339's `unionActiveSkills` ("caller
 * wins, plugin supplements"). Justification:
 *
 *   - In ADR-0339 the plugin is a third-party supplement and the
 *     caller is the user-pinned slice; the user is closer to intent.
 *   - HERE the "override" *is* the user-pinned slice (per-workspace
 *     `.quanta/apps.json`) and the "base" is the global default
 *     ({@link DEFAULT_APP_CATALOG}). The workspace customization is
 *     MORE specific than the global default — same direction, opposite
 *     argument structure.
 *
 * Adding a new id (one not present in the base) APPENDS the entry
 * after the base entries, preserving the base's relative order and
 * the override's submission order for the new ids.
 *
 * NO-THROW. Inputs that are not arrays are treated as empty.
 */

import type { AppDescriptor } from "./types"

/** Type guard for a usable descriptor: non-null object with a non-empty
 *  string id. Extracted to keep {@link mergeAppCatalogs} below the
 *  cog-complexity cap (biome `noExcessiveCognitiveComplexity`). */
const isUsableDescriptor = (d: unknown): d is AppDescriptor => {
  if (d === null || typeof d !== "object") return false
  const id = (d as { id?: unknown }).id
  return typeof id === "string" && id.length > 0
}

/** Seed the id→descriptor map from `base`, returning the discovery
 *  order (first-occurrence-wins ordering of ids). Last write wins on
 *  duplicate ids within `base`; insertion order is captured the first
 *  time each id is seen. */
const seedBase = (
  base: readonly AppDescriptor[],
  byId: Map<string, AppDescriptor>,
): readonly string[] => {
  const baseOrder: string[] = []
  for (const d of base) {
    if (!isUsableDescriptor(d)) continue
    if (!byId.has(d.id)) baseOrder.push(d.id)
    byId.set(d.id, d)
  }
  return baseOrder
}

/** Apply override entries to the map. Returns the ordered list of
 *  NEW override ids — ids that did not exist in the seeded map prior
 *  to the override pass. Existing ids are replaced in-place
 *  (workspace-wins). */
const applyOverrides = (
  overrides: readonly AppDescriptor[],
  byId: Map<string, AppDescriptor>,
): readonly string[] => {
  const newIds: string[] = []
  const seen = new Set<string>()
  for (const d of overrides) {
    if (!isUsableDescriptor(d)) continue
    if (!byId.has(d.id) && !seen.has(d.id)) {
      newIds.push(d.id)
      seen.add(d.id)
    }
    byId.set(d.id, d) // workspace wins on collision
  }
  return newIds
}

/**
 * Compose `base` with `overrides` under workspace-wins precedence.
 *
 * Algorithm:
 *
 *   1. Build a map from id → descriptor seeded with `base` entries in
 *      order. Last write wins among `base` entries themselves (defensive
 *      — `DEFAULT_APP_CATALOG` has no duplicates, but a custom base
 *      might).
 *   2. For each override entry, overwrite the map at its id. New ids
 *      are appended; existing ids are replaced in-place (order
 *      preserved).
 *   3. Walk the original `base` order, emit each entry's CURRENT map
 *      value (which is the override if one collided), then append any
 *      override ids that did not collide, in their submission order.
 *
 * @returns fresh array. Inputs are not mutated.
 */
export const mergeAppCatalogs = (
  base: readonly AppDescriptor[],
  overrides: readonly AppDescriptor[],
): readonly AppDescriptor[] => {
  const safeBase = Array.isArray(base) ? base : []
  const safeOverrides = Array.isArray(overrides) ? overrides : []

  const byId = new Map<string, AppDescriptor>()
  const baseOrder = seedBase(safeBase, byId)
  const newOverrideOrder = applyOverrides(safeOverrides, byId)

  const out: AppDescriptor[] = []
  for (const id of baseOrder) {
    const v = byId.get(id)
    if (v !== undefined) out.push(v)
  }
  for (const id of newOverrideOrder) {
    const v = byId.get(id)
    if (v !== undefined) out.push(v)
  }
  return out
}
