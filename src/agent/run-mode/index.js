/**
 * Run-mode slice barrel (RFC may-22-unified-agent-runtime / Phase 0).
 *
 * Pure type slice + propositional helpers. Imports allowed:
 *   - `@/shared` (logger only)
 *   - `@/agent/budget` (sibling slice for dial/cap types)
 * No imports from `@/apps`, `@/llm`, `@/tool`.
 */
export { clampDials } from "./clamp";
export { assertModeMatrix, narrowMode } from "./narrow";
export { BUDGET_PRESETS, MODE_PRESETS } from "./presets";
export { ALL_AGENT_MODES, LEVER_FIELDS, } from "./types";
