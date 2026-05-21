/**
 * Bundled (system) skills — Cluster E follow-up to ADR-0040.
 *
 * A small, deliberate set of SSOT-shipped SKILL.md files that live alongside
 * the framework code instead of in a user-configured `QUANTA_SKILLS_DIR`. The
 * canonical use case: factual audits ("진행률" / "code-only" — see
 * `progress-audit/SKILL.md` + ADR-0045) where the model must follow strict
 * evidence-and-verification discipline regardless of which host wired the
 * session.
 *
 * Why bundled (not user-config):
 *  - Discipline skills must not depend on the user remembering to set
 *    `QUANTA_SKILLS_DIR`. The progress-audit skill is the prime example —
 *    skipping it silently degrades audit honesty.
 *  - System skills ship with the binary, so their `tools:` allowlist + body
 *    are version-pinned to the framework release. A user-supplied skill
 *    cannot impersonate them.
 *
 * Layout (ADR-0040, mirrored here):
 *
 *   src/skill/system-skills/
 *     <name>/SKILL.md
 *
 * Slice contract: this module lives under `src/skill/**` and is allowed to
 * import only from `./` and `../`. It uses {@link discoverSkills} so the
 * lenient frontmatter parser remains the SSOT for runtime field extraction
 * (`tools:` → `Skill.tools` → `skillToolAllowlist` → host enforcement).
 * The strict 6-field parser in `../skill-frontmatter.ts` is the SSOT for
 * authoring shape (`userInvocable` / `allowedTools` / `category` /
 * `stability`); system SKILL.md files include both the strict-shape metadata
 * AND the lenient `tools:` mirror so the existing host enforcement path
 * activates without rewiring.
 */

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { discoverSkills } from "../discover"
import type { Skill } from "../types"

/** Absolute path to the bundled `system-skills/` directory. Resolved from
 *  this module's location so the layout works under both `bun run` (source
 *  tree) and the future `bun build --compile` bundle (the SKILL.md files
 *  must be shipped alongside the binary; see ADR-0045 §한계). */
export const systemSkillsDir = (): string => {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here)
}

/**
 * Discover all bundled system skills. Returns the same {@link Skill} shape as
 * {@link discoverSkills} so a host can merge it into the user-discovered set
 * trivially. Missing dir ⇒ `[]` (delegates to discoverSkills's contract).
 *
 * Host usage (suggested wiring, NOT applied here — see ADR-0045 §wiring):
 *
 *   const userSkills = config.skills ? await discoverSkills(config.skills.dir) : []
 *   const systemSkills = await discoverSystemSkills()
 *   // System skills win on name collision so user-config cannot impersonate
 *   // them (e.g. shadow `progress-audit` with a weaker version).
 *   const byName = new Map<string, Skill>()
 *   for (const s of userSkills) byName.set(s.name, s)
 *   for (const s of systemSkills) byName.set(s.name, s)
 *   const merged = [...byName.values()]
 */
export const discoverSystemSkills = async (): Promise<Skill[]> => discoverSkills(systemSkillsDir())

export type { ProgressAuditTrigger } from "./progress-audit"
// Per-skill wiring seams. Re-exported here so external callers (a slash-
// router, a planner UI, ADR-0045 §wiring) import from
// `@/skill/system-skills` without reaching into the per-skill directory.
export {
  findProgressAuditSkill,
  PROGRESS_AUDIT_SKILL_NAME,
  triggerProgressAudit,
} from "./progress-audit"
