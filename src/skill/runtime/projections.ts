/**
 * RFC-06 F1 — the ONE registry/policy/disabled → three-projection deriver.
 *
 * A single pure function turns the authority's inputs (the precedence-resolved
 * registry, the loaded admin policy, and the user-disabled name set) into the
 * `active` / `searchable` / `management` triple. Because all three come from this
 * one call, they can never diverge: a name effectively disabled for a reason is
 * absent from BOTH `active` and `searchable`, and present in `management` with
 * that reason. Consumers therefore never filter independently (the DROP'd
 * frozen-map-per-consumer pattern that leaked disabled skills into ToolSearch /
 * the web readout — RFC-06 Correction 1).
 *
 * Policy is keyed by CANONICAL NAME, never by `winnerScope` (RFC-06 R6 normative
 * + F1 stop rule): admin `bannedSkills` disables a name (reason `administrator`);
 * admin `requiredSkills` PINS a name enabled so a user-disable can never hide it
 * (admin supreme). The name-keyed policy aggregators (`requiredAdminSkillNames` /
 * `bannedSkillNames`) are reused verbatim — no winnerScope substitution.
 */

import type { AdminPolicy } from "../admin-policy"
import { bannedSkillNames, requiredAdminSkillNames } from "../install-enforcement"
import type { SkillRegistry } from "../registry"
import type { ManagedSkill, SkillDisableReason, SkillRuntimeView } from "./types"

/** The effective-disable decision for ONE skill name, keyed by canonical name. */
export interface EffectiveDisable {
  readonly disabled: boolean
  /** Present iff `disabled`. `administrator` (admin ban) outranks `user`. */
  readonly reason?: SkillDisableReason | undefined
}

/**
 * Decide whether a canonical name is effectively disabled, by NAME:
 *   - admin `bannedSkills` ⇒ disabled, reason `administrator` (supreme);
 *   - else a name in the user-disabled set ⇒ disabled, reason `user`, UNLESS it
 *     is admin-`requiredSkills` (required PINS it enabled — a user disable can
 *     never hide an admin-required skill, defense-in-depth over the authority's
 *     setEnabled refusal);
 *   - else enabled.
 */
export const effectiveDisable = (
  name: string,
  policy: AdminPolicy | null,
  disabledNames: ReadonlySet<string>,
): EffectiveDisable => {
  if (bannedSkillNames(policy).includes(name)) {
    return { disabled: true, reason: "administrator" }
  }
  const required = requiredAdminSkillNames(policy).includes(name)
  if (disabledNames.has(name) && !required) {
    return { disabled: true, reason: "user" }
  }
  return { disabled: false }
}

/**
 * Derive the atomic projection triple at `revision` from one registry + policy +
 * disabled set. `active`/`searchable` exclude effectively-disabled winners;
 * `management` retains EVERY winner with its enabled flag and effective reason.
 */
export const deriveSkillProjections = (
  registry: SkillRegistry,
  policy: AdminPolicy | null,
  disabledNames: ReadonlySet<string>,
  revision: number,
): SkillRuntimeView => {
  const management: ManagedSkill[] = []
  const searchable = registry.entries.filter(
    (e) => !effectiveDisable(e.skill.name, policy, disabledNames).disabled,
  )
  const active = searchable.map((e) => e.skill)
  for (const e of registry.entries) {
    const eff = effectiveDisable(e.skill.name, policy, disabledNames)
    management.push({
      name: e.skill.name,
      scope: e.winnerScope,
      description: e.skill.description,
      ...(e.skill.installState !== undefined ? { installState: e.skill.installState } : {}),
      enabled: !eff.disabled,
      ...(eff.disabled && eff.reason !== undefined ? { disableReason: eff.reason } : {}),
    })
  }
  return { revision, active, searchable, management }
}
