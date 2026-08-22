import { type AgentConfig, type EffortLevel, parseEffort, resolveAgentMode } from "@/agent"
import { buildSkillSnapshot, type ManagedSkill, type SkillRuntimeAuthority } from "@/skill"
import { env } from "../internal"
import { buildRuleInventory, isRulePillEnabled } from "../rule-indicator"
import type { SkillRow } from "../slash-contract"
import type { StatusBar } from "../status-bar"
import { createStatusPills, type SandboxMode } from "../status-pills"

/** The status-pill sink shape `/skills` + `/reload-skills` push the fresh active
 *  inventory into (WS-G / UUX-2-13). Narrow so this surface never imports the
 *  full pill type. */
type SkillsPillSink = { update: (patch: { activeSkills?: Array<{ name: string }> }) => void }

/** RFC-06 F4 — project the skill runtime authority's MANAGEMENT view into the
 *  CLI display rows. Management RETAINS disabled rows (so `/skills` can show a
 *  "[disabled: reason]" tag and F5 can offer re-enable); `paths:` tags are lifted
 *  from the ACTIVE projection (the full `Skill` objects), so an ENABLED row is
 *  byte-identical to the pre-F4 disk-scan row. Order mirrors the registry (same
 *  order the disk-scan snapshot used), so the two surfaces cannot drift. */
const managementToRows = (view: {
  readonly active: readonly { name: string; paths?: readonly string[] }[]
  readonly management: readonly ManagedSkill[]
}): SkillRow[] => {
  const pathsByName = new Map(view.active.map((s) => [s.name, s.paths] as const))
  return view.management.map((m) => {
    const row: SkillRow = { name: m.name, description: m.description }
    const paths = pathsByName.get(m.name)
    if (paths !== undefined && paths.length > 0)
      (row as { paths?: readonly string[] }).paths = paths
    if (!m.enabled) {
      ;(row as { disabled?: boolean }).disabled = true
      if (m.disableReason !== undefined) {
        ;(row as { disableReason?: string }).disableReason = m.disableReason
      }
    }
    return row
  })
}

/** Best-effort refresh of the skills status pill from a fresh row set. Counts
 *  ONLY enabled rows (a disabled skill is not "active"). A pill failure must
 *  never break the slash (chrome-only). */
const refreshSkillsPill = (pills: SkillsPillSink | undefined, rows: readonly SkillRow[]): void => {
  if (pills === undefined) return
  try {
    pills.update({
      activeSkills: rows.filter((r) => r.disabled !== true).map((r) => ({ name: r.name })),
    })
  } catch {
    // chrome-only
  }
}

/** Fresh disk-scan rows (the one-shot shell path + the no-authority fallback).
 *  RFC03-0 — the SAME canonical snapshot the prompt block + `Skill` tool use, so
 *  the user-visible list cannot drift from the model-visible inventory. */
const scanRows = async (skillsConfig: NonNullable<AgentConfig["skills"]>): Promise<SkillRow[]> => {
  const snapshot = await buildSkillSnapshot(
    skillsConfig.dir !== undefined ? { userDir: skillsConfig.dir } : {},
  )
  return snapshotToRows(snapshot.skills)
}

/** Build the `ctx.skills` callback the slash commands `/skills` and
 *  `/reload-skills` consume — the read projection of the discovered/active set.
 *
 *  RFC-06 F4 — when the REPL surface threaded the session's shared
 *  {@link SkillRuntimeAuthority}, the callback reads that authority's live
 *  MANAGEMENT projection (no independent disk scan): a skill disabled through the
 *  authority immediately shows here as disabled, in lock-step with the prompt,
 *  ToolSearch, invocation and the web readout (the single-authority convergence).
 *  ABSENT (the one-shot `quanta /skills` shell path, which has no live session) ⇒
 *  a fresh disk scan of the SAME canonical snapshot — byte-identical to pre-F4.
 *
 *  WS-G (UUX-2-13) — when the composition root passes the status `pills` sink,
 *  EVERY invocation also pushes the fresh ENABLED inventory into the skills pill,
 *  so `/reload-skills` (and `/skills`) refresh the chrome instead of leaving the
 *  boot snapshot frozen. Absent ⇒ display-only (byte-identical). */
export const buildSkillsCallback = (
  skillsConfig: AgentConfig["skills"] | undefined,
  pills?: SkillsPillSink,
  authority?: SkillRuntimeAuthority,
): (() => Promise<SkillRow[]>) | undefined => {
  if (skillsConfig === undefined) return undefined
  return async (): Promise<SkillRow[]> => {
    const rows =
      authority !== undefined ? managementToRows(authority.read()) : await scanRows(skillsConfig)
    refreshSkillsPill(pills, rows)
    return rows
  }
}

/** RFC-06 F4 — build the `ctx.reloadSkills` callback `/reload-skills` consumes.
 *  When the session authority is present, `/reload-skills` invokes its `sync()`
 *  (re-read the durable disabled set + republish the projections at the persisted
 *  revision — cross-process convergence at a management-read boundary) and
 *  renders the returned revision, NOT an independent disk re-scan. ABSENT ⇒ the
 *  pre-F4 behavior: re-scan disk via {@link buildSkillsCallback}, no revision.
 *  Returns `undefined` when skills are unconfigured (the slash prints "not
 *  wired", byte-identical). */
export const buildSkillsReloadCallback = (
  skillsConfig: AgentConfig["skills"] | undefined,
  pills?: SkillsPillSink,
  authority?: SkillRuntimeAuthority,
): (() => Promise<{ rows: SkillRow[]; revision?: number }>) | undefined => {
  if (skillsConfig === undefined) return undefined
  const scanFallback = buildSkillsCallback(skillsConfig, pills, undefined)
  return async (): Promise<{ rows: SkillRow[]; revision?: number }> => {
    if (authority !== undefined) {
      // RELOAD = re-read the durable source + republish (sync), then project.
      const view = await authority.sync()
      const rows = managementToRows(view)
      refreshSkillsPill(pills, rows)
      return { rows, revision: view.revision }
    }
    return { rows: scanFallback !== undefined ? await scanFallback() : [] }
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
