import type { AgentConfig } from "@/agent"

/**
 * Surface-agnostic skill-config assembly (Tier 1 capability, ADR-0011 +
 * ADR-0045 system-skills follow-up). Three states:
 *   - `dir` set                → `{ dir }`  user dir + bundled system skills
 *   - `dir` unset + `enabled`  → `{}`       bundled system skills ONLY
 *   - neither                  → `undefined` byte-identical default-OFF
 *
 * A user dir wins over the bare flag (it's a superset — it also pulls system
 * skills in via `buildSkillFeatures`'s merge).
 */

export interface SkillsConfigAssembleInput {
  /** `QUANTA_SKILLS_DIR` — when set, returns `{ dir }`. */
  dir?: string | undefined
  /** Equivalent of `QUANTA_SKILLS=1 || --skills` — when true without a dir,
   *  enables bundled system skills only. */
  enabled?: boolean
}

export const buildSkillsConfigCore = (
  input: SkillsConfigAssembleInput,
): AgentConfig["skills"] | undefined => {
  if (input.dir !== undefined && input.dir !== "") return { dir: input.dir }
  if (input.enabled === true) return {}
  return undefined
}
