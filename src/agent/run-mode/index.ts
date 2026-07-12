/**
 * Run-mode slice barrel (RFC may-22-unified-agent-runtime / Phase 0).
 *
 * Pure type slice + propositional helpers. Imports allowed:
 *   - `@/shared` (logger only)
 *   - `@/agent/budget` (sibling slice for dial/cap types)
 * No imports from `@/apps`, `@/llm`, `@/tool`.
 */

export { clampDials } from "./clamp"
export { assertModeMatrix, narrowMode } from "./narrow"
export { BUDGET_PRESETS, MODE_PRESETS } from "./presets"
export { MODE_REPO_RULES_POLICY, modeLoadsRepoRules } from "./repo-rules-policy"
export {
  type AgentMode,
  ALL_AGENT_MODES,
  type ExternalDepsLever,
  type GitWriteLever,
  LEVER_FIELDS,
  type LeverField,
  type MemoryLever,
  type ModePolicy,
  type NetworkLever,
  type ObservationLever,
  type OutputLever,
  type PermissionLever,
  type PromptPackLever,
  type SandboxLever,
  type SecretsLever,
  type TerminationLever,
  type ToolSurfaceLever,
} from "./types"
