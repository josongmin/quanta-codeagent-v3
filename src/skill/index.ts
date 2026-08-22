/**
 * Skill slice (T1.C) — faithful-minimal port of Claude Code v2's skill system.
 *
 * Self-contained: this slice MUST NOT import @/agent. Public seams:
 *   - {@link Skill} / {@link ParsedFrontmatter} / {@link SkillEffort}  (types)
 *   - {@link parseFrontmatter}      dependency-free YAML-ish parser
 *   - {@link discoverSkills}        scan <dir>/&#42;/SKILL.md (+ <dir>/&#42;.md)
 *   - {@link createSkillTool}       the `Skill` tool (body + advisory note)
 *   - {@link createToolSearchTool}  the `ToolSearch` tool (lexical catalog search)
 *   - {@link skillToolAllowlist}    enforcement seam: a skill's declared tool allowlist
 *   - {@link skillModelOverride}    read seam: a skill's declared `model:` override (advisory)
 *   - {@link skillEffortOverride}   read seam: a skill's declared `effort:` override (advisory)
 *   - {@link skillsActivatedFor}    host-callable conditional-`paths:` helper
 *
 * What this slice does and does NOT do (honest seam, not a silent no-op):
 *
 *   - It DISCOVERS skills and exposes the `Skill` / `ToolSearch` tools. That
 *     part fully works once a host registers the tools.
 *   - It does NOT enforce a skill's `tools`/`model`/`effort` scope, and it does
 *     NOT auto-activate `paths:` skills. Those are turn-loop concerns this
 *     slice intentionally does not own.
 *
 * To make scoping/activation real, a host must do this itself (this slice does
 * none of it automatically):
 *
 *   1. At session start: `const skills = await discoverSkills(dir)`, then
 *      register `createSkillTool(skills)` and
 *      `createToolSearchTool(() => registry.specs())`.
 *   2. To enforce a skill's tool sandbox when it is activated: read
 *      `skillToolAllowlist(skill)` and intersect it with the turn's permitted
 *      tools (and apply `skill.model` / `skill.effort` if desired). Nothing
 *      here applies these for you.
 *   3. For conditional `paths:` skills: after file changes, call
 *      `skillsActivatedFor(skills, changedPaths)` and act on the result.
 *      Declaring `paths:` has no runtime effect until a host does this.
 */
