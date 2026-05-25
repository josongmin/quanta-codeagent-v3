/**
 * Playbook slice barrel (ADR-0203 — user-authored task macros).
 *
 * Slice posture: SELF-CONTAINED. This barrel re-exports types, the parser,
 * the validator, the dispatcher, and the inline-trigger watcher. It does
 * NOT re-export anything from `@/agent`, `@/tool`, or `@/permission`.
 *
 * Default-OFF wire: nothing here is invoked unless a host calls one of the
 * surface functions. A SKILL.md whose frontmatter omits all 0203 slots is
 * byte-identical to the pre-0203 lenient skill — verified by
 * `tests/unit/playbook-frontmatter-hellgate.test.ts:HELL-PB-12`.
 *
 * Consumption order for the host:
 *   1. `parsePlaybookFrontmatter(content)` → `PlaybookFrontmatter`
 *   2. `buildMacroRegistry(fm.macros)` → `MacroRegistry`
 *   3. `expandProcedure(fm.procedure, registry)` once on load (authoring lint)
 *   4. On every proposed tool call: `evaluatePlaybookAction(fm, repr)` —
 *      forward to permission seam.
 *   5. (Optional) `createInlineTriggerWatcher().start({...})` on session
 *      bind, with `.stop()` on session unbind.
 */

export {
  buildMacroRegistry,
  expandProcedure,
  expandStep,
  type MacroRegistry,
  type ProcedureExpansion,
  type StepExpansion,
} from "./dispatcher"
export {
  isPlaybookExtended,
  parsePlaybookFrontmatter,
} from "./frontmatter-parser"
export {
  createInlineTriggerWatcher,
  createMemoryWatcher,
  findMarkerLine,
  type MemoryWatcher,
  matchesGlobSubset,
} from "./inline-trigger-watcher"
export type {
  InlineTriggerCallback,
  InlineTriggerFire,
  InlineTriggerWatcherHandle,
  InlineTriggerWatcherPort,
  InlineTriggerWatchSpec,
  RepoRulesReaderPort,
  RepoRulesView,
} from "./port"
export type {
  ForbiddenActionMatch,
  InlineTriggerConfig,
  MacroDefinition,
  MacroLookupResult,
  PlaybookFrontmatter,
  PlaybookParseResult,
  ValidatorVerdict,
} from "./types"
export { PLAYBOOK_MAX_BYTES, PlaybookParseError } from "./types"
export {
  evaluatePlaybookAction,
  inMemoryRepoRules,
  repoRulesMentions,
} from "./validator"
