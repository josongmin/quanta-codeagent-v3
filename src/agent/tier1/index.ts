/**
 * Tier-1 per-subsystem builder barrel.
 *
 * Each module here exposes ONE pure builder that turns an optional config
 * block into a concrete runtime object (or `undefined` when the block is
 * absent, preserving byte-identical default-OFF behavior). The
 * `features.ts` composer calls each in sequence and accumulates results into
 * the `SessionFeatures` shape the loop consumes.
 *
 * Edge direction is strictly ONE-WAY: `features.ts` imports from `tier1/*`;
 * `tier1/*` MUST NOT import from `features.ts`. This keeps the import-cycle
 * guard (tests/unit/agent-import-cycle.test.ts) simple — `tier1/*` lives in
 * a subdirectory so it is invisible to the top-level SCC analysis, and the
 * one-way edge means no new cycle is introduced.
 */

export {
  type AdvisorConsultFromLLMOptions,
  advisorConsultFromLLM,
  buildAdvisorBlock,
} from "./advisor"
export { type AppshotBlock, buildAppshotBlock } from "./appshot"
export { buildClassifierBlock } from "./auto-classifier"
export { buildBranchSearchBlock } from "./branch-search"
export { buildBrowserBlock } from "./browser"
export { buildBudgetBlock } from "./budget"
export {
  buildCheckSecretsBlock,
  CHECK_SECRETS_ENABLED_VALUE,
  CHECK_SECRETS_ENV_FLAG,
  type CheckSecretsEnvReader,
  checkSecretsToolEnabled,
} from "./check-secrets"
export { buildComposeAuthoringBlock } from "./compose-authoring"
export { buildDelegateBlock } from "./delegate"
export { buildForkSessionBlock } from "./fork-session"
export { buildObjectiveBlock } from "./objective"
export { buildPlanExitBlock } from "./plan-exit"
export { buildPlanMutationBlock } from "./plan-mutation"
export { buildPrShipBlock } from "./pr-ship"
export { buildPromptCacheBlock } from "./prompt-cache"
export { buildShadowBlock } from "./shadow"
export { buildShadowVerifyBlock } from "./shadow-verify"
export { buildSideAgentBlock } from "./side-agent"
export { buildSkillBlock, type SkillBlock } from "./skill"
export { buildSubagentBlock, type SubagentBlock } from "./subagent"
export { buildSubagentBatchBlock } from "./subagent-batch"
export { buildSubagentBgBlock } from "./subagent-bg"
export { buildSubagentIntrospectBlock } from "./subagent-introspect"
export { buildSubagentMailboxBlock } from "./subagent-mailbox"
export { buildTeamBlock } from "./team"
export { buildUserInputBlock } from "./user-input"
export { buildWebSearchBlock } from "./web-search"
export { buildWorkingStateBlock, type WorkingStateBlock } from "./working-state"
