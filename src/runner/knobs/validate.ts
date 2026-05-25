/**
 * Knob relationship validation — runs after a layered resolution has
 * produced the set of ACTIVE knobs.
 *
 * Rules:
 *   - `conflicts`: pair `(a, b)` reported when both ids are active. The
 *     relation is treated as symmetric; we still iterate from both sides to
 *     surface every reciprocal declaration. We DO NOT chain through a
 *     middle knob — A↔B, B↔C with A+C active does not raise.
 *   - `requires`: throws `KnobMissingRequiredError` the first time a
 *     required dependency is absent. Throw order is deterministic on
 *     iteration; callers should not depend on WHICH one fires first when
 *     multiple are missing.
 *   - Circular requires (A->B, B->A) are NOT a config error by themselves;
 *     when both A and B are active, both `requires` are satisfied. When
 *     only one is active, that one throws on the missing peer.
 */

import type { AnyKnob, KnobValueMap } from "./types"
import { KnobConflictError, KnobMissingRequiredError } from "./types"

/** Throws on the FIRST missing required peer. Deterministic on iteration. */
const enforceRequires = (
  active: ReadonlySet<string>,
  knobs: ReadonlyMap<string, AnyKnob>,
): void => {
  for (const id of active) {
    const k = knobs.get(id)
    if (!k) continue
    for (const r of k.requires ?? []) {
      if (!active.has(r)) throw new KnobMissingRequiredError(id, r)
    }
  }
}

/** Collect all reciprocal conflict pairs, deduped by sorted pair key. */
const collectConflicts = (
  active: ReadonlySet<string>,
  knobs: ReadonlyMap<string, AnyKnob>,
): ReadonlyArray<[string, string]> => {
  const seen = new Set<string>()
  const conflicts: [string, string][] = []
  for (const id of active) {
    const k = knobs.get(id)
    if (!k) continue
    for (const c of k.conflicts ?? []) {
      if (!active.has(c)) continue
      const key = id < c ? `${id} ${c}` : `${c} ${id}`
      if (seen.has(key)) continue
      seen.add(key)
      conflicts.push([id, c])
    }
  }
  return conflicts
}

export const validateKnobs = (values: KnobValueMap, knobs: ReadonlyMap<string, AnyKnob>): void => {
  const active = new Set(values.keys())
  // Requires first — a missing required is a developer error and surfaces
  // even when there's also a conflict (conflict reporting is batched so a
  // partial config never gets a chance to be debugged otherwise).
  enforceRequires(active, knobs)
  const conflicts = collectConflicts(active, knobs)
  if (conflicts.length > 0) throw new KnobConflictError(conflicts)
}
