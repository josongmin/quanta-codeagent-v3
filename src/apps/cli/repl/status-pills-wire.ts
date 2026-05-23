import { type AgentConfig, type EffortLevel, parseEffort, resolveAgentMode } from "@/agent"
import { env } from "../internal"
import type { StatusBar } from "../status-bar"
import { createStatusPills, type SandboxMode } from "../status-pills"
import { buildSkillsCallback } from "./skills-callback"

/** Build and wire the 4-pill status chrome (workspace / mode+effort / skills /
 *  sandbox). Extracted from {@link runRepl} so that the per-pill resolution
 *  logic (planMode→AgentMode, QUANTA_EFFORT, QUANTA_SANDBOX, async skill
 *  discovery) does not push `runRepl` past the biome cognitive-complexity
 *  budget. Returns the live {@link StatusPills} handle; caller owns dispose.
 *
 *  Default-ON contract: when the underlying TTY is absent, `createStatusPills`
 *  itself returns a no-op composer (render="" / update=no-op) so callers can
 *  always call `pills.update(...)` without a TTY check. */
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
  // Active-skill inventory — populated opportunistically using the same
  // discover seam the slash commands use. No skillsConfig ⇒ pill render
  // skips the slot (composer drops empty/undefined fields).
  const skillsCbForPills = buildSkillsCallback(deps.skillsConfig)
  if (skillsCbForPills !== undefined) {
    void skillsCbForPills()
      .then((rows) => pills.update({ activeSkills: rows.map((r) => ({ name: r.name })) }))
      .catch(() => undefined) // best-effort; pills stay empty on discover error
  }
  return pills
}
