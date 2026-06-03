/**
 * skill-mcp-deps — resolver (ADR-0476).
 *
 * Given the ACTIVE skills (each carrying its raw `dependencies` block), fold
 * their declared MCP deps into a deduped {@link McpServerSpec}[] the harness
 * should attach. The DEFAULT-OFF gate is enforced FIRST: when
 * `QUANTA_SKILL_MCP_DEPS` is not exactly "1", we return `[]` BEFORE inspecting
 * any skill — byte-identical to today (no resolution, no attach).
 *
 * Dedupe: by {@link depIdentity} (stdio ⇒ service name; HTTP ⇒
 * transport+service+url). The FIRST declaration wins; later duplicates across
 * skills are dropped so a server is NEVER attached twice. Order is the order
 * each unique server was first seen (deterministic for tests).
 *
 * NO-THROW; pure. Slices imported: `@/shared` (via parser) + local types.
 */

import { parseSkillMcpDeps } from "./parser"
import {
  type ActiveSkillDeps,
  depIdentity,
  type McpServerSpec,
  type SkillMcpDep,
  type SkillMcpDepsEnv,
  skillMcpDepsEnabled,
} from "./types"

/** Map a validated dep onto the launcher-agnostic spec (1:1 today; kept as a
 *  function so a future transport-specific transform has one home). */
const toSpec = (dep: SkillMcpDep): McpServerSpec => ({
  serviceName: dep.serviceName,
  transport: dep.transport,
  ...(dep.command !== undefined ? { command: dep.command } : {}),
  ...(dep.args !== undefined ? { args: dep.args } : {}),
  ...(dep.url !== undefined ? { url: dep.url } : {}),
})

/**
 * Resolve the deduped set of MCP servers to attach for the given active
 * skills. Malformed deps are silently dropped here (the per-skill
 * {@link parseSkillMcpDeps} surfaces them for diagnostics; the resolver's job
 * is the attach set, which never includes a malformed dep).
 *
 * Gate OFF (or no active skills) ⇒ `[]`.
 */
export const resolveMcpDeps = (
  activeSkills: readonly ActiveSkillDeps[],
  env: SkillMcpDepsEnv,
): readonly McpServerSpec[] => {
  // DEFAULT-OFF: short-circuit before touching any skill.
  if (!skillMcpDepsEnabled(env)) return []

  const seen = new Set<string>()
  const out: McpServerSpec[] = []
  for (const skill of activeSkills) {
    const { deps } = parseSkillMcpDeps(skill.rawDependencies)
    for (const dep of deps) {
      const id = depIdentity(dep)
      if (seen.has(id)) continue
      seen.add(id)
      out.push(toSpec(dep))
    }
  }
  return out
}
