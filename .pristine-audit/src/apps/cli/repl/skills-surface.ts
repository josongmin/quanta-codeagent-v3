import { type AgentConfig, type EffortLevel, parseEffort, resolveAgentMode } from "@/agent"
import { buildSkillSnapshot } from "@/skill"
import { env } from "../internal"
import { buildRuleInventory, isRulePillEnabled } from "../rule-indicator"
import type { SkillRow } from "../slash-contract"
import type { StatusBar } from "../status-bar"
import { createStatusPills, type SandboxMode } from "../status-pills"

/** Build the `ctx.skills` callback the slash commands `/skills` and
 *  `/reload-skills` consume. Returns the freshly-discovered set as
 *  `{name, description, paths?}` rows — mirrors what `buildSessionFeatures`
 *  feeds the model, so the user-visible list and the model-visible inventory
 *  cannot drift. Surface-only: no LLM call, just disk scan + bundled merge.
 *
 *  WS-G (UUX-2-13) — when the composition root passes the status `pills`
 *  sink, EVERY invocation also pushes the fresh inventory into the skills
 *  pill, so `/reload-skills` (and `/skills`) refresh the chrome instead of
 *  leaving the boot snapshot frozen. Absent ⇒ display-only (byte-identical
 *  for surfaces without pills). */
export const buildSkillsCallback = (
  skillsConfig: AgentConfig["skills"] | undefined,
  pills?: { update: (patch: { activeSkills?: Array<{ name: string }> }) => void },
): (() => Promise<SkillRow[]>) | undefined => {
  if (skillsConfig === undefined) return undefined
  return async (): Promise<SkillRow[]> => {
    // RFC03-0 — same canonical snapshot the prompt block + `Skill` tool use, so
    // the user-visible `/skills` list cannot drift from the model-visible
    // inventory (single discovery+precedence authority; no CLI-local merge).
    const snapshot = await buildSkillSnapshot(
      skillsConfig.dir !== undefined ? { userDir: skillsConfig.dir } : {},
    )
    const rows = snapshotToRows(snapshot.skills)
    // WS-G (UUX-2-13) — best-effort pill refresh; a pill failure must never
    // break the slash.
    if (pills !== undefined) {
      try {
        pills.update({ activeSkills: rows.map((row) => ({ name: row.name })) })
      } catch {
        // chrome-only
      }
    }
    return rows
  }
}

/** Project the canonical precedence-resolved snapshot into display rows. The
 *  snapshot is already deduplicated (registry precedence) and sorted by name,
 *  so this is a pure projection — NO CLI-local merge/precedence (RFC03-0). */
const snapshotToRows = (
  skills: ReadonlyArray<{ name: string; description: string; paths?: readonly string[] }>,
): SkillRow[] =>
  skills.map((skill) => {
    const row: SkillRow = { name: skill.name, description: skill.description }
    if (skill.paths !== undefined) (row as { paths?: readonly string[] }).paths = skill.paths
    return row
  })

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