export {
  implicitlyInvocableSkills,
  MAX_GLOB_LEN,
  MAX_PATH_LEN,
  matchesAnyGlob,
  skillsActivatedFor,
} from "./activation"
export type { AdminPolicy, AdminPolicyReader, LoadedAdminPolicy } from "./admin-policy"
// ADR-0134 Phase C — admin policy + audit log + install enforcement.
export {
  AdminPolicySchema,
  loadAdminPolicy,
  parseAdminPolicy,
  validateAdminPolicy,
} from "./admin-policy"
// P1 cleanup — adapter for the fs port. `admin-policy.ts` lazy-imports the
// default reader so hosts that want a custom (e.g. in-memory) reader can
// substitute one without touching the domain module.
export {
  createFsAdminPolicyReader,
  defaultAdminPolicyReader,
} from "./admin-policy-loader-fs"
export type {
  AuditClock,
  AuditEntry,
  AuditEvent,
  AuditWriter,
  MemoryAuditWriter,
} from "./audit-log"
export {
  appendAuditEntry,
  auditLogPathFor,
  buildAuditEntry,
  memoryAuditWriter,
  nodeAuditWriter,
  resetAuditSeqForTesting,
  systemAuditClock,
} from "./audit-log"
export { discoverSkills } from "./discover"
export { parseFrontmatter } from "./frontmatter"
export type { InstallAttempt, InstallDecision } from "./install-enforcement"
export {
  bannedSkillNames,
  decideInstall,
  requiredAdminSkillNames,
} from "./install-enforcement"
export type {
  MigrationEntry,
  MigrationFs,
  MigrationOptions,
  MigrationReport,
  SkillMigrationStagePort,
} from "./migration"
// ADR-0134 Phase D — pre-0134 ~/.claude/skills/ migration helper.
export { migrateClaudeSkillsToQuanta, nodeMigrationFs } from "./migration"
// RFC03-2/3 — immutable evidence→proposal compiler + content-addressed staging
// + approval-bound CAS promotion. NO live-dir writer (skill_create cutover).
export { compileSkillProposal, type ProposalIo } from "./proposal/compiler"
export type {
  PromoteResult,
  SkillProposalArtifactPort,
  SkillProposalStagePort,
  SkillProposalStageResult,
  StagedArtifact,
} from "./proposal/port"
export {
  createSkillProposalArtifactPort,
  type PromoteStorageIo,
  type StagingStore,
} from "./proposal/promote"
export {
  ABSENT_PREIMAGE,
  type CompileResult,
  type SkillEvidenceAnchor,
  type SkillProposal,
  type SkillProposalDraftInput,
  type SkillProposalError,
  type SkillProposalKind,
  type SkillProposalValidationReceipt,
} from "./proposal/types"
export type {
  SkillRegistry,
  SkillRegistryCollision,
  SkillRegistryEntry,
  SkillRegistryOptions,
  SkillSource,
  SkillSourceInputs,
} from "./registry"
export {
  buildSkillRegistry,
  buildSkillSnapshot,
  defaultSkillSources,
  type SkillSnapshot,
  type SkillSnapshotInputs,
} from "./registry"
// RFC-06 F1 — live skill runtime authority (registry + admin policy + durable
// user-disabled set + unified revision; active/searchable/management projections;
// CAS setEnabled; versioned fail-closed disabled-set store behind a port).
export {
  createInMemoryDisabledStore,
  createJsonDisabledStore,
  createSkillRuntimeAuthority,
  DISABLED_SET_SCHEMA_VERSION,
  type DisabledStoreFs,
  type DisabledStorePort,
  decodeDisabledSet,
  deriveSkillProjections,
  type EffectiveDisable,
  effectiveDisable,
  emptyDisabledSet,
  type ManagedSkill,
  nodeDisabledStoreFs,
  type PersistedDisabledSet,
  SKILL_DISABLE_REASONS,
  type SkillDisableReason,
  type SkillRuntimeAuthority,
  type SkillRuntimeAuthorityDeps,
  type SkillRuntimeView,
  type SkillSetEnabledRejection,
  type SkillSetEnabledResult,
} from "./runtime"
// jun-6 — agent-callable skill-authoring tool (scaffold + validate + install).
export {
  createSkillCreatorTool,
  renderSkillMarkdown,
  type SkillCreatorDeps,
  validateScaffold,
} from "./skill-creator"
// ADR-0457 — codex skill ECOSYSTEM bundled resources (agents/openai.yaml +
// scripts/references/assets presence).
export {
  discoverSkillImplicitPolicy,
  discoverSkillResources,
  parseOpenaiYamlInterface,
  parseOpenaiYamlPolicy,
  SKILL_RESOURCE_DIRS,
} from "./skill-resources"
export {
  createSkillTool,
  scopingNote,
  // ADR-0457 — listing row that surfaces argumentHint + shortDescription.
  skillCatalogueRow,
  skillEffortOverride,
  skillModelOverride,
  skillToolAllowlist,
} from "./skill-tool"
export {
  // ADR-0134 engineering-task skills cluster (debug-error / add-tests /
  // explain-code / extract-function). Alphabetical with CTK siblings below.
  ADD_TESTS_SKILL_NAME,
  type AddTestsTrigger,
  // CTK git skills cluster (ADR-0102 absorption batch — Track 3 router).
  BABYSIT_SKILL_NAME,
  type BabysitTrigger,
  // Debug/blame skills trio (ADR-0176 sibling to git-log-search ADR-0173).
  BLAME_SECTION_SKILL_NAME,
  type BlameSectionTrigger,
  DEBUG_ERROR_SKILL_NAME,
  DEBUG_TRACE_SKILL_NAME,
  type DebugErrorTrigger,
  type DebugTraceTrigger,
  discoverSystemSkills,
  EXPLAIN_CODE_SKILL_NAME,
  EXPLAIN_STACK_TRACE_SKILL_NAME,
  EXTRACT_FUNCTION_SKILL_NAME,
  type ExplainCodeTrigger,
  type ExplainStackTraceTrigger,
  type ExtractFunctionTrigger,
  FIX_MERGE_CONFLICTS_SKILL_NAME,
  type FixMergeConflictsTrigger,
  findAddTestsSkill,
  findBabysitSkill,
  findBlameSectionSkill,
  findDebugErrorSkill,
  findDebugTraceSkill,
  findExplainCodeSkill,
  findExplainStackTraceSkill,
  findExtractFunctionSkill,
  findFixMergeConflictsSkill,
  findGetPrCommentsSkill,
  findGitLogSearchSkill,
  findLocalizeFaultSkill,
  findLoopOnCiSkill,
  findMakePrEasyToReviewSkill,
  findNewBranchAndPrSkill,
  findProgressAuditSkill,
  findPrReviewCanvasSkill,
  findReviewAndShipSkill,
  findRewindSkill,
  GET_PR_COMMENTS_SKILL_NAME,
  type GetPrCommentsTrigger,
  GIT_LOG_SEARCH_SKILL_NAME,
  type GitLogSearchTrigger,
  LOCALIZE_FAULT_SKILL_NAME,
  LOOP_ON_CI_SKILL_NAME,
  type LocalizeFaultTrigger,
  type LoopOnCiTrigger,
  MAKE_PR_EASY_TO_REVIEW_SKILL_NAME,
  type MakePrEasyToReviewTrigger,
  NEW_BRANCH_AND_PR_SKILL_NAME,
  type NewBranchAndPrTrigger,
  PR_REVIEW_CANVAS_SKILL_NAME,
  PROGRESS_AUDIT_SKILL_NAME,
  type ProgressAuditTrigger,
  type PrReviewCanvasTrigger,
  REVIEW_AND_SHIP_SKILL_NAME,
  REWIND_SKILL_NAME,
  type ReviewAndShipTrigger,
  type RewindTrigger,
  systemSkillsDir,
  triggerAddTests,
  triggerBabysit,
  triggerBlameSection,
  triggerDebugError,
  triggerDebugTrace,
  triggerExplainCode,
  triggerExplainStackTrace,
  triggerExtractFunction,
  triggerFixMergeConflicts,
  triggerGetPrComments,
  triggerGitLogSearch,
  triggerLocalizeFault,
  triggerLoopOnCi,
  triggerMakePrEasyToReview,
  triggerNewBranchAndPr,
  triggerProgressAudit,
  triggerPrReviewCanvas,
  triggerReviewAndShip,
  triggerRewind,
} from "./system-skills"
export { createToolSearchTool } from "./tool-search"
export type {
  ParsedFrontmatter,
  Skill,
  // ADR-0457 — codex skill ECOSYSTEM types.
  SkillAgentInterface,
  SkillEffort,
  SkillInstallState,
  SkillResources,
  SkillScope,
} from "./types"
export {
  isSkillInstallState,
  isSkillScope,
  SKILL_INSTALL_STATES,
  SKILL_SCOPES,
  SKILL_SCOPES_PRECEDENCE_DESC,
  skillScope,
} from "./types"
