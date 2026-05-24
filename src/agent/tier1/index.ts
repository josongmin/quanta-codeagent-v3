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

export { buildClassifierBlock } from "./auto-classifier"
export { buildBranchSearchBlock } from "./branch-search"
export { buildPlanExitBlock } from "./plan-exit"
export { buildPlanMutationBlock } from "./plan-mutation"
export { buildShadowBlock } from "./shadow"
export { buildSkillBlock, type SkillBlock } from "./skill"
export { buildSubagentBlock, type SubagentBlock } from "./subagent"
export { buildUserInputBlock } from "./user-input"
export { buildWebSearchBlock } from "./web-search"
export { buildWorkingStateBlock, type WorkingStateBlock } from "./working-state"
