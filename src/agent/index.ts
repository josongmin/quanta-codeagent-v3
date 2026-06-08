export { createAutoClassifierPort } from "./auto-classifier"
export type { BranchSearchConfig } from "./branch-search"
export { type BriefStore, createBriefStore, parseBoolKnob } from "./brief"
// RFC may-22-unified-agent-runtime — run-mode + budget slices.
export {
  asDials,
  type BudgetCaps,
  type BudgetClampEvent,
  type BudgetDials,
  type BudgetEvent,
  type BudgetExhaustedEvent,
  type BudgetExhaustion,
  type BudgetExhaustionPolicy,
  BudgetMeter,
  type BudgetMeterOptions,
  type BudgetTickEvent,
  type BudgetUsage,
  isBudgetEvent,
  makeClampEvent,
  renderTaskBudgetBlock,
  type TaskBudget,
  type TickKind,
} from "./budget"
export {
  type CloseoutCritic,
  type CloseoutCriticConfig,
  type CloseoutCriticObservation,
  type CloseoutCriticRequest,
  type CloseoutCriticVerdict,
  runCloseoutCritic,
} from "./closeout-critic"
export {
  COMMAND_HOOKS_ENABLED_WITHOUT_ACK_MESSAGE,
  type CommandHookBinding,
  type CommandHookConfig,
  CommandHookConfigError,
  type CommandHookDeps,
  type CommandHookEvent,
  type CommandHookExecOpts,
  type CommandHookExecPort,
  type CommandHookExecResult,
  type CommandHookGate,
  type CommandHookPermissionPort,
  type CommandHookVerdict,
  createSandboxCommandHookExec,
  DEFAULT_COMMAND_HOOK_MAX_OUTPUT_BYTES,
  DEFAULT_COMMAND_HOOK_TIMEOUT_MS,
  installCommandHooks,
  loadCommandHookBindings,
  mapClaudeEvent,
  normalizeCommandHookGate,
  parseCommandHookBindings,
  runCommandHooks,
} from "./command-hooks"
export {
  charsOf,
  compactIfNeeded,
  estimateTokens,
  findBoundary,
  markBaselineStaleIfShrunk,
  resolveCompactionLimitTokens,
  type TokenBaseline,
  TokenBaselineBox,
  type TokenBaselineBoxState,
  triggerTokenCount,
} from "./compaction"
export {
  type BreakerVerdict,
  CompactionBreaker,
  type CompactionBreakerCaps,
  DEFAULT_COMPACTION_BREAKER_CAPS,
} from "./compaction-breaker"
export {
  ALL_CONFIRM_DECISIONS,
  buildDenySteerMessage,
  type ConfirmDecision,
  ConfirmDecisionError,
  isAllowed as isConfirmDecisionAllowed,
  normalizeConfirm,
  READONLY_DENY_STEER_NOTE,
} from "./confirm-decision"
export {
  appendSummary,
  archivedTokens,
  type ConversationSummaryArchive,
  type ConversationSummaryEntry,
  createArchive,
} from "./conversation-summary-archive"
export {
  createEffortStore,
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
  type EffortLevel,
  type EffortStore,
  effortToTokenBudget,
  parseEffort,
  resolveEffort,
  type SkillEffortAdvisory,
} from "./effort"
export {
  type ProbeRepoMapOpts,
  type ProbeTurnEnvOpts,
  probeRepoMap,
  probeTurnEnv,
  REPO_MAP_DEFAULT_MAX_CHARS,
  REPO_MAP_DEFAULT_MAX_DEPTH,
  REPO_MAP_DEFAULT_MAX_FILES,
  renderEnvBlock,
  type TurnEnvContext,
} from "./env-context"
export {
  composeGlobRulesWithDetected,
  GLOB_RULE_DIRS,
  type GlobRule,
  type LoadGlobRulesWithVendorsOpts,
  loadGlobRules,
  loadGlobRulesWithVendors,
  MAX_RENDER_BYTES,
  MAX_RULE_BYTES,
  MAX_RULE_FILES,
  renderGlobRulesBlock,
  selectGlobRules,
} from "./glob-rules"
export {
  type HandoffRequiredEvent,
  type HITLTier,
  type HitlTier,
  isHandoffRequiredEvent,
} from "./hitl-tier"
export {
  __resetHitlOverrides,
  builtinAnnotations,
  type HitlAnnotation,
  resolveHitlAnnotation,
} from "./hitl-tier-registry"
export {
  DEFAULT_HOOK_DENY_REASON,
  type HookAbort,
  HookBus,
  type HookDeny,
  type HookEmitResult,
  type HookEvent,
  type HookEventType,
  type HookHandler,
  type HookPermissionDecision,
  type HookPermissionResponse,
  type HookPromptInject,
  type HookToolOverride,
  type HookUpdatedInput,
  normalizePermissionDecision,
  type PermissionHookRouting,
  PROMPT_HOOK_MAX_CHARS,
  routePermissionHookVerdict,
  TOOL_FAILURE_RETRY_MAX,
} from "./hooks"
export {
  FileSystemIdeContextProvider,
  type FileSystemIdeContextProviderOpts,
  type IdeContextMetadata,
  type IdeContextMetadataSink,
  type IdeContextProvider,
  type IdeContextTier,
  type IdeSnapshot,
  renderIdeContext,
  toMetadataSnapshot,
  toRelativePath,
} from "./ide-context"
export {
  type AgentlessLocalizeDeps,
  type AgentlessLocalizeResult,
  agentlessLocalize,
  buildAgentlessPrompt,
  composeAgentlessHint,
  composeIssueHint,
  EMPTY_HINT as EMPTY_ISSUE_HINT,
  extractCodeFences,
  extractErrors,
  extractFiles,
  extractIssueHint,
  extractSymbols,
  extractTracebackPaths,
  type IssueHint,
  parseAgentlessResponse,
} from "./issue-hint"
export { runAgent } from "./loop"
export { lspDiagnosticsTool, lspNavToolList } from "./lsp-bridge"
export {
  attachLspDiagnosticsHook,
  type LspDiagnosticsHookHandle,
  type LspDiagnosticsHookOptions,
  type OpenDiagnosticsSession,
  type PromptInjectPush,
} from "./lsp-diagnostics-hook"
export {
  applyMcpClientWiring,
  type ElicitationPrompterFactory,
  type LoadMcpToolsOpts,
  loadMcpTools,
  type McpStoppable,
  mcpToolName,
  mcpToolToTool,
  mcpToolToToolSupervised,
  type SamplingWiringInput,
} from "./mcp-bridge"
export {
  type PersistDeps,
  type PersistInput,
  persistSession,
  type RecallDeps,
  recallContext,
  SESSION_TAG,
} from "./memory"
export {
  arbitrateConsolidation,
  type ConsolidationOp,
} from "./memory-consolidate"
export {
  type DistilledMemory,
  distillSession,
  finalAssistantText,
} from "./memory-distill"
export {
  CachingEmbedder,
  NullEmbedder,
  OpenAIEmbedder,
  type OpenAIEmbedderOptions,
} from "./memory-embedder"
export {
  emptyPersistStats,
  type PersistStats,
  type RecallStats,
} from "./memory-stats"
export {
  type LineCitation,
  lineSpanOf,
  type MemoryToolsDeps,
  type MemoryWriteGuard,
  memoryTools,
  type ThreadMemoryMode,
} from "./memory-tools"
export { AgentRecorder, METRIC } from "./metrics"
export { isMutatingToolBlockedInMode, modeBlockReason, resolveAgentMode } from "./mode"
export {
  loadNamedAgents,
  MAX_AGENT_FILES,
  MAX_AGENT_SYSTEM_BYTES,
  NAMED_AGENT_DIRS,
  type NamedAgentDefinition,
  NamedAgentRegistry,
  type NamedAgentResolver,
} from "./named-agent-registry"
export { wireOptionalAgentPorts } from "./optional-ports"
export { type PersonaKind, resolvePersona } from "./persona"
export { isMutatingToolBlockedInPlan } from "./plan"
export type { PlanExitDecision, PlanExitOutcome } from "./plan-exit"
export {
  ALL_PLAN_EXIT_DECISIONS,
  buildPlanExit,
  PlanExitInvariantError,
  planExitAllowsMutation,
  planExitStaysInPlan,
} from "./plan-exit"
export type { AgentMode, TurnContext, TurnContextInput } from "./prompt"
export { buildSystemPrompt, buildTurnContext, escapeReminderBoundary } from "./prompt"
export { RECOVERY_CAPS } from "./recovery"
export {
  loadRepoRules,
  REPO_RULE_CANDIDATES,
  type RepoRules,
  renderRepoRulesBlock,
} from "./repo-rules"
export {
  DEFAULT_SAMPLES as REPRO_TEST_DEFAULT_SAMPLES,
  DEFAULT_TIMEOUT_MS as REPRO_TEST_DEFAULT_TIMEOUT_MS,
  type ExecuteReproTestsArgs as ReproExecuteArgs,
  executeReproTests,
  generateReproTests,
  MAX_SAMPLES as REPRO_TEST_MAX_SAMPLES,
  normaliseReproSource,
  type ReproExecPort,
  type ReproTestConfig,
  type ReproTestOutcome,
  type ReproTestSample,
  type ReproTestSelection,
  type ReproWriteFilePort,
  selectReproTest,
  stripMarkdownFences,
  stripPythonComments,
} from "./repro-test"
export { isRetryable, RetryingLLM, type RetryingLLMOptions } from "./retry"
export { createOnConfirmReviewerPort, type OnConfirmReviewerPortOptions } from "./reviewer-port"
export {
  type AgentMode as RunMode,
  ALL_AGENT_MODES,
  assertModeMatrix,
  BUDGET_PRESETS,
  clampDials,
  type ExternalDepsLever,
  type GitWriteLever,
  LEVER_FIELDS,
  type LeverField,
  type MemoryLever,
  MODE_PRESETS,
  type ModePolicy,
  type NetworkLever,
  narrowMode,
  type ObservationLever,
  type OutputLever,
  type PermissionLever,
  type PromptPackLever,
  type SandboxLever,
  type SecretsLever,
  type TerminationLever,
  type ToolSurfaceLever,
} from "./run-mode"
export {
  assertSideConversationEffort,
  DEFAULT_SIDE_CONVERSATION_INPUT_TOKEN_BUDGET,
  DEFAULT_SIDE_CONVERSATION_OUTPUT_TOKEN_BUDGET,
  dispatchSideConversation,
  estimateSideConversationTokens,
  filterSideConversationTools,
  runSideConversation,
  SIDE_CONVERSATION_PROMPT,
  SIDE_CONVERSATION_PROMPT_BASE,
  SIDE_CONVERSATION_PROMPT_DELIMITER,
  SIDE_CONVERSATION_QUANTA_ADDENDUM,
  SIDE_CONVERSATION_TOOL_EXCLUSIONS,
  SIDE_CONVERSATION_TOOL_NAMES,
  SideConversationAbortedError,
  SideConversationBudgetError,
  type SideConversationEffort,
  SideConversationEffortError,
  type SideConversationOptions,
  type SideConversationRequest,
  type SideConversationResolver,
  type SideConversationResponse,
  type SideConversationResult,
  type SideConversationSpanAttributes,
  SideConversationToolError,
} from "./side-conversation"
export { loadSession, type SaveSessionInput, saveSession } from "./state"
export {
  classifyErrorReason,
  completedCategory,
  interruptedCategory,
  STOP_REASON_CODE,
  type StopCategory,
  type StopCategoryKind,
  type StopReasonCode,
} from "./stop-category"
export {
  type DispatchOutcome,
  type StreamingCall,
  type StreamingDispatch,
  type StreamingTurnArgs,
  type StreamingTurnResult,
  streamingTurn,
} from "./streaming-dispatch"
export { createSubagentRunner, type SubagentRunnerOptions } from "./subagent-runner"
export {
  extractSeedMessages,
  isUserInputSubmission,
  SUBMISSION_LEGACY_ID_PREFIX,
  type Submission,
  type SubmissionOp,
  submissionFromMessages,
} from "./submission"
export {
  ADVISOR_TRANSCRIPT_MAX_CHARS,
  ADVISOR_TRANSCRIPT_MAX_MESSAGES,
  type AdvisorConsultFromLLMOptions,
  advisorConsultFromLLM,
  buildAdvisorBlock,
  redactTranscript,
} from "./tier1/advisor"
export { buildComposeAuthoringBlock } from "./tier1/compose-authoring"
export { buildPrShipBlock } from "./tier1/pr-ship"
export { type ReflectConsultFromLLMOptions, reflectConsultFromLLM } from "./tier1/reflect"
export { createTokenDeltaCounter, type TokenDeltaCounter } from "./token-delta/counter"
export {
  type DeltaTokenWorkingMemory,
  decorateWithDeltaCounter,
} from "./token-delta/wm-decorator"
export type {
  AgentConfig,
  AgentOutcome,
  PreCompactDecision,
  PreCompactRequestQuery,
  StopReason,
} from "./types"
export { embedUntrusted, escapeBoundary } from "./untrusted"
export {
  createVerifyGuardState,
  decideVerifyGuard,
  VERIFY_FORCE_MESSAGE,
  type VerifyGuardState,
} from "./verify-guard"
export {
  isTestLikeCommand,
  matchVerifyCommand,
  TEST_LIKE_RE,
  VERIFY_MATCHERS,
  type VerifyMatcher,
} from "./verify-signal"
export { TurnWorkMetricsCollector, type WorkMetricsSink } from "./work-metrics-collector"
export {
  type Blocker,
  type BlockerSurface,
  createWorkingStateSession,
  type DeferredValidation,
  emptyWorkingState,
  type NextStep,
  type OwnerCandidate,
  renderWorkingStateBlock,
  type WorkingState,
  type WorkingStatePatch,
  type WorkingStateSession,
} from "./working-state"
// ticket-11 (P8) — session-scoped active-worktree slot factory. The comp-root
// mints ONE per session (behind QUANTA_WORKTREE_TOOL) and threads it onto
// `AgentConfig.activeWorktreeSlot`; the dispatch seam projects it onto the
// worktree tools + the bash/edit edit-fence.
export { createWorktreeSlot } from "./worktree-slot"
