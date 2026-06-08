import type { SkillGate } from "../turn-context"
import { filterSpecsByScope } from "./skill-gate"

/**
 * ADR-0512 P3 — read-only projection of the skill availability filter (L1) for
 * surface display. A `/state` panel renders this to answer the user's "왜 이
 * 도구가 없지?": which tools the CURRENTLY-active skill scoped IN (the model can
 * see + call them) vs OUT (the model never sees them).
 *
 * REUSES the stable skill-gate exports — `filterSpecsByScope` (the SAME predicate
 * the send-site applies, ADR-0512 invariant #2) for `visibleTools`, and the
 * gate's own `activeSkillName()` for the label — so the panel can NEVER drift
 * from what the model actually sees. This module owns NO scope logic of its own.
 */
export interface SkillScopeView {
  /** The id of the skill that currently scopes the agent, or `null` when no
   *  allowlist-bearing skill is active (gate absent OR armed-but-no-scope). */
  readonly activeSkill: string | null
  /** Tool names the model SEES this turn (nav-base ∪ active allowlist), in spec
   *  order. When nothing is scoped, this is every spec name (byte-identical). */
  readonly visibleTools: readonly string[]
  /** Tool names the active skill scoped OUT (spec order). Empty when nothing is
   *  scoped — the L1 filter is a no-op then. */
  readonly hiddenTools: readonly string[]
}

/**
 * Project the active skill's visible/hidden tool partition from the live gate +
 * the session's spec set.
 *
 *  - `gate === undefined` (skill-less session, or v2 OFF ⇒ the loop never built
 *    a gate path the surface cares about) ⇒ `activeSkill: null`, ALL visible,
 *    nothing hidden. Byte-identical "nothing scoped".
 *  - gate present but no skill armed (`activeSkillName() === undefined`) ⇒ same
 *    "nothing scoped" view — `filterSpecsByScope` returns the same `specs`
 *    reference, so `hiddenTools` is empty and the panel omits the section.
 *  - a skill is armed ⇒ `visibleTools` = `filterSpecsByScope` (nav-base ∪
 *    allowlist), `hiddenTools` = the spec-order complement.
 *
 * Pure: no I/O, no clock, no mutation of the gate. Safe to call per `/state`
 * invocation (re-reads the live gate so the panel reflects the CURRENT scope,
 * which a mid-turn `Skill` call may have armed).
 */
export const buildSkillScopeView = <T extends { name: string }>(
  gate: SkillGate | undefined,
  specs: readonly T[],
): SkillScopeView => {
  const allNames = specs.map((s) => s.name)
  if (gate === undefined) {
    return { activeSkill: null, visibleTools: allNames, hiddenTools: [] }
  }
  const visibleSpecs = filterSpecsByScope([...specs], gate)
  // No scope armed ⇒ `filterSpecsByScope` returns the same set ⇒ nothing hidden.
  // Also surface a `null` skill so the renderer omits the section entirely.
  const activeSkill = gate.activeSkillName() ?? null
  if (activeSkill === null || visibleSpecs.length === allNames.length) {
    return { activeSkill, visibleTools: allNames, hiddenTools: [] }
  }
  const visibleSet = new Set(visibleSpecs.map((s) => s.name))
  const visibleTools = allNames.filter((n) => visibleSet.has(n))
  const hiddenTools = allNames.filter((n) => !visibleSet.has(n))
  return { activeSkill, visibleTools, hiddenTools }
}
