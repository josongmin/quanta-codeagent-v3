import type { AgentConfig } from "@/agent"
import { discoverSkills, discoverSystemSkills } from "@/skill"
import type { SkillRow } from "../slash-commands"

/** Build the `ctx.skills` callback the slash commands `/skills` and
 *  `/reload-skills` consume. Returns the freshly-discovered set as
 *  `{name, description, paths?}` rows — mirrors what `buildSessionFeatures`
 *  feeds the model, so the user-visible list and the model-visible inventory
 *  cannot drift. Surface-only: no LLM call, just disk scan + bundled merge.
 *  Absent skills config ⇒ `undefined` so the slash commands print "not wired".
 *
 *  NOTE: our loop already re-runs `discoverSkills` per `runAgent` call (i.e.
 *  per user turn), so newly-added SKILL.md files reach the model on the next
 *  prompt automatically. These slash commands exist for USER VISIBILITY —
 *  confirming the disk state BEFORE submitting the next prompt. */
export const buildSkillsCallback = (
  skillsConfig: AgentConfig["skills"] | undefined,
): (() => Promise<SkillRow[]>) | undefined => {
  if (skillsConfig === undefined) return undefined
  return async (): Promise<SkillRow[]> => {
    const userSkills = skillsConfig.dir !== undefined ? await discoverSkills(skillsConfig.dir) : []
    const systemSkills = await discoverSystemSkills()
    // Same precedence as buildSessionFeatures: system wins on name collision.
    const byName = new Map<string, SkillRow>()
    for (const s of userSkills) {
      const row: SkillRow = { name: s.name, description: s.description }
      if (s.paths !== undefined) (row as { paths?: readonly string[] }).paths = s.paths
      byName.set(s.name, row)
    }
    for (const s of systemSkills) {
      const row: SkillRow = { name: s.name, description: s.description }
      if (s.paths !== undefined) (row as { paths?: readonly string[] }).paths = s.paths
      byName.set(s.name, row)
    }
    return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }
}
