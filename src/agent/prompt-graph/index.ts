/**
 * ADR-0538 — prompt-graph slice barrel (Phase 1 + Phase 2).
 *
 * The instruction-graph FOUNDATION + the migrated tool-use-rule atoms (Phase 1)
 * + the migrated flat-body atoms and mode/session-notice atoms (Phase 2).
 * Callers (the `prompt-rules` render path + `prompt.ts`) import `renderAtoms` /
 * `selectAtoms` + the atom sets; the hellgate imports `verifyRuleGraph` +
 * `reachableToolUseContexts` / `reachableBodyContexts`.
 */

export { POSTURE_ATOMS, TOOL_USE_ATOMS, VERIFY_ATOMS } from "./atoms"
export {
  BODY_AFTER_PERSONA_ATOMS,
  BODY_AFTER_PROMPT_PACK_ATOMS,
  BODY_ATOMS,
} from "./atoms-body"
export {
  BRIEF_NOTICE_ATOM_EXPORT,
  MODE_NOTICE_ATOMS,
  NOTICE_ATOMS,
  renderNoticeAtom,
} from "./atoms-notices"
export { reachableBodyContexts, reachableToolUseContexts } from "./contexts"
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
