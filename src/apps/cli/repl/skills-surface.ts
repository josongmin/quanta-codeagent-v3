import { type AgentConfig, type EffortLevel, parseEffort, resolveAgentMode } from "@/agent"
import { discoverSkills, discoverSystemSkills } from "@/skill"
import { env } from "../internal"
import { buildRuleInventory, isRulePillEnabled } from "../rule-indicator"
import type { SkillRow } from "../slash-contract"
import type { StatusBar } from "../status-bar"
import { createStatusPills, type SandboxMode } from "../status-pills"

/** Build the `ctx.skills` callback the slash commands `/skills` and
 *  `/reload-skills` consume. Returns the freshly-discovered set as
 *  `{name, description, paths?}` rows — mirrors what `buildSessionFeatures`
 *  feeds the model, so the user-visible list and the model-visible inventory
 *  cannot drift. Surface-only: no LLM call, just disk scan + bundled merge. */
export const buildSkillsCallback = (
  skillsConfig: AgentConfig["skills"] | undefined,
): (() => Promise<SkillRow[]>) | undefined => {
  if (skillsConfig === undefined) return undefined
  return async (): Promise<SkillRow[]> => {
    const userSkills = skillsConfig.dir !== undefined ? await discoverSkills(skillsConfig.dir) : []
    const systemSkills = await discoverSystemSkills()
    const byName = new Map<string, SkillRow>()
    for (const skill of userSkills) {
      const row: SkillRow = { name: skill.name, description: skill.description }
      if (skill.paths !== undefined) (row as { paths?: readonly string[] }).paths = skill.paths
      byName.set(skill.name, row)
    }
    for (const skill of systemSkills) {
      const row: SkillRow = { name: skill.name, description: skill.description }
      if (skill.paths !== undefined) (row as { paths?: readonly string[] }).paths = skill.paths
      byName.set(skill.name, row)
    }
    return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }
}

/** Build and wire the status chrome (workspace / mode+effort / skills /
 *  sandbox). This keeps pill-specific discovery and env policy out of the
 *  top-level REPL orchestrator. */
export const installPills = (deps: {
  statusBar: StatusBar
  cwd: string
  planMode: boolean
  skillsConfig: AgentConfig["skills"] | undefined
}): ReturnType<typeof createStatusPills> => {
  const initialAgentMode = resolveAgentMode(undefined, deps.planMode)
  const initialEffort: EffortLevel | undefined = parseEffort(env("QUANTA_EFFORT", ""))
  const initialSandbox: SandboxMode = (env("QUANTA_SANDBOX", "default") as SandboxMode) ?? "default"
  const pills = createStatusPills({
    statusBar: deps.statusBar,
    initial: {
      cwd: deps.cwd,
      mode: initialAgentMode,
      ...(initialEffort !== undefined ? { effort: initialEffort } : {}),
      sandboxMode: initialSandbox,
    },
  })
  const skillsCbForPills = buildSkillsCallback(deps.skillsConfig)
  if (skillsCbForPills !== undefined) {
    void skillsCbForPills()
      .then((rows) => pills.update({ activeSkills: rows.map((row) => ({ name: row.name })) }))
      .catch(() => undefined)
  }
  if (isRulePillEnabled()) {
    void buildRuleInventory({ cwd: deps.cwd })
      .then((inventory) => {
        if (inventory.totalCount > 0) {
          pills.update({
            rules: {
              activeCount: inventory.activeCount,
              totalCount: inventory.totalCount,
            },
          })
        }
      })
      .catch(() => undefined)
  }
  return pills
}
