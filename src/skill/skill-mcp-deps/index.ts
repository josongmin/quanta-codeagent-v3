/**
 * skill-mcp-deps — public barrel (ADR-0476).
 *
 * Skill→MCP dependency declaration + resolution. A skill declares the MCP
 * servers it needs (frontmatter `dependencies.tools[]`); when the skill is
 * active and the gate is ON, the harness auto-attaches the deduped set via the
 * injected {@link AttachMcpPort}.
 *
 * Composition root usage:
 *   1. parseSkillMcpDeps(skill.rawDependencies) — validate per skill (diags).
 *   2. resolveMcpDeps(activeSkills, env) — deduped attach set (gate-aware).
 *   3. attachPort.attach(specs) — wired to @/agent/plugin-mcp-launcher.
 *
 * NO-THROW; DEFAULT-OFF (QUANTA_SKILL_MCP_DEPS).
 */

export { parseSkillMcpDeps } from "./parser"
export { resolveMcpDeps } from "./resolve"
export {
  type ActiveSkillDeps,
  type AttachMcpPort,
  depIdentity,
  HTTP_DEP_TRANSPORTS,
  MCP_DEP_TRANSPORTS,
  type McpAttachOutcome,
  type McpDepError,
  type McpDepTransport,
  type McpServerSpec,
  SKILL_MCP_DEPS_FLAG,
  type SkillMcpDep,
  type SkillMcpDepsEnv,
  type SkillMcpDepsResult,
  skillMcpDepsEnabled,
} from "./types"
