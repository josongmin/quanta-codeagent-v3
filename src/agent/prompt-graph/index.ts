/**
 * ADR-0538 — prompt-graph slice barrel (Phase 1).
 *
 * The instruction-graph FOUNDATION + the migrated tool-use-rule atoms. Callers
 * (the `prompt-rules` render path) import `renderAtoms` / `selectAtoms` +
 * `POSTURE_ATOMS` / `VERIFY_ATOMS`; the hellgate imports `verifyRuleGraph` +
 * `reachableToolUseContexts`.
 */

export { POSTURE_ATOMS, TOOL_USE_ATOMS, VERIFY_ATOMS } from "./atoms"
export { reachableToolUseContexts } from "./contexts"
export { matches } from "./matches"
export { renderAtoms, selectAtoms } from "./render"
export type {
  AgentMode,
  AtomMatcher,
  AuthorityLayer,
  CompiledPromptArtifact,
  CompiledPromptSection,
  FacetPredicate,
  GraphViolation,
  InstructionAtom,
  PromptChannel,
  PromptContext,
} from "./types"
export { verifyRuleGraph } from "./verify"
