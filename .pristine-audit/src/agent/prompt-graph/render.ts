/**
 * ADR-0538 Phase 1 — atom SELECTION + render for the migrated tool-use slice.
 *
 * This is the compiler pipeline restricted to the migrated atoms:
 *   atoms.filter(matches) → resolveSupersedes → sort (section, order) → lines.
 * It replaces the prior `renderPostureBase` list-membership dispatch and the
 * `renderVerifyStrategy` switch. Selection is DECLARATIVE (by `when` matcher +
 * supersede edges), not by which hand-maintained list a rule lived in.
 *
 * PURE: no IO/clock/env. Ordering is deterministic (stable by section then
 * numeric order then variantId tiebreak), so the rendered prefix is byte-stable.
 */

import { matches } from "./matches"
import type { InstructionAtom, PromptContext } from "./types"

/** Section render order within `system.base` for the migrated slice. `posture`
 *  (env guardrails + honesty rails) renders as the tool-use base; `verify` (the
 *  third axis) renders after the task rules. `buildSystemPrompt` splices the two
 *  groups at their respective slots, so we expose them as SEPARATE selectors and
 *  never interleave sections in one call. */
const sectionOf = (a: InstructionAtom): string => a.section

/**
 * Filter to the atoms applicable in `ctx`, then drop any variant superseded by
 * another applicable variant (owned R-* over frozen R-*), then sort
 * deterministically. Returns the surviving atoms in render order.
 */
export const selectAtoms = (
  atoms: readonly InstructionAtom[],
  ctx: PromptContext,
): readonly InstructionAtom[] => {
  const applicable = atoms.filter((a) => matches(a.when, ctx))
  const applicableVariants = new Set(applicable.map((a) => a.variantId))
  // A variant is suppressed iff some OTHER applicable variant supersedes it.
  const suppressed = new Set<string>()
  for (const a of applicable) {
    for (const loser of a.supersedes ?? []) {
      if (applicableVariants.has(loser)) suppressed.add(loser)
    }
  }
  const surviving = applicable.filter((a) => !suppressed.has(a.variantId))
  return [...surviving].sort((x, y) => {
    if (sectionOf(x) !== sectionOf(y)) return sectionOf(x) < sectionOf(y) ? -1 : 1
    if (x.order !== y.order) return x.order - y.order
    return x.variantId < y.variantId ? -1 : x.variantId > y.variantId ? 1 : 0
  })
}

/** Flatten selected atoms to their rendered lines (provenance never included). */
export const renderAtoms = (
  atoms: readonly InstructionAtom[],
  ctx: PromptContext,
): readonly string[] => selectAtoms(atoms, ctx).flatMap((a) => a.lines)
