// ADR-0135 — Permission profile + file_system_sandbox_policy 2-layer.
export type { AccessVerdict, CanAccessOpts } from "./access-check"
export { canAccess } from "./access-check"
// jun-7-misc 03 (ADR-0497) — guardian per-action typed assessment collapse.
export { collapseAssessment } from "./assessment-collapse"
export type { ApprovalRecord, ApprovalReviewer, ApprovalReviewerOpts } from "./auto-approval-review"
export { createApprovalReviewer } from "./auto-approval-review"
// ADR-0453 — Heartbeat autorun eligibility (pure verdict consumed by scheduler/reactor).
export type {
  AutorunApprovalPolicy,
  AutorunEligibility,
  AutorunEligibilityInput,
  AutorunEligibilityReason,
  AutorunMode,
  AutorunPriorOutcome,
} from "./autorun-eligibility"
export {
  ALL_AUTORUN_ELIGIBILITY_REASONS,
  ALL_AUTORUN_PRIOR_OUTCOMES,
  evaluateAutorunEligibility,
} from "./autorun-eligibility"
export { buildAutorunEligibility } from "./autorun-eligibility-wire"
export type { BranchOnlyVerdict } from "./branch-only"
export { DEFAULT_PROTECTED_BRANCHES, decideBranchOnly } from "./branch-only"
export type {
  CircumventionSignal,
  EffectSignature,
  LayeredRule,
} from "./circumvention"
export {
  buildAutoModeOverlay,
  CIRCUMVENTION_TTL_TURNS,
  CircumventionTracker,
  canonicalizeEffectPath,
  extractShellWritePaths,
  extractWriteEffect,
  extractWriteEffects,
} from "./circumvention"
export type {
  AutoDecision,
  AutoModeOverlay,
  ClassifierPort,
  ClassifyDecision,
  ClassifyRequest,
  DenialState,
} from "./classifier"
export {
  AUTO_MODE_BASELINES,
  AUTO_MODE_DEFAULTS_SENTINEL,
  AutoModeClassifier,
  CIRCUMVENTION_TAXONOMY_LINE,
  CLASSIFIER_SYSTEM_PROMPT,
  DENIAL_LIMITS,
  EXFIL_SCOUTING_TAXONOMY_LINE,
  mergeOverlayCategory,
  STAGE1_BOTH_TAIL,
  STAGE1_FAST_TAIL,
  STAGE2_THINKING_TAIL,
  withCircumventionContext,
  withExfilScoutingTaxonomy,
  withUserRuleOverlay,
} from "./classifier"
export type {
  DenyLayer,
  DenyPillar,
  StructuredDenyReason,
  StructuredDenyReasonInput,
} from "./deny-reason"
export {
  DENY_LAYERS,
  DENY_PILLARS,
  denyContentPrefix,
  hardDenySafeReason,
  structuredDenyReason,
} from "./deny-reason"
export type {
  AutoPassInput,
  AutoPassOptions,
  AutoPassResult,
  FallThroughReason,
  ProposePatternInput,
  ProposePatternResult,
  ProposeRejectReason,
} from "./gate-pattern-wire"
export {
  autoPassByPatterns,
  grantAndCascade,
  recordProposedPattern,
} from "./gate-pattern-wire"
export type { GitWriteProtectReason } from "./git-write-guard"
export {
  ALL_GIT_WRITE_PROTECT_REASONS,
  gitWriteProtectReason,
  isGitWriteProtected,
} from "./git-write-guard"
export type {
  AxisOutcome,
  AxisStep,
  InspectToolMeta,
  MatchedHardDenyRule,
  ModePolicyMatrix,
  ModeVerdict,
  PermissionAxis,
  PermissionInspection,
} from "./inspect"
export {
  finalDecisionFor,
  inspectPermission,
  listHardDenyRuleDescriptors,
  PERMISSION_AXES,
} from "./inspect"
export type {
  CreatePermissionInspectorOptions,
  InspectAction,
  PermissionInspector,
  ResolutionExplanation,
  ResolutionSource,
} from "./inspector"
export { getPermissionInspector } from "./inspector"
export type { NamedProfileName } from "./named-profiles"
export {
  isNamedProfileName,
  NAMED_PROFILE_NAMES,
  NAMED_PROFILES,
  resolvePermissionProfileField,
  resolveProfileByName,
} from "./named-profiles"
export {
  ALL_OUTCOMES,
  ALL_REVIEWERS,
  buildDecision,
  isAdmissible,
  isAllowed,
  isTerminal,
  OutcomeInvariantError,
  requiresUserConfirmation,
} from "./outcome"
export { decideFloor, type FloorVerdict, type ToolCapability } from "./pdp"
export type { HostAgentMode } from "./per-host-mode"
export {
  clearHostMode,
  getHostMode,
  hostAllowsMutation,
  resolveHostId,
  setHostMode,
} from "./per-host-mode"
export type { ThreadPermission } from "./per-thread-store"
export {
  clearThreadPermission,
  getThreadPermission,
  setThreadPermission,
  threadAllowsMutation,
} from "./per-thread-store"
export type {
  ApprovalMode,
  ApprovalPolicy,
  ControlManagedBy,
  ControlPolicy,
  FileSystemAccess,
  FileSystemEntry,
  FileSystemPath,
  FileSystemPolicyType,
  FileSystemSandboxPolicy,
  NetworkMode,
  NetworkPolicy,
  OsSandboxKind,
  PermissionProfile,
  PermissionScope,
  SandboxPolicy as PermissionSandboxPolicy,
  SpecialPathKind,
} from "./permission-profile"
export {
  DEFAULT_FILE_SYSTEM_SANDBOX_POLICY,
  DEFAULT_PERMISSION_PROFILE,
  isPermissionScope,
  isSpecialPathKind,
  PERMISSION_SCOPE_PRECEDENCE_DESC,
  SPECIAL_PATH_KINDS,
  strongerScope,
} from "./permission-profile"
export type {
  CreatePermissionStoreOptions,
  DenialRecord,
  PermissionReader,
  PermissionState,
  PermissionStore,
} from "./permission-store"
export {
  __resetDefaultPermissionStore,
  computeActionSignature,
  createPermissionStore,
  defaultStateFilePath,
  getDefaultPermissionStore,
} from "./permission-store"
export type {
  EvaluateAutoOptions,
  EvaluateStackOptions,
  PermissionStackContext,
} from "./policy"
export {
  evaluate,
  evaluateAuto,
  evaluateStack,
  hardDenyReason,
  inferApprovalPolicy,
  inferControlPolicy,
  inferNetworkPolicy,
  inferSandboxPolicy,
  inferToolTier,
} from "./policy"
export type {
  ConfigLayer,
  FieldCombiner,
  FieldCombinerSpec,
  LayerSource,
  MergeOptions,
  MergeResult,
  MergeStrategy,
  OverriddenMetadata,
  RestrictivenessSpec,
} from "./policy-layers"
export {
  isLayerSource,
  LAYER_SOURCE_PRECEDENCE_ASC,
  layerSourceRank,
  mergeLayered,
  resolvePolicyLayers,
} from "./policy-layers"
export type { PostDenialAction, PostDenialClock } from "./post-denial"
export {
  clearDenialRecord,
  getDenialRecord,
  hasPostDenialOverride,
  recordDenial,
  recordRiskSeen,
  recordUserOverride,
} from "./post-denial"
export type {
  ProfileDefinition,
  ProfileDefinitionRegistry,
  ProfileTag,
  ResolveInheritanceOpts,
} from "./profile-inheritance"
export { ProfileInheritanceError, resolveProfileInheritance } from "./profile-inheritance"
export type { ProfileLayerSlots } from "./profile-layer-merge"
export {
  mergeProfileLayers,
  PROFILE_COMBINERS,
  PROFILE_RESTRICTIVENESS,
} from "./profile-layer-merge"
export type {
  ListProfilesOptions,
  ProfileListEntry,
  ProfileLoadErrorMode,
  SelectProfileOptions,
} from "./profile-list-select"
export {
  APPROVAL_RANK,
  buildDefinition,
  exceedsCeiling,
  listPermissionProfiles,
  NETWORK_RANK,
  ProfileSelectError,
  ProfileValidationError,
  parseUserProfile,
  parseUserProfileDefinition,
  selectPermissionProfile,
} from "./profile-list-select"
export {
  approvalModeToContextMode,
  permissionModeFromProfile,
} from "./profile-to-context"
export {
  __resetPermissionRecorder,
  emitPermissionDecision,
  emitPostDenialEvent,
  getPermissionRecorder,
  type PermissionDecidedBy,
  type PermissionDecisionRecord,
  type PermissionOutcomeLabel,
  type PermissionRecorder,
  type PermissionRiskLevel,
  type PermissionStackSource,
  type PostDenialEventKind,
  type PostDenialEventRecord,
  setPermissionRecorder,
} from "./recorder"
export type { ClassifiedCommand, LearningSource, PendingPermission } from "./remember-patterns"
export {
  autoResolvable,
  classifyCommand,
  computeSubcommandTokens,
  grantPatterns,
  inferSuggestedAllowlistEntry,
  PatternGrantStore,
} from "./remember-patterns"
export type {
  ReasonCode,
  ReviewDecision,
  ReviewDecisionVerb,
  ReviewKind,
} from "./review-kind"
export {
  ALL_REASON_CODES,
  ALL_REVIEW_DECISION_VERBS,
  ALL_REVIEW_KINDS,
  inferReviewKind,
  isDecisionLegalFor,
  isExecutionBlocking,
  reasonCodeFor,
  stopCategoryFor,
} from "./review-kind"
export {
  DenialPrecedenceConflictError,
  ReviewerUnavailableError,
  reviewAction,
} from "./reviewer"
// #20 — prefix-aware session grants (pure: derive/match the "always allow `git
// …` this session" prefix key, with the single-simple-command safety guard).
export {
  actionMatchesPrefixGrant,
  derivePrefixGrantKey,
  isSimpleCommand,
  prefixGrantLabel,
} from "./session-grant-prefix"
export type {
  CachedResolver,
  CwdPort,
  GitPort,
  OsFamily,
  OsPort,
  ResolveSpecialPathOpts,
} from "./special-path-resolver"
export {
  createCachedResolver,
  defaultCwdPort,
  defaultOsPort,
  resolveSpecialPath,
} from "./special-path-resolver"
export {
  createInMemoryTrustScopeRegistry,
  type TrustScope,
  type TrustScopeAction,
  type TrustScopeGrant,
  type TrustScopeRegistry,
} from "./trust-scope"
export {
  createPersistentTrustScopeRegistry,
  defaultProjectOverlayPath,
  defaultTrustScopeStatePath,
  type PersistentTrustScopeOptions,
  type PersistentTrustScopeRecord,
  type PersistentTrustScopeRegistry,
} from "./trust-scope-store"
export type { EffectiveAccessResult, TwoLayerManager } from "./two-layer-manager"
export { createTwoLayerManager } from "./two-layer-manager"
export type {
  ApprovalDecision,
  ApprovalOutcome,
  DenialMemory,
  HITLTier,
  PermissionContext,
  PermissionDecision,
  PermissionMode,
  ReviewContext,
  ReviewerPort,
  ReviewerTier,
  ToolAction,
  ToolActionKeyed,
} from "./types"
export {
  type ActionAssessment,
  ALL_ASSESSMENT_KINDS,
  ALL_PERMISSION_MODES,
  type AssessmentEscalation,
  type AssessmentKind,
  isPermissionMode,
} from "./types"
