# Quanta — Architecture (Generated)

> Auto-generated from `tools/arch-gen` on **2026-05-24** by walking `docs/decisions/` + `src/**`. Edit the source — re-run `bun tools/arch-gen/main.ts` to refresh. The hand-curated companion lives at `docs/ARCHITECTURE.md`.

## Slices (29 total)

### `@/agent`

> (no description)

- Public surface: `__resetHitlOverrides`, `AgentConfig`, `agentlessLocalize`, `AgentlessLocalizeDeps`, `AgentlessLocalizeResult`, `AgentMode`, `AgentOutcome`, `AgentRecorder`, `ALL_AGENT_MODES`, `ALL_CONFIRM_DECISIONS`, `ALL_PLAN_EXIT_DECISIONS`, `appendSummary`, `arbitrateConsolidation`, `archivedTokens`, `asDials`, `assertModeMatrix`, `assertSideConversationEffort`, `Blocker`, `BlockerSurface`, `BranchSearchConfig`, `BreakerVerdict`, `BUDGET_PRESETS`, `BudgetCaps`, `BudgetClampEvent`, `BudgetDials`, `BudgetEvent`, `BudgetExhaustedEvent`, `BudgetExhaustion`, `BudgetExhaustionPolicy`, `BudgetMeter`, `BudgetMeterOptions`, `BudgetTickEvent`, `BudgetUsage`, `buildAgentlessPrompt`, `buildDenySteerMessage`, `buildPlanExit`, `buildSystemPrompt`, `buildTurnContext`, `builtinAnnotations`, `CachingEmbedder`, `clampDials`, `classifyErrorReason`, `compactIfNeeded`, `CompactionBreaker`, `CompactionBreakerCaps`, `completedCategory`, `composeAgentlessHint`, `composeIssueHint`, `ConfirmDecision`, `ConfirmDecisionError`, `ConsolidationOp`, `ConversationSummaryArchive`, `ConversationSummaryEntry`, `createArchive`, `createAutoClassifierPort`, `createEffortStore`, `createSubagentRunner`, `createVerifyGuardState`, `createWorkingStateSession`, `decideVerifyGuard`, `DEFAULT_COMPACTION_BREAKER_CAPS`, `DEFAULT_EFFORT`, `DEFAULT_SIDE_CONVERSATION_INPUT_TOKEN_BUDGET`, `DEFAULT_SIDE_CONVERSATION_OUTPUT_TOKEN_BUDGET`, `DeferredValidation`, `DispatchOutcome`, `dispatchSideConversation`, `DistilledMemory`, `distillSession`, `EFFORT_LEVELS`, `EffortLevel`, `EffortStore`, `effortToTokenBudget`, `embedUntrusted`, `EMPTY_ISSUE_HINT`, `emptyPersistStats`, `emptyWorkingState`, `escapeBoundary`, `estimateSideConversationTokens`, `estimateTokens`, `executeReproTests`, `ExternalDepsLever`, `extractCodeFences`, `extractErrors`, `extractFiles`, `extractIssueHint`, `extractSeedMessages`, `extractSymbols`, `extractTracebackPaths`, `FileSystemIdeContextProvider`, `FileSystemIdeContextProviderOpts`, `filterSideConversationTools`, `finalAssistantText`, `findBoundary`, `generateReproTests`, `GitWriteLever`, `GLOB_RULE_DIRS`, `GlobRule`, `HandoffRequiredEvent`, `HitlAnnotation`, `HitlTier`, `HITLTier`, `HookAbort`, `HookBus`, `HookDeny`, `HookEmitResult`, `HookEvent`, `HookEventType`, `HookHandler`, `HookPromptInject`, `HookToolOverride`, `HookUpdatedInput`, `IdeContextMetadata`, `IdeContextMetadataSink`, `IdeContextProvider`, `IdeContextTier`, `IdeSnapshot`, `interruptedCategory`, `isBudgetEvent`, `isConfirmDecisionAllowed`, `isHandoffRequiredEvent`, `isMutatingToolBlockedInMode`, `isMutatingToolBlockedInPlan`, `isRetryable`, `IssueHint`, `isTestLikeCommand`, `isUserInputSubmission`, `LEVER_FIELDS`, `LeverField`, `loadGlobRules`, `loadMcpTools`, `loadRepoRules`, `loadSession`, `lruConversationCheckpointStore`, `lspDiagnosticsTool`, `lspNavToolList`, `makeClampEvent`, `matchVerifyCommand`, `MAX_RENDER_BYTES`, `MAX_RULE_BYTES`, `MAX_RULE_FILES`, `mcpToolName`, `mcpToolToTool`, `MemoryLever`, `memoryTools`, `METRIC`, `MODE_PRESETS`, `modeBlockReason`, `ModePolicy`, `narrowMode`, `NetworkLever`, `NextStep`, `normaliseReproSource`, `normalizeConfirm`, `NullEmbedder`, `ObservationLever`, `OpenAIEmbedder`, `OpenAIEmbedderOptions`, `OutputLever`, `OwnerCandidate`, `parseAgentlessResponse`, `parseEffort`, `PermissionLever`, `PersistDeps`, `PersistInput`, `persistSession`, `PersistStats`, `PersonaKind`, `planExitAllowsMutation`, `PlanExitDecision`, `PlanExitInvariantError`, `PlanExitOutcome`, `planExitStaysInPlan`, `PreCompactDecision`, `PreCompactRequestQuery`, `PROMPT_HOOK_MAX_CHARS`, `PromptPackLever`, `READONLY_DENY_STEER_NOTE`, `recallContext`, `RecallDeps`, `RecallStats`, `RECOVERY_CAPS`, `renderGlobRulesBlock`, `renderIdeContext`, `renderRepoRulesBlock`, `renderWorkingStateBlock`, `REPO_RULE_CANDIDATES`, `RepoRules`, `REPRO_TEST_DEFAULT_SAMPLES`, `REPRO_TEST_DEFAULT_TIMEOUT_MS`, `REPRO_TEST_MAX_SAMPLES`, `ReproExecPort`, `ReproExecuteArgs`, `ReproTestConfig`, `ReproTestOutcome`, `ReproTestSample`, `ReproTestSelection`, `ReproWriteFilePort`, `resolveAgentMode`, `resolveEffort`, `resolveHitlAnnotation`, `resolvePersona`, `RetryingLLM`, `RetryingLLMOptions`, `runAgent`, `RunMode`, `runSideConversation`, `SandboxLever`, `saveSession`, `SaveSessionInput`, `SecretsLever`, `selectGlobRules`, `selectReproTest`, `SESSION_TAG`, `SIDE_CONVERSATION_PROMPT`, `SIDE_CONVERSATION_PROMPT_BASE`, `SIDE_CONVERSATION_PROMPT_DELIMITER`, `SIDE_CONVERSATION_QUANTA_ADDENDUM`, `SIDE_CONVERSATION_TOOL_NAMES`, `SideConversationAbortedError`, `SideConversationBudgetError`, `SideConversationEffort`, `SideConversationEffortError`, `SideConversationOptions`, `SideConversationRequest`, `SideConversationResolver`, `SideConversationResponse`, `SideConversationResult`, `SideConversationSpanAttributes`, `SideConversationToolError`, `SkillEffortAdvisory`, `STOP_REASON_CODE`, `StopCategory`, `StopCategoryKind`, `StopReason`, `StopReasonCode`, `StreamingCall`, `StreamingDispatch`, `streamingTurn`, `StreamingTurnArgs`, `StreamingTurnResult`, `stripMarkdownFences`, `stripPythonComments`, `SubagentRunnerOptions`, `Submission`, `SUBMISSION_LEGACY_ID_PREFIX`, `submissionFromMessages`, `SubmissionOp`, `TerminationLever`, `TEST_LIKE_RE`, `TickKind`, `toMetadataSnapshot`, `TOOL_FAILURE_RETRY_MAX`, `ToolSurfaceLever`, `toRelativePath`, `TurnContext`, `TurnContextInput`, `TurnWorkMetricsCollector`, `VERIFY_FORCE_MESSAGE`, `VERIFY_MATCHERS`, `VerifyGuardState`, `VerifyMatcher`, `WorkingState`, `WorkingStatePatch`, `WorkingStateSession`, `WorkMetricsSink`
- Hellgate: `tests/unit/agent-debug-trace-autofix-hellgate.test.ts`

### `@/auth`

> (no description)

- Public surface: `chatgptOAuth`
- Hellgate: _(none)_

### `@/connectors` [ADR-0160]

> Connectors — public surface barrel (ADR-0160). Phases A–E ship: type model + ports + REST/in-memory registry + OAuth discovery + dynamic registration + availability prober + token rotation. Default-OFF: this slice is additive. `src/mcp/`...

- Public surface: `AvailabilityCheckerPort`, `AvailabilityVerdict`, `CacheEntry`, `CachePort`, `ClockPort`, `Connector`, `ConnectorRegistryPort`, `createAvailabilityProber`, `createInMemoryConnectorRegistry`, `createRestConnectorRegistry`, `createTokenRotator`, `discoverOAuthEndpoints`, `DnsPort`, `FetchPort`, `FetchPortResponse`, `OAuthClientMetadata`, `OAuthClientRegistration`, `OAuthDiscoveryError`, `OAuthDiscoveryErrorCode`, `OAuthEndpoints`, `OAuthRegistrationError`, `OAuthRegistrationErrorCode`, `RefreshOutcome`, `registerOAuthClient`, `RestRegistryConfig`, `SupportedAuth`, `TokenRecord`, `TokenRotationError`, `TokenRotationErrorCode`, `TokenRotator`, `TokenRotatorConfig`, `TokenStorePort`
- Hellgate: _(none)_

### `@/git`

> `@/git` — pure / library-slice git utilities. Importers must inject any subprocess access via the closed ports declared here. No upward deps. The existing `src/tool/git/*` first-class tools are unrelated (they live downstream in `@/tool`...

- Public surface: `ConflictBlock`, `ConflictParseDiagnostic`, `ConflictParseResult`, `ConflictParserInputError`, `createInMemoryFileLock`, `FileLockPort`, `GitProcessPort`, `GitProcessResult`, `parseConflicts`, `SnapshotClock`, `snapshotDirtyToCloudBranch`, `SnapshotError`, `SnapshotErrorThrown`, `SnapshotOpts`, `SnapshotResult`, `SnapshotStage`
- Hellgate: `tests/unit/git-posture-prompt-hellgate.test.ts`

### `@/ipc`

> `@/ipc` — surface-agnostic CLI ↔ Web ↔ Tauri event bridge (Claude A11 deep-dive absorption). Two contracts: 1. `EventBridge` — high-level publish/subscribe over typed `BridgePayload` events. Loopback delivery to local subscribers, transp...

- Public surface: `BridgeEvent`, `BridgeOutcomeSummary`, `BridgePayload`, `BridgePermissionPreview`, `BridgeSessionMeta`, `BridgeTransport`, `createEventBridge`, `CreateEventBridgeOpts`, `createInMemoryHub`, `createInMemoryTransport`, `createStdioTransport`, `CreateStdioTransportOpts`, `createWebSocketServerTransport`, `EventBridge`, `exportSession`, `ImportError`, `ImportErrorKind`, `importSession`, `ImportSessionOpts`, `InMemoryHub`, `isoNow`, `isWireEnvelope`, `metaToPortable`, `parsePortableSession`, `PORTABLE_SESSION_VERSION`, `PortableSessionImportError`, `PortableSessionV1`, `StdioReader`, `StdioWriter`, `udsSocketPath`, `udsSocketSuffix`, `WebSocketLike`, `WireEnvelope`, `wrapDuplexAsUdsTransport`, `wrapWebSocketLikeAsTransport`
- Hellgate: _(none)_

### `@/llm`

> (no description)

- Public surface: `__resetUnknownEventRateLimitForTests`, `AnthropicAdapter`, `AssembledTurn`, `assembleFromEvents`, `ContentBlock`, `createLLM`, `CreateLLMOptions`, `DecodedProviderEvent`, `decodeSseEvent`, `decodeWsEvent`, `DEFAULT_MODEL`, `determinePhases`, `DocumentBlock`, `EnvLike`, `FallbackLLM`, `FallbackLLMOptions`, `hasToolUse`, `ImageBlock`, `isFallbackTrigger`, `KNOWN_EVENT_KINDS`, `LLMPort`, `logUnknownEventRateLimited`, `Message`, `MissingApiKeyError`, `ModelCandidate`, `ModelSwapRetryOptions`, `NoAlternateModelError`, `OpenAIAdapter`, `ParsedSseFrame`, `parseSseFrame`, `pickNextModel`, `pickProvider`, `Provider`, `resolveRetryModel`, `splitSseFrames`, `StreamEvent`, `StreamInput`, `streamWithModel`, `SystemBlock`, `SystemPromptInput`, `TextBlock`, `ThinkingBlock`, `ToolChoice`, `ToolResultBlock`, `ToolSchema`, `ToolUseBlock`, `tryCreateLLM`
- Hellgate: `tests/unit/llm-provider-router-hellgate.test.ts`

### `@/lsp` [ADR-0141]

> (no description)

- Public surface: `CodeAction`, `CodeActionDocumentEdit`, `CodeActionKind`, `CodeActionPort`, `CodeActionPos`, `CodeActionRange`, `CodeActionTextEdit`, `CodeActionWorkspaceEdit`, `DefaultCodeActionAdapter`, `DefaultFormatAdapter`, `DefaultSignatureHelpAdapter`, `Diagnostic`, `DiagnosticSeverity`, `FormatPort`, `FormatPos`, `FormatRange`, `Hover`, `languageIdFor`, `Location`, `LspClient`, `LspClientOptions`, `LspClientSpec`, `LspPort`, `LspServerInfo`, `Pos`, `PyrightAdapter`, `PyrightAdapterOptions`, `Range`, `RenameApplyPort`, `RenameDocumentEdit`, `RenamePos`, `RenamePreview`, `RenameRange`, `RenameTextEdit`, `RenameWorkspaceEdit`, `SignatureHelpPort`, `SignatureInfo`, `SignatureParameter`, `SymbolInfo`, `SymbolKind`, `TextEdit`, `TypescriptAdapter`, `TypescriptAdapterOptions`
- Hellgate: `tests/unit/lsp-atomic-write-hellgate.test.ts`

### `@/mcp`

> MCP (Model Context Protocol) stdio client — public API. Selective re-export only: framing internals (LineReader, codec) stay private to the slice.

- Public surface: `McpCallResult`, `McpClient`, `McpError`, `McpServerConfig`, `McpToolDef`
- Hellgate: `tests/unit/mcp-skybridge-applevz-native-hellgate.test.ts`

### `@/memory` [ADR-0068]

> (no description)

- Public surface: `bucketOf`, `cosine`, `createWorkingMemory`, `DEFAULT_DUPE_THRESHOLDS`, `DEFAULT_EVICTION_CAPS`, `DEFAULT_RECALL_LIMIT`, `deserializeVec`, `DupeThresholds`, `EMBED_DIM`, `EmbedderPort`, `EVICTION_DECAY`, `EvictionCaps`, `EvictionPlan`, `findNearDuplicates`, `FORBIDDEN_TELEMETRY_KEYS`, `FRESH_MAX_MS`, `FreshnessBucket`, `InMemoryStore`, `MEMORY_CONSOLIDATE_MIN_TURNS`, `MEMORY_KINDS`, `MEMORY_SUMMARY_MAX_BYTES`, `MEMORY_TIERS`, `MemoryEntry`, `MemoryKind`, `MemoryQuery`, `MemoryTelemetryPort`, `MemoryTier`, `MemoryWriteError`, `MemoryWriter`, `noopMemoryTelemetry`, `normalize`, `NormalizedEntry`, `normalizeEntry`, `PersistentStorePort`, `PHASE1_EVENT_ALLOWED_KEYS`, `Phase1DistillError`, `Phase1Input`, `Phase1Outcome`, `Phase1OutcomeKind`, `Phase1Port`, `Phase1TelemetryEvent`, `PHASE2_AUTO_TRIGGER_MAX_AGE_MS`, `PHASE2_AUTO_TRIGGER_PENDING`, `PHASE2_EVENT_ALLOWED_KEYS`, `Phase2ConsolidateError`, `Phase2Input`, `Phase2Outcome`, `Phase2OutcomeKind`, `Phase2Port`, `Phase2Summarizer`, `Phase2TelemetryEvent`, `planEviction`, `rankEntries`, `RECALL_EVENT_ALLOWED_KEYS`, `RecallTelemetryEvent`, `RECENT_MAX_MS`, `runPhase1`, `runPhase2`, `scoreEntry`, `serializeVec`, `SqliteStore`, `Stage1Output`, `Stage1Store`, `Stage1StorePort`, `STALE_MAX_MS`, `StoredMessage`, `WatermarkConflictError`, `WatermarkState`, `WorkingMemory`
- Hellgate: `tests/unit/memory-fence-no-llm-import-hellgate.test.ts`

### `@/migration` [ADR-0038]

> External-agent import slice (ADR-0038, Cluster D Feature 4). Public re-exports for the migration slice. Slice isolation: only `@/ agent` (and the migration slice's own tests) may import from this index.

- Public surface: `ALL_PROVIDERS`, `appendImportLog`, `claudeCodeTranslator`, `contentSha256`, `DetectedAgent`, `detectExternalAgents`, `detectorContracts`, `ExternalAgentProvider`, `ExternalSessionId`, `ImportEvent`, `ImportEventSink`, `ImportLog`, `ImportLogBusyError`, `ImportLogEntry`, `importLogPath`, `ImportResult`, `ImportStage`, `loadImportLog`, `runImport`, `RunImportOptions`, `SessionTranslator`, `TranslatableProvider`, `translatorFor`, `UnknownProviderRejectedError`, `wasAlreadyImported`
- Hellgate: _(none)_

### `@/observability`

> (no description)

- Public surface: `__resetSpanSink`, `accumulateWorkMetrics`, `attrs`, `Attrs`, `buildCostDashboard`, `buildLlmCostMetricsSink`, `buildMemoryTelemetry`, `buildShellOtelObserver`, `buildWorkMetrics`, `CostDashboard`, `costUsd`, `Counter`, `createTurnTimingCapture`, `emitLlmCostToOtel`, `endSpan`, `FileDiffStat`, `Gauge`, `GEN_AI_ATTRS`, `getSpanSink`, `LlmCostLabels`, `LlmCostSink`, `log`, `LogRecord`, `LogSink`, `MEMORY_TELEMETRY_KEYS`, `mergeAttrs`, `metrics`, `Metrics`, `MetricsSnapshot`, `MonotonicClock`, `parseNumstat`, `permissionAttrs`, `postDenialAttrs`, `PRICING_VERSION`, `Provider`, `providerOf`, `QUANTA_ATTRS`, `recordAttrs`, `renderDashboardMarkdown`, `renderDashboardText`, `safeTtftMs`, `setSpanSink`, `Span`, `SPAN_NAMES`, `SpanName`, `SpanSink`, `SpanStatus`, `startSpan`, `StructuredLogger`, `StructuredLoggerOptions`, `summarizeWorkMetrics`, `Timer`, `TimerStats`, `TimerStop`, `TurnTiming`, `TurnTimingCapture`, `WorkMetrics`, `workMetricsAttrs`
- Hellgate: `tests/unit/observability-metrics-hellgate.test.ts`

### `@/patch`

> V4A apply_patch — public API barrel. Stable surface for consumers (agent / tool slice). Internal modules are not exported; cross-slice imports go through this file.

- Public surface: `applyPatch`, `ApplyResult`, `Change`, `Hunk`, `parsePatch`, `Patch`, `PatchAnchorNotFoundError`, `PatchApplyError`, `PatchFileSystemPort`, `PatchObservation`, `PatchObserver`, `PatchOp`, `PatchParseError`
- Hellgate: `tests/unit/patch-v4a-otel-emit-hellgate.test.ts`

### `@/permission` [ADR-0135]

> ADR-0135 — Permission profile + file_system_sandbox_policy 2-layer.

- Public surface: `__resetDefaultPermissionStore`, `__resetPermissionRecorder`, `AccessVerdict`, `ALL_GIT_WRITE_PROTECT_REASONS`, `ALL_OUTCOMES`, `ALL_REASON_CODES`, `ALL_REVIEW_DECISION_VERBS`, `ALL_REVIEW_KINDS`, `ALL_REVIEWERS`, `ApprovalDecision`, `ApprovalMode`, `ApprovalOutcome`, `ApprovalPolicy`, `ApprovalRecord`, `ApprovalReviewer`, `ApprovalReviewerOpts`, `AutoDecision`, `AutoModeClassifier`, `autoPassByPatterns`, `AutoPassInput`, `AutoPassOptions`, `AutoPassResult`, `autoResolvable`, `AxisOutcome`, `AxisStep`, `BranchOnlyVerdict`, `buildDecision`, `CachedResolver`, `canAccess`, `CanAccessOpts`, `ClassifiedCommand`, `CLASSIFIER_SYSTEM_PROMPT`, `ClassifierPort`, `classifyCommand`, `ClassifyDecision`, `ClassifyRequest`, `clearDenialRecord`, `clearHostMode`, `clearThreadPermission`, `computeActionSignature`, `computeSubcommandTokens`, `ControlManagedBy`, `ControlPolicy`, `createApprovalReviewer`, `createCachedResolver`, `createInMemoryTrustScopeRegistry`, `CreatePermissionInspectorOptions`, `createPermissionStore`, `CreatePermissionStoreOptions`, `createPersistentTrustScopeRegistry`, `createTwoLayerManager`, `CwdPort`, `decideBranchOnly`, `DEFAULT_FILE_SYSTEM_SANDBOX_POLICY`, `DEFAULT_PERMISSION_PROFILE`, `DEFAULT_PROTECTED_BRANCHES`, `defaultCwdPort`, `defaultOsPort`, `defaultProjectOverlayPath`, `defaultStateFilePath`, `defaultTrustScopeStatePath`, `DENIAL_LIMITS`, `DenialMemory`, `DenialPrecedenceConflictError`, `DenialRecord`, `DenialState`, `EffectiveAccessResult`, `emitPermissionDecision`, `emitPostDenialEvent`, `evaluate`, `evaluateAuto`, `evaluateStack`, `EvaluateStackOptions`, `FallThroughReason`, `FileSystemAccess`, `FileSystemEntry`, `FileSystemPath`, `FileSystemPolicyType`, `FileSystemSandboxPolicy`, `finalDecisionFor`, `getDefaultPermissionStore`, `getDenialRecord`, `getHostMode`, `getPermissionInspector`, `getPermissionRecorder`, `getThreadPermission`, `GitPort`, `gitWriteProtectReason`, `GitWriteProtectReason`, `grantAndCascade`, `grantPatterns`, `hardDenyReason`, `hasPostDenialOverride`, `HITLTier`, `HostAgentMode`, `hostAllowsMutation`, `inferApprovalPolicy`, `inferControlPolicy`, `inferNetworkPolicy`, `inferReviewKind`, `inferSandboxPolicy`, `inferSuggestedAllowlistEntry`, `inferToolTier`, `InspectAction`, `inspectPermission`, `InspectToolMeta`, `isAdmissible`, `isAllowed`, `isDecisionLegalFor`, `isExecutionBlocking`, `isGitWriteProtected`, `isPermissionScope`, `isSpecialPathKind`, `isTerminal`, `LearningSource`, `listHardDenyRuleDescriptors`, `MatchedHardDenyRule`, `ModePolicyMatrix`, `ModeVerdict`, `NetworkMode`, `NetworkPolicy`, `OsFamily`, `OsPort`, `OsSandboxKind`, `OutcomeInvariantError`, `PatternGrantStore`, `PendingPermission`, `PERMISSION_AXES`, `PERMISSION_SCOPE_PRECEDENCE_DESC`, `PermissionAxis`, `PermissionContext`, `PermissionDecidedBy`, `PermissionDecision`, `PermissionDecisionRecord`, `PermissionInspection`, `PermissionInspector`, `PermissionMode`, `PermissionOutcomeLabel`, `PermissionProfile`, `PermissionReader`, `PermissionRecorder`, `PermissionRiskLevel`, `PermissionSandboxPolicy`, `PermissionScope`, `PermissionStackContext`, `PermissionStackSource`, `PermissionState`, `PermissionStore`, `PersistentTrustScopeOptions`, `PersistentTrustScopeRecord`, `PersistentTrustScopeRegistry`, `PostDenialAction`, `PostDenialClock`, `PostDenialEventKind`, `PostDenialEventRecord`, `ReasonCode`, `reasonCodeFor`, `recordDenial`, `recordRiskSeen`, `recordUserOverride`, `requiresUserConfirmation`, `ResolutionExplanation`, `ResolutionSource`, `resolveHostId`, `resolveSpecialPath`, `ResolveSpecialPathOpts`, `reviewAction`, `ReviewContext`, `ReviewDecision`, `ReviewDecisionVerb`, `ReviewerPort`, `ReviewerTier`, `ReviewerUnavailableError`, `ReviewKind`, `setHostMode`, `setPermissionRecorder`, `setThreadPermission`, `SPECIAL_PATH_KINDS`, `SpecialPathKind`, `STAGE1_BOTH_TAIL`, `STAGE1_FAST_TAIL`, `STAGE2_THINKING_TAIL`, `stopCategoryFor`, `strongerScope`, `threadAllowsMutation`, `ThreadPermission`, `ToolAction`, `ToolActionKeyed`, `TrustScope`, `TrustScopeAction`, `TrustScopeGrant`, `TrustScopeRegistry`, `TwoLayerManager`
- Hellgate: `tests/unit/permission-otel-emit-hellgate.test.ts`

### `@/plugin-isolation` [ADR-0162]

> Plugin process isolation slice (ADR-0162). Barrel.

- Public surface: `CallOpts`, `createBunSpawner`, `DEFAULT_CALL_TIMEOUT_MS`, `DEFAULT_GRACEFUL_KILL_MS`, `DEFAULT_LIFECYCLE_POLICY`, `DEFAULT_SPAWN_TIMEOUT_MS`, `DxtError`, `DxtErrorKind`, `DxtManifest`, `DxtManifestSchema`, `HEARTBEAT_PING_METHOD`, `HEARTBEAT_PONG_METHOD`, `IsolatedProcess`, `IsolatedProcessSpawnerPort`, `IsolatedSpawnError`, `launchDxt`, `LifecycleError`, `LifecycleOpts`, `LifecyclePolicy`, `LifecycleState`, `MAX_DXT_MANIFEST_BYTES`, `MAX_MESSAGE_BYTES`, `PluginHost`, `PluginHostError`, `PluginHostOpts`, `PluginLifecycleManager`, `SpawnOpts`, `validateDxt`
- Hellgate: `tests/unit/plugin-isolation-spawner-hellgate.test.ts`

### `@/reactor` [ADR-0132]

> Public seam for `@/reactor` — ADR-0132 autonomous proactive reactor. Only ports + factory functions are exported. Internal helpers (snippet clamps, in-memory stores) stay module-local; the composition root binds the production adapters a...

- Public surface: `AgentLoopPort`, `ALL_TRIGGER_REASONS`, `CiTriggerOpts`, `ClockPort`, `createCiTriggerSource`, `createInMemorySeenRuns`, `createInMemoryWatermarkStore`, `createPrCommentTriggerSource`, `EnvPort`, `GhCliPort`, `GhCliResult`, `injectSimulatedTurn`, `LastTurnOutcome`, `PrCommentTriggerOpts`, `ProactiveTrigger`, `QUIET_WINDOW_MS`, `REACTOR_ENV_FLAG`, `ReactorSelfWakeEvent`, `SeenRunsStore`, `SelfWakeOpts`, `SelfWakeResult`, `TriggerEvidence`, `TriggerReason`, `TriggerSourcePort`, `WatermarkStore`
- Hellgate: _(none)_

### `@/retrieval` [ADR-0159]

> `@/retrieval` slice barrel — ADR-0159. Five axes, exposed as a single surface so assemblers in `@/agent` wire one import path. Adapters live INSIDE the slice (every adapter is "compose vendor X with our generic port" — no slice-isolation...

- Public surface: `Bm25SecondaryOptions`, `BUCKET_TOKENS`, `CandidateTier`, `ChunkBucket`, `ChunkBucketOptions`, `CohereEmbedderOptions`, `CommitEmbedder`, `CommitEmbedderOptions`, `CommitNote`, `CommitNoteWithEmbedding`, `createBm25SecondaryReranker`, `createCohereEmbedder`, `createCommitEmbedder`, `createGeminiEmbedder`, `createMoonshotEmbedder`, `createNvidiaEmbedder`, `createOpenAIEmbedder`, `createTierAwareReranker`, `createVoyageEmbedder`, `createXaiEmbedder`, `createZaiEmbedder`, `DEFAULT_OVERLAP_RATIO`, `DEFAULT_TIER_PENALTY`, `EmbeddingAdapterOptions`, `EmbeddingPort`, `EmbeddingsHttp`, `EmbeddingVendor`, `fuseByRrf`, `GeminiEmbedderOptions`, `GitLogPort`, `HybridQueryInput`, `identityReranker`, `MoonshotEmbedderOptions`, `NvidiaEmbedderOptions`, `OpenAIRetrievalEmbedderOptions`, `QueryType`, `rechunk`, `RerankerKind`, `RerankInput`, `RerankPort`, `RerankRegistry`, `RetrievalCandidate`, `RetrievalError`, `RRF_K`, `rrfReranker`, `runHybridQuery`, `TierAwareOptions`, `TierClassifierPort`, `TokenizerPort`, `VoyageEmbedderOptions`, `VoyageHttp`, `XaiEmbedderOptions`, `ZaiEmbedderOptions`
- Hellgate: `tests/unit/retrieval-embedding-multi-vendor-hellgate.test.ts`

### `@/rules` [ADR-0031]

> Prefix-rule allowlist DSL — barrel. This slice is consumed by the admissibility-gate (per ADR-0031). Callers SHOULD import from `./index` (or `@/rules` when the path alias is added) and NOT reach into individual sub-modules — the barrel ...

- Public surface: `matchCommand`, `MatchOutcome`, `parseRules`, `Rule`, `RuleAction`, `RuleConflictError`, `RuleLayer`, `RuleParseError`, `RulesSnapshot`, `RulesStore`
- Hellgate: _(none)_

### `@/runner`

> `@/runner` — surface-agnostic Layer-2 orchestration slice. Contains: - `assemble/` — typed-config → built collaborators (LLM, Store, Memory, …). Input is plain config objects; NO `process.env` / `argv` reading. Surface entry (CLI/Web/Tau...

- Public surface: _(none parsed)_
- Hellgate: _(none)_

### `@/runtime`

> (no description)

- Public surface: `__resetShellSandbox`, `createPersistentWorktree`, `DEFAULT_ENV_ALLOWLIST`, `DEFAULT_SANDBOX_EXEC_PATH`, `DockerSandbox`, `DockerSandboxOptions`, `escalatingKill`, `EscalatingKill`, `getShellSandbox`, `GuardedSpawnHooks`, `installShellSandbox`, `isGitRepo`, `isTransientWorktreeLockError`, `KILL_GRACE_MS`, `KillableChild`, `LocalSandbox`, `MAX_WORKTREE_LOCK_RETRIES`, `OsSandboxPolicy`, `OsSandboxProfile`, `PersistentWorktree`, `removeWorktree`, `runShell`, `RunShellEvent`, `runShellExeca`, `runWorktreeAddWithRetry`, `Sandbox`, `SandboxPolicy`, `SandboxPolicyError`, `SandboxUnavailableError`, `scrubEnv`, `ShellOptions`, `ShellResult`, `ShellSandboxSlot`, `withSpawnedChild`, `withWorktree`, `WORKTREE_LOCK_BACKOFF_MS`, `WorktreeForkError`, `WrappedShellArgv`, `wrapShellArgv`
- Hellgate: _(none)_

### `@/scheduler` [ADR-0161]

> ADR-0161 — Scheduled agent slice barrel. Re-exports the closed-port types, parsers, evaluator, store, model reroute, and runtime. Importers MUST go through this barrel; reaching into `@/scheduler/*` deep paths is allowed for adapter wiri...

- Public surface: `AgentLoopPort`, `ALL_AUTOMATION_STATUSES`, `ALL_FREQUENCIES`, `ALL_WEEKDAYS`, `allOccurrencesInMonth`, `Automation`, `AutomationStatus`, `AutomationStoreError`, `AutomationStorePort`, `chooseModel`, `ChooseModelOpts`, `ChooseModelResult`, `ClockPort`, `computeNextFire`, `createAutomation`, `CreateAutomationInput`, `createSchedulerRuntime`, `daysInUtcMonth`, `DEFAULT_TICK_INTERVAL_MS`, `defaultJsonlAutomationStore`, `EnvPort`, `Frequency`, `isFireEligible`, `iterateFires`, `JsonlAutomationStoreOpts`, `markError`, `ModelAvailabilityPort`, `ModelRerouteReason`, `nthWeekdayOfMonth`, `parseRRule`, `parseWeekday`, `recordFire`, `RRule`, `RRuleParseError`, `RRuleParseErrorCode`, `RRuleParseResult`, `SCHEDULER_ENV_FLAG`, `SchedulerEvent`, `SchedulerRuntime`, `SchedulerRuntimeOpts`, `SchedulerSinkPort`, `serializeRRule`, `serializeWeekday`, `transitionStatus`, `Weekday`, `WeekdayDay`
- Hellgate: `tests/unit/scheduler-rrule-parser-hellgate.test.ts`

### `@/security` [ADR-0078]

> Security module barrel (ADR-0078). Public surface for the agent loop and dispatch seam to consume.

- Public surface: `assertKindWired`, `classifyCommandShape`, `classifyPath`, `NormalizedRedactionConfig`, `normalizeRedactionConfig`, `REDACTION_DISABLED_WITHOUT_ACK_MESSAGE`, `RedactionConfig`, `RedactionConfigError`, `RedactionHit`, `RedactionKind`, `RedactionOrigin`, `RedactOptions`, `RedactResult`, `redactSecrets`, `SensitivityClass`
- Hellgate: _(none)_

### `@/session` [ADR-0034]

> Session slice — id-addressable persistence (V2 schema). NEW rail alongside `src/agent/state.ts` (V1, path-based). V1 stays exactly as-is for legacy callers; new flows mint an opaque id and use this slice. Layout on disk: <root>/<id>.json...

- Public surface: `AnySessionExportEnvelope`, `appendEnvelope`, `appendSessionLine`, `ApprovalModeSchema`, `ApprovalPolicySchema`, `ApprovalPolicyStructSchema`, `archivedFilePath`, `archivedFilePathAsync`, `archiveSession`, `assignMessageIds`, `CollaborationModeSchema`, `ControlManagedBySchema`, `ControlPolicySchema`, `decodeSessionLine`, `defaultSessionRootProvider`, `deleteSession`, `EffortSchema`, `encodeSessionLine`, `EnvelopeDecodeError`, `EnvelopeDecodeErrorKind`, `EventMsgRecord`, `EventMsgRecordSchema`, `exportSession`, `exportSessionToFile`, `exportSessionToJson`, `FileSystemAccessSchema`, `FileSystemEntrySchema`, `FileSystemPathSchema`, `FileSystemPolicyTypeSchema`, `FileSystemSandboxPolicySchema`, `ForkOptions`, `ForkResult`, `forkSession`, `forkSessionAtMessage`, `importSession`, `importSessionFromFile`, `importSessionFromJson`, `indexFilePath`, `indexFilePathAsync`, `iterateSessionFile`, `listSessions`, `loadSessionById`, `NetworkModeSchema`, `NetworkPolicySchema`, `OsSandboxKindSchema`, `PermissionProfileField`, `PermissionProfileFieldSchema`, `PermissionProfileSchema`, `PermissionProfileStructSchema`, `removeFromIndex`, `renameSession`, `resolveMessageIdPrefix`, `ResponseItemKindSchema`, `ResponseItemRecord`, `ResponseItemRecordSchema`, `RewindGitPort`, `RewindOptions`, `RewindResult`, `rewindSession`, `rewindToMessage`, `SandboxPolicySchema`, `SandboxPolicyStructSchema`, `sanitizeId`, `SavedSession`, `SavePayload`, `saveSessionById`, `SESSION_ENVELOPE_VERSION`, `SESSION_VERSION`, `sessionEnvelopePath`, `sessionEnvelopePathAsync`, `SessionEnvelopeRecord`, `SessionEnvelopeRecordSchema`, `SessionExportEnvelope`, `SessionExportEnvelopeV2`, `SessionExportOpts`, `sessionFilePath`, `sessionFilePathAsync`, `SessionIdError`, `SessionImportError`, `SessionImportErrorCode`, `SessionImportOpts`, `SessionImportResult`, `SessionMeta`, `SessionMetaRecord`, `SessionMetaRecordSchema`, `SessionRootProvider`, `sessionsRoot`, `sessionsRootAsync`, `SpecialPathKindSchema`, `staticSessionRootProvider`, `SUPPORTED_SESSION_ENVELOPE_VERSIONS`, `ThreadRoleSchema`, `ThreadSpawnRecord`, `ThreadSpawnRecordSchema`, `TruncationPolicySchema`, `TurnContextRecord`, `TurnContextRecordSchema`, `unarchiveSession`, `upsertMeta`
- Hellgate: `tests/unit/session-import-export-v2-hellgate.test.ts`

### `@/shared`

> (no description)

- Public surface: `__resetRuntimeConfig`, `ALL_HITL_TIERS`, `assertNever`, `byteCompare`, `DegradedData`, `err`, `errMessage`, `HITLTier`, `Id`, `isTrajectoryEvent`, `levelEnabled`, `LLMError`, `LLMErrorKind`, `LLMProvider`, `LlmUsageData`, `LOG_LEVEL_ORDER`, `LOG_LEVELS`, `logger`, `LogLevel`, `makeEvent`, `MakeEventOpts`, `ok`, `omitUndef`, `PatchData`, `PermissionDeniedError`, `Producer`, `QuantaError`, `Redaction`, `REDACTION_POLICY`, `redactValue`, `Result`, `RunContext`, `runtimeConfig`, `RuntimeConfig`, `SandboxData`, `ShellExecEvent`, `ShellExecObserver`, `SWEBENCH_CACHE_LEVELS`, `SwebenchCacheLevel`, `toError`, `ToolExecutionError`, `ToolInputError`, `ToolResultData`, `TRAJECTORY_SCHEMA`, `TrajectoryEvent`, `TrajectoryKind`, `VerifyData`
- Hellgate: _(none)_

### `@/skill`

> Skill slice (T1.C) — faithful-minimal port of Claude Code v2's skill system. Self-contained: this slice MUST NOT import @/agent. Public seams: - {@link Skill} / {@link ParsedFrontmatter} / {@link SkillEffort} (types) - {@link parseFrontm...

- Public surface: `AddTestsTrigger`, `AdminPolicy`, `AdminPolicyReader`, `AdminPolicySchema`, `appendAuditEntry`, `AuditClock`, `AuditEntry`, `AuditEvent`, `auditLogPathFor`, `AuditWriter`, `BabysitTrigger`, `bannedSkillNames`, `BlameSectionTrigger`, `buildAuditEntry`, `buildSkillRegistry`, `createFsAdminPolicyReader`, `createSkillTool`, `createToolSearchTool`, `DEBUG_ERROR_SKILL_NAME`, `DEBUG_TRACE_SKILL_NAME`, `DebugErrorTrigger`, `DebugTraceTrigger`, `decideInstall`, `defaultAdminPolicyReader`, `defaultSkillSources`, `discoverSkills`, `discoverSystemSkills`, `EXPLAIN_CODE_SKILL_NAME`, `EXPLAIN_STACK_TRACE_SKILL_NAME`, `ExplainCodeTrigger`, `ExplainStackTraceTrigger`, `EXTRACT_FUNCTION_SKILL_NAME`, `ExtractFunctionTrigger`, `findAddTestsSkill`, `findBabysitSkill`, `findBlameSectionSkill`, `findDebugErrorSkill`, `findDebugTraceSkill`, `findExplainCodeSkill`, `findExplainStackTraceSkill`, `findExtractFunctionSkill`, `findFixMergeConflictsSkill`, `findGetPrCommentsSkill`, `findGitLogSearchSkill`, `findLocalizeFaultSkill`, `findLoopOnCiSkill`, `findMakePrEasyToReviewSkill`, `findNewBranchAndPrSkill`, `findProgressAuditSkill`, `findPrReviewCanvasSkill`, `findReviewAndShipSkill`, `findRewindSkill`, `FIX_MERGE_CONFLICTS_SKILL_NAME`, `FixMergeConflictsTrigger`, `GET_PR_COMMENTS_SKILL_NAME`, `GetPrCommentsTrigger`, `GIT_LOG_SEARCH_SKILL_NAME`, `GitLogSearchTrigger`, `InstallAttempt`, `InstallDecision`, `isSkillInstallState`, `isSkillScope`, `loadAdminPolicy`, `LoadedAdminPolicy`, `LOCALIZE_FAULT_SKILL_NAME`, `LocalizeFaultTrigger`, `LOOP_ON_CI_SKILL_NAME`, `LoopOnCiTrigger`, `MAKE_PR_EASY_TO_REVIEW_SKILL_NAME`, `MakePrEasyToReviewTrigger`, `matchesAnyGlob`, `MAX_GLOB_LEN`, `MAX_PATH_LEN`, `memoryAuditWriter`, `MemoryAuditWriter`, `migrateClaudeSkillsToQuanta`, `MigrationEntry`, `MigrationFs`, `MigrationOptions`, `MigrationReport`, `NEW_BRANCH_AND_PR_SKILL_NAME`, `NewBranchAndPrTrigger`, `nodeAuditWriter`, `nodeMigrationFs`, `parseAdminPolicy`, `ParsedFrontmatter`, `parseFrontmatter`, `PR_REVIEW_CANVAS_SKILL_NAME`, `PROGRESS_AUDIT_SKILL_NAME`, `ProgressAuditTrigger`, `PrReviewCanvasTrigger`, `requiredAdminSkillNames`, `resetAuditSeqForTesting`, `REVIEW_AND_SHIP_SKILL_NAME`, `ReviewAndShipTrigger`, `REWIND_SKILL_NAME`, `RewindTrigger`, `scopingNote`, `Skill`, `SKILL_INSTALL_STATES`, `SKILL_SCOPES`, `SKILL_SCOPES_PRECEDENCE_DESC`, `SkillEffort`, `skillEffortOverride`, `SkillInstallState`, `skillModelOverride`, `SkillRegistry`, `SkillRegistryCollision`, `SkillRegistryEntry`, `SkillRegistryOptions`, `skillsActivatedFor`, `skillScope`, `SkillScope`, `SkillSource`, `SkillSourceInputs`, `skillToolAllowlist`, `systemAuditClock`, `systemSkillsDir`, `triggerAddTests`, `triggerBabysit`, `triggerBlameSection`, `triggerDebugError`, `triggerDebugTrace`, `triggerExplainCode`, `triggerExplainStackTrace`, `triggerExtractFunction`, `triggerFixMergeConflicts`, `triggerGetPrComments`, `triggerGitLogSearch`, `triggerLocalizeFault`, `triggerLoopOnCi`, `triggerMakePrEasyToReview`, `triggerNewBranchAndPr`, `triggerProgressAudit`, `triggerPrReviewCanvas`, `triggerReviewAndShip`, `triggerRewind`, `validateAdminPolicy`
- Hellgate: _(none)_

### `@/storage` [ADR-0108]

> (no description)

- Public surface: `DEFAULT_SHADOW_ODB_MAX_BYTES`, `defaultFileSystemPort`, `defaultShadowOdb`, `deleteFile`, `evictLru`, `fileExists`, `FileInfo`, `FileSystemPort`, `FsJailError`, `JailedPath`, `parentDir`, `readFile`, `renameFile`, `resolveJailed`, `resolvePath`, `RewindOptions`, `SHADOW_LAST_REF`, `SHADOW_LAST_VERIFIED_REF`, `SHADOW_PRE_REWIND_REF_PREFIX`, `ShadowInitResult`, `ShadowOdb`, `ShadowOdbConfig`, `ShadowOdbError`, `ShadowOdbErrorCode`, `SnapshotMetadata`, `statFile`, `workspaceHash`, `writeFile`
- Hellgate: _(none)_

### `@/stream`

> (no description)

- Public surface: `AgentEvent`, `applyRetention`, `ApplyRetentionOpts`, `ApplyRetentionResult`, `AssistantTextPainter`, `DegradedRecord`, `inspectRetentionState`, `JsonlRecorder`, `JsonlRecorderOpts`, `JsonlRecorderRetentionBusyError`, `PlanDeltaKindMirror`, `PlanDeltaReadonlyMirror`, `PlanReadonlyMirror`, `RetentionPolicy`, `SseStream`, `StdoutStream`, `StdoutStreamOptions`, `StreamPort`, `TeeStream`, `TeeStreamOpts`, `TodoReadonlyMirror`, `TodoStatusMirror`
- Hellgate: _(none)_

### `@/subagent`

> Subagent slice — public API. Wire-up the main thread (the only allowed cross-importer, via @/agent) does: const agentTool = createAgentTool({ runner, maxDepth: 3 }) const taskRegistry = agentTool.registry // merge into a fresh ToolRegist...

- Public surface: `AgentToolOptions`, `createAgentTool`, `createTaskOutputTool`, `createTaskStopTool`, `dispatchSubagent6`, `handleCloseAgent`, `handleExecCommand`, `handleSendInput`, `handleSpawnAgent`, `handleWaitAgent`, `handleWriteStdin`, `InputChannelRegistry`, `isSubagent6Tool`, `MAX_PTY`, `PtyTable`, `SUBAGENT_6_TOOL_CONTRACTS`, `SUBAGENT_6_TOOL_NAMES`, `Subagent6Deps`, `Subagent6ToolName`, `SubagentRequest`, `SubagentResult`, `SubagentRunner`, `TaskBudget`, `TaskKind`, `TaskRecord`, `TaskRegistry`, `TaskRegistryOptions`, `TaskStatus`
- Hellgate: `tests/unit/subagent-6-tools-hellgate.test.ts`

### `@/tool` [ADR-0142]

> (no description)

- Public surface: `applyPatchTool`, `BackgroundSubagentSchedulerPort`, `BlockerSurface`, `buildDefaultTools`, `buildPlanTools`, `classifyFrame`, `composeShellObservers`, `composeToolResultContent`, `createPlanTool`, `createUpdateWorkingStateTool`, `defaultGhRunner`, `defaultGitRunner`, `DefaultToolPorts`, `defaultTools`, `DeferredHandle`, `DeferredResultRegistry`, `DeferredToolResult`, `defineTool`, `DefineToolSpec`, `DiagnosticItem`, `DiagnosticsProvider`, `DiagnosticsSession`, `diagnosticsTool`, `driveStreamingInput`, `enforceOutputSchema`, `FailureFrame`, `fileTreeSummaryTool`, `formatDiagnostics`, `FrameTier`, `FsJailViolationError`, `GhRunner`, `ghTools`, `gitBlameHeatmapTool`, `GitBlameInput`, `gitBlameTool`, `GitBranchSwitchInput`, `gitBranchSwitchTool`, `gitChurnTool`, `GitCommitInput`, `gitCommitTool`, `gitConflictInspectTool`, `GitDiffInput`, `gitDiffTool`, `GitLogInput`, `gitLogTool`, `gitMovedCodeTool`, `GitRunner`, `GitRunResult`, `GitStatusInput`, `gitStatusTool`, `gitTools`, `GitUpstreamCheckInput`, `gitUpstreamCheckTool`, `GitWriteGuard`, `HITLTier`, `htmlToMarkdown`, `inferNextAction`, `LspNavProvider`, `LspNavSession`, `lspNavTools`, `NavHover`, `NavLocation`, `NavPos`, `NavRange`, `NavRenamePreview`, `NavSymbolInfo`, `NavSymbolKind`, `NextAction`, `noopShellObserver`, `nullDiagnosticsProvider`, `nullLspNavProvider`, `parseTestFailure`, `parseTestFailureTool`, `PlanDeltaKind`, `planErrorMessage`, `PlanExitRequester`, `PlanExitToolDecision`, `PlanExitToolOutcome`, `planFailure`, `PlanMutationErrorCode`, `PlanMutationResult`, `PlanMutator`, `PlanMutatorNewTodo`, `PlanMutatorTodoPatch`, `PlanReadonlyView`, `rankBlame`, `rankChurn`, `READ_IMAGE_MAX_BYTES`, `READ_IMAGE_SUPPORTED_MEDIA_TYPES`, `ReadImageInput`, `readImageInputSchema`, `ReadImageSupportedMediaType`, `readImageTool`, `ReadImageUrlInput`, `readImageUrlInputSchema`, `readImageUrlTool`, `removeTodosTool`, `renderModelOutput`, `requestPlanExitTool`, `requestUserInputTool`, `ShadowRestorePartialInput`, `shadowRestorePartialInputSchema`, `shadowRestorePartialTool`, `ShadowRewindInput`, `shadowRewindInputSchema`, `shadowRewindTool`, `ShadowSnapshotsInput`, `shadowSnapshotsInputSchema`, `shadowSnapshotsTool`, `shadowTools`, `ShellExecEvent`, `ShellExecObserver`, `sniffMediaType`, `StreamingInputStep`, `SubagentAwaitInput`, `subagentAwaitInputSchema`, `subagentAwaitTool`, `SubagentBgHandleId`, `SubagentBgResult`, `SubagentBgSpec`, `SubagentBgStatus`, `subagentBgTools`, `SubagentForkInput`, `subagentForkInputSchema`, `subagentForkTool`, `SubagentPollInput`, `subagentPollInputSchema`, `subagentPollTool`, `Tool`, `ToolContext`, `ToolEvent`, `ToolFailure`, `ToolRegistry`, `ToolResult`, `ToolResultContent`, `ToolResultEvidence`, `ToolSpec`, `UnknownDeferredHandleError`, `updatePlanTool`, `updateTodosTool`, `UserInputOutcome`, `UserInputRequester`, `validateToolOutput`, `WEB_FETCH_DEFAULT_MAX_BYTES`, `WEB_FETCH_MAX_BYTES_CEILING`, `WEB_FETCH_MAX_OUTPUT`, `WEB_SEARCH_DEFAULT_LIMIT`, `WEB_SEARCH_MAX_LIMIT`, `WEB_SEARCH_QUERY_MAX`, `WEB_SEARCH_SNIPPET_MAX`, `WebFetchInput`, `webFetchInputSchema`, `WebFetchOptions`, `webFetchTool`, `WebSearchHit`, `WebSearchInput`, `webSearchInputSchema`, `WebSearchProvider`, `webSearchTool`, `WorkingStateHandle`, `WorkingStatePatch`, `WorkingStateSnapshot`
- Hellgate: `tests/unit/tool-output-schema-hellgate.test.ts`

### `@/ui`

> `src/ui` slice — surface-agnostic UI helpers. Pure string / ANSI / box-drawing utilities that any surface (CLI, REPL, embedded browser, Tauri renderer) can compose. No I/O is performed by this slice; callers own writing the rendered stri...

- Public surface: _(none parsed)_
- Hellgate: _(none)_

## ADR catalogue by plane (216 entries, 191 distinct numbers)

### Domain / Ports (12)

- [ADR-0023](./decisions/0023-sota-codex-integration-byte-identical.md) **SOTA++ Codex absorption: integration + byte-identical invariant** — Unknown
- [ADR-0060](./decisions/0060-tool-output-schema-factory.md) **defineTool — output-schema + toModelOutput + deferred + streaming-input (v0.dev `createProviderToolFactoryWithOutputSchema` 흡수)** — Accepted _(2026-05-21)_ — related: ADR-0016
- [ADR-0096](./decisions/0096-plan-store-port-and-slice-isolation.md) **PlanStore port + ToolContext duck-typed PlanMutator seam (slice isolation)** — Accepted _(2026-05-23)_
- [ADR-0097](./decisions/0097-request-user-input-port.md) **`request_user_input` host port (ADR-0086 자매)** — Accepted _(2026-05-23)_
- [ADR-0127](./decisions/0127-web-tool-slice.md) **`web_fetch` + `web_search` tool slice (web 가용성 갭 봉합)** — Accepted _(2026-05-24)_ — related: ADR-0125, ADR-0126
- [ADR-0147](./decisions/0147-document-tools.md) **`csv_read` + `ndjson_read` document tool slice (text-format structured-data gap closure)** — Accepted _(2026-05-24)_ — related: ADR-0126, ADR-0125, ADR-0127
- [ADR-0159](./decisions/0159-retrieval-sota-stack.md) **Retrieval SOTA stack — reranker registry, token-bucket re-chunker, commit-embedding, multi-vendor embedding port, hybrid query** — Accepted _(2026-05-25)_ — related: ADR-0130, ADR-0144, ADR-0138
- [ADR-0162](./decisions/0162-plugin-process-isolation.md) **Plugin process isolation — DXT UtilityProcess pattern (5s spawn timeout + 5s SIGTERM grace)** — Accepted _(2026-05-24)_ — related: ADR-0039, ADR-0007, ADR-0136, ADR-0135
- [ADR-0172](./decisions/0174-tool-call-dedup.md) **Tool-call collapse / dedup — closed-port `ToolCallCache` with `[from_cache]` model-transparency marker** — Accepted _(2026-05-25)_ — related: ADR-0144, ADR-0160, ADR-0161, ADR-0167
- [ADR-0176](./decisions/0176-tool-call-dedup.md) **Tool-call collapse / dedup — closed-port `ToolCallCache` with `[from_cache]` model-transparency marker** — Accepted _(2026-05-25)_ — related: ADR-0144, ADR-0160, ADR-0161, ADR-0167
- [ADR-0178](./decisions/0178-mid-turn-interruption.md) **Mid-turn user interruption — capture facade over `PlanQueueStore` with 3-arm mode + `InterruptionPolicy` port** — Accepted _(2026-05-25)_ — related: ADR-0128, ADR-0177
- [ADR-0190](./decisions/0190-test-harness-consolidation.md) **Test harness consolidation — shared slice-boundary scanner + parity tables** — Unknown

### Application / Orchestration (40)

- [ADR-0007](./decisions/0007-mcp-slice.md) **MCP 클라이언트를 신규 슬라이스로 추가하고 agent에서 브리지** — Accepted _(2026-05-19)_ — related: ADR-0001
- [ADR-0018](./decisions/0018-mode-enum-plan-review-audit.md) **Mode enum: default / plan / review / audit** — Unknown
- [ADR-0020](./decisions/0020-hitl-4tier-gate.md) **HITL: 4-tier confirmation gate** — Unknown
- [ADR-0021](./decisions/0021-memory-5layer-workingstate.md) **Memory 5-layer: artifact rail + WorkingState L3** — Unknown
- [ADR-0022](./decisions/0022-skill-trigger-tool-routing.md) **Skill trigger rules + tool routing matrix** — Unknown
- [ADR-0034](./decisions/0034-session-jsonl-envelope.md) **Session JSONL envelope (5 top-level types + 17 turn_context fields + v3 subagent linkage)** — Accepted _(2026-05-21)_ — related: ADR-0015, ADR-0023
- [ADR-0036](./decisions/0036-plan-mode-dispatch-seam-block.md) **Plan vs Default collaboration mode — dispatch-seam mutating block** — Accepted _(2026-05-21)_ — related: ADR-0018
- [ADR-0038](./decisions/0038-external-agent-import.md) **External-agent import 4-stage lifecycle** — Accepted _(2026-05-21)_
- [ADR-0040](./decisions/0040-skills-vs-extensions-split.md) **Skills vs Extensions split + SKILL.md frontmatter** — Accepted _(2026-05-21)_ — related: ADR-0022, ADR-0039
- [ADR-0041](./decisions/0041-subagent-6-tool-standard.md) **Subagent 6-tool 표준 (exec_command / write_stdin / spawn_agent / wait_agent / close_agent / send_input)** — Accepted _(2026-05-21)_ — related: ADR-0015
- [ADR-0045](./decisions/0045-progress-audit-system-skill.md) **progress-audit system skill (bundled, code-evidence audit discipline)** — Accepted _(2026-05-21)_ — related: ADR-0011
- [ADR-0047](./decisions/0047-hitl-4-tier-gate.md) **HITL 4-tier gate: annotation registry + handoff seam** — Accepted _(2026-05-21)_
- [ADR-0055](./decisions/0055-awf-tool-matcher-hook-channel.md) **AWF 2-matcher PreToolUse hook channel** — Accepted _(2026-05-21)_ — related: ADR-0013
- [ADR-0058](./decisions/0058-anthropic-beta-headers-and-skill-size-cap.md) **Anthropic beta channels + 30 MB skill size cap** — Accepted _(2026-05-21)_ — related: ADR-0002, ADR-0022
- [ADR-0063](./decisions/0063-plan-exit-three-way.md) **Plan 모드 3-way exit (approve / reject / request-changes) (v0.dev 흡수)** — Accepted _(2026-05-21)_ — related: ADR-0036
- [ADR-0068](./decisions/0068-codex-2-phase-memory-consolidator.md) **Codex 2-Phase memory consolidator (SOTA++ v2)** — Accepted _(2026-05-21)_
- [ADR-0072](./decisions/0072-submission-op-envelope.md) **Submission op envelope — host→agent 입력의 타입드 봉투 (Codex 흡수, Spec A3)** — Accepted _(2026-05-21)_ — related: ADR-0030, ADR-0011
- [ADR-0075](./decisions/0075-pre-compact-hitl-and-summary-archive.md) **Pre-Compact HITL + ConversationSummaryArchive (Cursor 흡수)** — Accepted _(2026-05-21)_ — related: ADR-0011, ADR-0034, ADR-0048
- [ADR-0086](./decisions/0086-request-plan-exit-tool.md) **request_plan_exit tool — plan-exit 3-way wire** — Accepted _(2026-05-22)_ — related: ADR-0063, ADR-0036
- [ADR-0088](./decisions/0088-phasegate-hitl-ladder.md) **PhaseGate HITL feedback ladder (Cursor AiProjectService 흡수)** — Proposed (design-only — 구현은 후속 라운드) _(2026-05-22)_ — related: ADR-0063, ADR-0047, ADR-0036, ADR-0026
- [ADR-0090](./decisions/0090-declarative-automation.md) **Declarative event-triggered agent automation (`trigger → agentic filter → agent spawn → run record`)** — Proposed (design draft — NO implementation; default-OFF seam intended, byte-identical when unwired) _(2026-05-22)_ — related: ADR-0049, ADR-0041, ADR-0068
- [ADR-0095](./decisions/0095-plan-mode-structured-tools.md) **Structured plan-mode tools (data model + 4 tools + 6 events)** — Accepted _(2026-05-23)_
- [ADR-0111](./decisions/0111-git-skill-bundle.md) **CTK git-skill bundle (8 system skills, Cursor cursor-team-kit absorption)** — Accepted _(2026-05-23)_
- [ADR-0112](./decisions/0112-git-review-diff-isolated.md) **`git_review_diff` — isolated diff reviewer sub-agent (Claude Desktop `reviewDiff` 흡수)** — Accepted _(2026-05-23)_
- [ADR-0113](./decisions/0113-hook-updated-input.md) **`pre_tool_use` hook `updatedInput` (Cursor parity)** — Accepted _(2026-05-23)_ — related: ADR-0013, ADR-0026, ADR-0055
- [ADR-0119](./decisions/0119-shadow-rewind-tool-exposure.md) **`shadow_rewind` + `shadow_snapshots` 첫-class agent tool 노출** — Accepted (2026-05-24)
- [ADR-0122](./decisions/0122-shadow-odb-rewind-extensions.md) **ShadowOdb rewind extensions — per-file restore + verified anchor + /rewind skill** — Accepted (2026-05-24)
- [ADR-0128](./decisions/0128-plan-queue.md) **Plan-queue helper — Codex mid-turn follow-up queue as a typed primitive** — Accepted _(2026-05-24)_ — related: ADR-0123, ADR-0124, ADR-0125, ADR-0030, ADR-0037
- [ADR-0131](./decisions/0131-memory-outcome-and-preference-grammar.md) **Memory hygiene: 4-state outcome enum + preference phrase grammar + 10% phase2 promotion** — Proposed (2026-05-24, W1 of [[0130-extracted-source-absorption-roadmap]])
- [ADR-0132](./decisions/0132-autonomous-proactive-reactor.md) **Autonomous proactive reactor: SIMULATED_MSG_REASON + cloud-agent branch snapshot 사다리** — Proposed (2026-05-24, W2 of [[0130-extracted-source-absorption-roadmap]])
- [ADR-0133](./decisions/0133-hook-bidirectional-rpc.md) **Hook bidirectional Request/Response RPC paired (6 lifecycle events + prompt_hook injection)** — Proposed (2026-05-24, W3 of [[0130-extracted-source-absorption-roadmap]])
- [ADR-0134](./decisions/0134-skill-scope-tiering.md) **Skill 7-scope tiering (builtIn / system / admin / team / repo / user / personal) + admin-enforced install** — Proposed (2026-05-24, W4 of [[0130-extracted-source-absorption-roadmap]])
- [ADR-0140](./decisions/0140-subagent-background-wire.md) **Background-subagent caller wire — ADR-0145 (renumbered from ADR-0130) helper를 loop에 노출** — Accepted (2026-05-24)
- [ADR-0145](./decisions/0145-background-subagent.md) **Background subagent scheduler — Cursor `force_background_subagent` 흡수** — Accepted _(2026-05-24)_ — related: ADR-0083, ADR-0128, ADR-0124, ADR-0125
- [ADR-0149](./decisions/0149-engineering-skills-bundle.md) **Engineering-task skill bundle (4 system skills — debug / test / explain / refactor)** — Accepted _(2026-05-24)_
- [ADR-0158](./decisions/0158-subagent-persistence.md) **Subagent persistence Phase 1 — disk-backed store + interrupted arm** — Accepted _(2026-05-24)_ — related: ADR-0145, ADR-0153, ADR-0108
- [ADR-0159](./decisions/0159-subagent-work-resume.md) **Subagent work-resume Phase 2 — interrupted-handle orchestrator** — Accepted _(2026-05-24)_ — related: ADR-0145, ADR-0153, ADR-0158
- [ADR-0161](./decisions/0161-scheduled-agent.md) **Scheduled agent — RRULE + Weekday nth-occurrence + automation lifecycle + model reroute** — Accepted _(2026-05-25)_ — related: ADR-0130
- [ADR-0166](./decisions/0166-subagent-conversation-replay.md) **Subagent conversation-seed replay (Phase 2.5)** — Accepted _(2026-05-25)_ — related: ADR-0124, ADR-0158, ADR-0159
- [ADR-0175](./decisions/0175-subagent-tool-history-replay.md) **Subagent tool-history replay (Phase 3 of ADR-0166)** — Accepted _(2026-05-25)_ — related: ADR-0124, ADR-0158, ADR-0159, ADR-0166, ADR-0108

### Infrastructure / Adapters (18)

- [ADR-0002](./decisions/0002-openai-provider.md) **OpenAI를 2번째 LLM provider로 추가** — Accepted _(2026-05-19)_
- [ADR-0010](./decisions/0010-observability-trajectory.md) **관측 플랫폼 — Trajectory 스키마 + Probe (SDK 비의존)** — Accepted _(2026-05-19)_ — related: ADR-0003, ADR-0006
- [ADR-0080](./decisions/0080-ide-context-provider-seam.md) **IDE context provider seam** — Accepted _(2026-05-21)_ — related: ADR-0030, ADR-0075, ADR-0034
- [ADR-0083](./decisions/0083-multimodal-image-input.md) **Multi-modal image input (dual-provider)** — Accepted _(2026-05-22)_ — related: ADR-0079
- [ADR-0094](./decisions/0094-chatgpt-oauth-provider.md) **ChatGPT-OAuth provider — BYOK 없이 구독계정으로 모델 호출** — Proposed (본문만, 코드/배선 follow-up 슬라이스 분해 예정)
- [ADR-0137](./decisions/0137-document-readers-extensions.md) **Document readers extensions — YAML / PDF (native attachment) / XLSX (stub)** — Accepted (yaml + pdf shipped; xlsx deferred to ADR-0138 deps decision) _(2026-05-24)_ — related: ADR-0126, ADR-0147, ADR-0133
- [ADR-0139](./decisions/0139-llm-provider-fork.md) **LLM provider fork — Anthropic 전송 4갈래(default/bedrock/vertex/foundry) 헥사고날 포트** — Accepted (2026-05-24)
- [ADR-0143](./decisions/0143-lsp-real-adapters.md) **LSP default-adapter 실배선 — code-action / format / signature-help / applyWorkspaceEdit** — Accepted (2026-05-24)
- [ADR-0148](./decisions/0148-web-search-providers.md) **Web search provider concrete impls (Brave primary + DuckDuckGo fallback)** — Accepted _(2026-05-24)_
- [ADR-0151](./decisions/0151-llm-provider-phase2.md) **LLM provider transports — Phase 2 (Bedrock + Vertex real streams)** — Unknown
- [ADR-0155](./decisions/0155-otlp-helper.md) **OTLP HTTP + Prometheus exporter wiring helpers — lazy-load + typed deps-missing error** — Accepted _(2026-05-24)_ — related: ADR-0154, ADR-0144
- [ADR-0163](./decisions/0163-foundry-future-ready.md) **Foundry transport — future-ready scaffold + npm watcher** — Unknown
- [ADR-0172](./decisions/0172-foundry-phase-2.md) **Foundry transport — Phase 2 (real stream via published SDK)** — Unknown
- [ADR-0177](./decisions/0177-csv-parse-lib-swap.md) **CSV parser — swap self-rolled tokenizer for `csv-parse@6.x`** — Unknown
- [ADR-0184](./decisions/0184-conversation-checkpoint-lru-swap.md) **Conversation checkpoint store — swap self-rolled Map+LRU for `lru-cache`** — Unknown
- [ADR-0185](./decisions/0185-file-write-atomic-lib-swap.md) **File-write — swap self-rolled atomic temp+rename for `write-file-atomic`** — Unknown
- [ADR-0186](./decisions/0186-html-to-markdown-turndown-swap.md) **HTML → Markdown — swap inline 9-stage pipeline for `turndown`** — Unknown
- [ADR-0190](./decisions/0190-darwin-vz-native-scaffold.md) **Darwin VZ native scaffold (Skybridge Phase 3.3 — napi-rs binding to Virtualization.framework)** — Accepted (Phase 3.3 scaffold — typed surface + 20-case fake-binding hellgate + workspace member; Phase 3.4 = real `VZVirtualMachine` bring-up + DMG image management + vsock IPC + AVF entitlements) _(2026-05-25)_ — related: ADR-0136, ADR-0155, ADR-0160, ADR-0175, ADR-0184

### Observability / Telemetry (24)

- [ADR-0025](./decisions/0025-git-first-class-tools.md) **Git 1급 도구 (diff/status/log/blame)** — Accepted _(2026-05-20)_ — related: ADR-0011
- [ADR-0032](./decisions/0032-otel-attribute-vocabulary.md) **OTel canonical attribute vocabulary** — Accepted _(2026-05-21)_ — related: ADR-0010
- [ADR-0074](./decisions/0074-otel-span-tree.md) **OTel span tree (Codex 10-step) — core 4-stage wrap** — Accepted (default-OFF seam; behavior-preserving) _(2026-05-21)_
- [ADR-0085](./decisions/0085-cost-cache-dashboard.md) **Cost & cache dashboard** — Accepted _(2026-05-22)_ — related: ADR-0074, ADR-0081
- [ADR-0087](./decisions/0087-eval-schema-additive.md) **eval 스키마 additive 필드 — keyed metrics / token·cost / run status·params (Cursor `EvalTrackingService` 흡수)** — Accepted _(2026-05-22)_ — related: ADR-0085
- [ADR-0105](./decisions/0105-git-env-determinism-and-machine-log.md) **Git env determinism + US-separator log format (Codex §18.7 흡수)** — Accepted _(2026-05-23)_
- [ADR-0144](./decisions/0144-observability-metrics.md) **Observability metrics — typed counter/histogram/gauge primitive over `AgentEvent` trace stream** — Accepted _(2026-05-24)_ — related: ADR-0035, ADR-0124, ADR-0138
- [ADR-0154](./decisions/0154-otel-sink.md) **OTel `MeterProvider`-backed metric sink — closed-port adapter for production export** — Accepted _(2026-05-24)_ — related: ADR-0144
- [ADR-0159](./decisions/0159-monitoring-impl-wrap-dashboard-alerts.md) **Monitoring impl — instrument wrap helpers + Grafana dashboard + alert rules + E2E coverage** — Accepted _(2026-05-24)_ — related: ADR-0144, ADR-0154, ADR-0155, ADR-0158
- [ADR-0161](./decisions/0161-monitoring-full-coverage.md) **Monitoring full coverage — LSP/PlanQueue/Budget wraps + withFullObservability + SLO doc + E2E coverage** — Accepted _(2026-05-24)_ — related: ADR-0144, ADR-0158, ADR-0159, ADR-0160
- [ADR-0162](./decisions/0162-budget-cost-histogram.md) **Budget per-event cost histogram — RecordResult shape + wrap emit** — Accepted _(2026-05-25)_ — related: ADR-0138, ADR-0161
- [ADR-0163](./decisions/0163-otel-resource-auto.md) **OTel Resource attribute auto-enrichment — opt-in helper for OTLP / Prometheus sinks** — Accepted _(2026-05-25)_ — related: ADR-0155, ADR-0154, ADR-0144, ADR-0161
- [ADR-0165](./decisions/0165-code-coverage.md) **Code coverage observability — typed V8-coverage port + branch/statement breakdown + MetricSink emission** — Accepted _(2026-05-25)_ — related: ADR-0144
- [ADR-0167](./decisions/0167-plan-queue-collapse-metric.md) **PlanQueue enqueue collapse metric — `EnqueueResult` + dedicated counter** — Accepted _(2026-05-25)_ — related: ADR-0128, ADR-0161, ADR-0144, ADR-0162
- [ADR-0170](./decisions/0170-coverage-ast-branch.md) **AST-precise branch counter — `astCoverageSource()` adapter behind the ADR-0165 `CoverageSource` port** — Accepted _(2026-05-25)_ — related: ADR-0165
- [ADR-0172](./decisions/0172-coverage-c8-swap.md) **Coverage backend — swap self-rolled V8/AST internals for `c8`** — Unknown
- [ADR-0172](./decisions/0173-git-log-search-skill.md) **git-log-search system skill (pickaxe/regex/author/since via shell git)** — Accepted _(2026-05-25)_
- [ADR-0172](./decisions/0175-observability-wired-gauge.md) **Observability wired-status gauge — `observability.wired.total{slice}` machine-readable counterpart to ADR-0169 log** — Accepted _(2026-05-25)_ — related: ADR-0144, ADR-0161, ADR-0169, ADR-0158
- [ADR-0173](./decisions/0173-coverage-istanbul-per-branch.md) **Istanbul per-branch counter — `istanbulCoverageSource()` + Istanbul-shape emitter + merge** — Accepted (Phase 3 of [ADR-0165](./0165-code-coverage.md) / [ADR-0170](./0170-coverage-ast-branch.md)) _(2026-05-25)_ — related: ADR-0165
- [ADR-0180](./decisions/0180-health-snapshot-file.md) **File-based health snapshot — `~/.quanta/health.json` JSON mirror of the wired-gauge** — Accepted _(2026-05-25)_ — related: ADR-0144, ADR-0161, ADR-0169, ADR-0172
- [ADR-0181](./decisions/0181-debug-blame-skills-trio.md) **debug/blame skills trio (debug-trace, explain-stack-trace, blame-section)** — Accepted _(2026-05-25)_
- [ADR-0186](./decisions/0186-distributed-tracing.md) **Distributed tracing — typed `Tracer` port + OTel SDK adapter + W3C propagator** — Accepted (no-op default + OTel adapter) _(2026-05-25)_ — related: ADR-0144, ADR-0154
- [ADR-0187](./decisions/0187-health-snapshot-watcher.md) **Health snapshot watcher — periodic re-emit + SIGHUP hot-reload** — Accepted _(2026-05-25)_ — related: ADR-0180, ADR-0169, ADR-0172
- [ADR-0188](./decisions/0188-bug-fix-proposal-queue.md) **Bug-fix proposal queue (debug-trace automated bug-fix loop, Phase 1)** — Accepted _(2026-05-25)_

### Security / Sandboxing (24)

- [ADR-0016](./decisions/0016-prompt-policy-ladder-budget-honesty.md) **Prompt policy: claim ladder + trust ladder + budget + honesty rail** — Unknown
- [ADR-0027](./decisions/0027-anti-signals-policy-injection-hardening.md) **Anti-signal 카탈로그 + policy-injection 적대성 게이트** — Accepted _(2026-05-20)_ — related: ADR-0004, ADR-0011
- [ADR-0031](./decisions/0031-prefix-rule-dsl.md) **Prefix-rule allowlist DSL + 3-layer precedence** — Accepted _(2026-05-21)_ — related: ADR-0020, ADR-0026
- [ADR-0043](./decisions/0043-desktop-surface-reference.md) **데스크톱 표면 reference (Seatbelt / Skybridge / microVM)** — Reference-only (코드 변경 없음) _(2026-05-21)_
- [ADR-0046](./decisions/0046-permission-stack-thread-host-postdenial.md) **Permission stack: per-thread + per-host + post-denial precedence** — Accepted _(2026-05-21)_ — related: ADR-0026
- [ADR-0050](./decisions/0050-trust-scope-wire-up-phase-c.md) **Trust-Scope Registry Wire-Up (Phase C)** — Accepted — 2026-05-21
- [ADR-0070](./decisions/0070-review-kind-permission-matrix.md) **review-kind × isExecutionBlocking × reason_code 권한 매트릭스 + scoped-allowlist 결정 verb (Cursor HITL gate 흡수)** — Accepted _(2026-05-21)_ — related: ADR-0020, ADR-0029, ADR-0030
- [ADR-0076](./decisions/0076-agent-loop-branch-hardening.md) **Agent-loop branch hardening (refusal / reasoning / submission-op / deny-and-steer)** — Accepted _(2026-05-21)_
- [ADR-0077](./decisions/0077-phase-ttft-readonly-trio.md) **Phase marker + TTFT + readonly deny-steer trio** — Accepted _(2026-05-21)_
- [ADR-0078](./decisions/0078-secret-redaction-content-plane-invariant.md) **Secret redaction as content-plane invariant** — Accepted _(2026-05-22)_
- [ADR-0091](./decisions/0091-git-write-protection.md) **git-write-protection static deny — `.git/{hooks,config}` + `.vscode` write = 코드실행 탈옥 벡터 (Cursor `cursorsandbox` 흡수)** — Accepted _(2026-05-22)_ — related: ADR-0070, ADR-0069
- [ADR-0121](./decisions/0121-auto-checkpoint-policy.md) **Auto-checkpoint policy for the shadow git ODB** — Accepted (2026-05-24)
- [ADR-0135](./decisions/0135-permission-sandbox-two-layer.md) **Permission profile + file_system_sandbox_policy 2-layer + 4-pillar Permission** — Proposed (2026-05-24, W5 of [[0130-extracted-source-absorption-roadmap]])
- [ADR-0136](./decisions/0136-os-sandbox-helper.md) **OS-level sandbox helper — Cursor `cursorsandbox` + Codex Seatbelt 흡수** — Accepted _(2026-05-24)_ — related: ADR-0006, ADR-0093, ADR-0135
- [ADR-0150](./decisions/0150-landlock-phase2.md) **Linux sandbox Phase 2 — `bwrap` (bubblewrap) shell-out adapter** — Accepted _(2026-05-24)_ — related: ADR-0136, ADR-0093, ADR-0006
- [ADR-0155](./decisions/0155-mcp-skybridge.md) **MCP Skybridge Phase 1 — typed sandbox port + passthrough adapter** — Accepted (Phase 1 — typed-port + passthrough adapter + Phase-2 stubs) _(2026-05-24)_ — related: ADR-0136, ADR-0094, ADR-0150
- [ADR-0159](./decisions/0159-linux-sandbox.md) **Linux sandbox — 2-backend auto-detect (bubblewrap + landlock-cli)** — Accepted (Phase 2 external-binary wrapper) _(2026-05-24)_ — related: ADR-0136, ADR-0150, ADR-0093, ADR-0006, ADR-0135
- [ADR-0164](./decisions/0164-secret-detection.md) **Secret-detection scanner — port + pattern + entropy + composite** — Unknown
- [ADR-0169](./decisions/0169-observability-skipped-warning.md) **Observability skipped-slice warning — opt-in operator log + `skippedExpected` allowlist** — Accepted _(2026-05-25)_ — related: ADR-0161, ADR-0144, ADR-0158
- [ADR-0171](./decisions/0171-pii-redaction.md) **PII-redaction scanner — port + pattern + Luhn + composite** — Unknown
- [ADR-0173](./decisions/0173-secret-detection-secretlint-swap.md) **Secret-detection — swap internals to secretlint** — Unknown
- [ADR-0175](./decisions/0175-linux-sandbox-native.md) **Linux sandbox Phase 3 — native Landlock + seccomp via napi-rs scaffold** — Accepted (scaffold + TS adapter; full Rust impl deferred to Phase 3.1) _(2026-05-25)_ — related: ADR-0136, ADR-0150, ADR-0159, ADR-0006
- [ADR-0184](./decisions/0184-linux-sandbox-native-impl.md) **Linux sandbox native impl (Phase 3.1 — Rust bodies + cargo build verify)** — Accepted (Phase 3.1 — Rust impl wired + workspace + cargo build success on darwin; Phase 3.2 = strict seccomp + GitHub Actions matrix + npm publish 별도 라운드) _(2026-05-25)_ — related: ADR-0136, ADR-0159, ADR-0175
- [ADR-0191](./decisions/0191-linux-sandbox-strict-mode.md) **Linux sandbox strict mode (Phase 3.2 — strict seccomp + rlimit/alarm caps)** — Accepted (Phase 3.2 — strict default-deny seccomp filter + rlimit/alarm cap wire; CI matrix + npm publish 별도 ADR — Phase 3.3 deferred) _(2026-05-25)_ — related: ADR-0136, ADR-0159, ADR-0175, ADR-0184

### Uncategorized (98)

- [ADR-0001](./decisions/0001-biome2-slice-isolation.md) **Biome 2.x로 슬라이스 경계 lint 강제** — Accepted _(2026-05-19)_
- [ADR-0003](./decisions/0003-test-pyramid.md) **테스트 피라미드를 4티어로 분리하고 CI로 강제** — Accepted _(2026-05-19)_
- [ADR-0004](./decisions/0004-prompt-cache-prefix.md) **시스템 프롬프트를 정적 프리픽스로 고정해 캐시 적중** — Accepted _(2026-05-19)_ — related: ADR-0002, ADR-0003
- [ADR-0005](./decisions/0005-skipped.md) **(의도적 결번)** — Skipped _(2026-05-19)_
- [ADR-0006](./decisions/0006-runtime-sandbox.md) **runtime 샌드박스 추상화 — Local(약식) + Docker(opt-in)** — Accepted _(2026-05-19)_ — related: ADR-0003
- [ADR-0008](./decisions/0008-sota-memory.md) **SOTA++ 계층형 시맨틱 메모리** — Accepted _(2026-05-19)_ — related: ADR-0001, ADR-0004
- [ADR-0009](./decisions/0009-lsp-diagnostics-tool.md) **LSP를 `diagnostics` 도구로 에이전트에 노출** — Accepted _(2026-05-19)_ — related: ADR-0001
- [ADR-0011](./decisions/0011-sota-cc-v2-absorption.md) **Claude Code v2 SOTA++ 흡수 (Tier 0+1)** — Accepted _(2026-05-19)_ — related: ADR-0001, ADR-0008
- [ADR-0012](./decisions/0012-retire-loc-cap.md) **전역 LoC 예산 철회** — Accepted _(2026-05-19)_ — related: ADR-0008, ADR-0011
- [ADR-0013](./decisions/0013-verify-before-finish-guard.md) **완료 전 검증 가드 (verify-before-finish)** — Accepted _(2026-05-20)_ — related: ADR-0011, ADR-0004
- [ADR-0014](./decisions/0014-bench-repair-rounds.md) **bench 외부 repair 라운드 (continue-from-patched-tree)** — Accepted _(2026-05-20)_ — related: ADR-0011, ADR-0013
- [ADR-0015](./decisions/0015-codex-foundation-turncontext.md) **Codex Foundation: TurnContext expansion + repo-local rule ingestion** — Unknown
- [ADR-0017](./decisions/0017-closeout-4rule-verification-scaffold.md) **Closeout: defended-claim 4-rule + VerificationCloseout scaffold** — Unknown
- [ADR-0019](./decisions/0019-code-mod-edit-strategy-four-surface.md) **Code modification: edit-strategy hint + scripted_replace + 4-truth-surface closeout** — Unknown
- [ADR-0024](./decisions/0024-lsp-nav-surface-expansion.md) **LSP nav surface 확장 (definition/references/hover/symbol/rename-preview)** — Accepted _(2026-05-20)_ — related: ADR-0009, ADR-0011
- [ADR-0026](./decisions/0026-admissibility-gate-ssot.md) **Admissibility-gate SSOT 추출** — Accepted _(2026-05-20)_ — related: ADR-0011, ADR-0020
- [ADR-0028](./decisions/0028-apply-patch-v4a.md) **`apply_patch` V4A format + deterministic fuzzy match** — Accepted _(2026-05-21)_ — related: ADR-0019
- [ADR-0029](./decisions/0029-reviewer-three-tier.md) **Reviewer 3-tier enum + 8-state approval outcome** — Accepted _(2026-05-21)_ — related: ADR-0020, ADR-0026
- [ADR-0030](./decisions/0030-mid-turn-steering.md) **Mid-turn steering + NonSteerableTurnKind** — Accepted _(2026-05-21)_ — related: ADR-0015
- [ADR-0033](./decisions/0033-jsonrpc-envelope.md) **JSON-RPC 2.0 envelope + 명시적 -timeout 채널 + version lockstep** — Accepted _(2026-05-21)_ — related: ADR-0023
- [ADR-0035](./decisions/0035-jsonl-cumulative-retention.md) **jsonl-recorder cumulative-bytes sliding-window retention** — Accepted _(2026-05-21)_ — related: ADR-0010
- [ADR-0037](./decisions/0037-queued-follow-ups.md) **Queued follow-ups (PausedReason + per-thread FIFO 큐)** — Accepted _(2026-05-21)_ — related: ADR-0015, ADR-0036
- [ADR-0039](./decisions/0039-plugin-manifest-layout.md) **플러그인 매니페스트 레이아웃 (.quanta-plugin/)** — Accepted _(2026-05-21)_ — related: ADR-0022
- [ADR-0042](./decisions/0042-agent-role-and-nicknames.md) **agent_role enum (explorer/worker/none) + maestro nickname pool** — Accepted _(2026-05-21)_ — related: ADR-0041, ADR-0019
- [ADR-0044](./decisions/0044-negative-invariants.md) **Negative invariants (Codex/Claude Desktop에서 의도적으로 채택 안 하는 패턴들)** — Accepted (negative-space 결정) _(2026-05-21)_
- [ADR-0048](./decisions/0048-response-in-progress-event.md) **`response.in_progress` streaming event 처음부터 처리 — Codex forward-compat gap 보완** — Accepted _(2026-05-21)_ — related: ADR-0033, ADR-0034
- [ADR-0049](./decisions/0049-side-conversation-seam.md) **Side-conversation seam (Codex `codex.thread.side` 흡수)** — Accepted _(2026-05-21)_
- [ADR-0051](./decisions/0051-prompt-sections-default-on.md) **Sectioned system prompt default ON (Claude Desktop `systemPromptSectionCache` 흡수)** — Accepted _(2026-05-21)_ — related: ADR-0003, ADR-0004
- [ADR-0052](./decisions/0052-message-id-rewind.md) **Message-id rewind (Claude Desktop 1.7196.3 parity)** — Accepted _(2026-05-21)_
- [ADR-0053](./decisions/0053-git-mutating-tools.md) **Git mutating 1급 도구 (commit, branch_switch) — Claude Desktop `commitWipForBranchSwitch` 흡수** — Accepted _(2026-05-21)_ — related: ADR-0025, ADR-0020, ADR-0044
- [ADR-0054](./decisions/0054-context-usage-metrics.md) **Context-usage metrics + surface-agnostic status line** — Accepted (small slice; behavior-preserving) _(2026-05-21)_
- [ADR-0056](./decisions/0056-disclaimer-shell-wrapper.md) **Disclaimer shell wrapper (dotfile-skipping spawn)** — Accepted _(2026-05-21)_ — related: ADR-0006
- [ADR-0057](./decisions/0057-effort-5-tier.md) **Session effort dimension (5-tier)** — Accepted _(2026-05-21)_ — related: ADR-0022
- [ADR-0059](./decisions/0059-built-in-slash-commands-five.md) **Five built-in slash commands (CLI surface)** — Accepted _(2026-05-21)_ — related: ADR-0024
- [ADR-0061](./decisions/0061-permission-remember-patterns.md) **rememberPatterns — 권한 패턴 학습 + cascade 자동해소 (v0.dev 흡수)** — Accepted _(2026-05-21)_ — related: ADR-0029, ADR-0020
- [ADR-0062](./decisions/0062-tool-failure-and-exploration-ladder.md) **Tool-failure ladder + exploration multi-step pattern** — Accepted _(2026-05-21)_
- [ADR-0064](./decisions/0064-git-upstream-check.md) **git_upstream_check — upstream 분기 감지 read-only 도구 (v0.dev chat=branch 흡수)** — Accepted _(2026-05-21)_ — related: ADR-0025, ADR-0053
- [ADR-0065](./decisions/0065-work-metrics.md) **workMetrics — turn별 비용·작업 투명성 (v0.dev 흡수)** — Accepted _(2026-05-21)_ — related: ADR-0032, ADR-0054
- [ADR-0066](./decisions/0066-model-swap-retry.md) **모델 교체 retry — SubmitRetryBotMessage 흡수 (v0.dev)** — Accepted _(2026-05-21)_ — related: ADR-0059
- [ADR-0067](./decisions/0067-prompt-template-sota-plus-plus.md) **Prompt template SOTA++ (vs Codex / Claude Code parity gaps)** — Accepted _(2026-05-21)_
- [ADR-0068](./decisions/0068-persona-slot.md) **Persona slot (Codex `{{ personality }}` Handlebars absorption)** — Accepted _(2026-05-21)_
- [ADR-0069](./decisions/0069-typed-tool-failure-modes.md) **typed per-failure-mode tool results — discriminated `ToolFailure` 유니온 (Cursor `EditResult`/`ShellResult` 흡수)** — Accepted _(2026-05-21)_ — related: ADR-0002
- [ADR-0071](./decisions/0071-conversation-action-steering.md) **ConversationAction — 타입드 mid-turn steering 액션 대수 (Cursor `ConversationAction` oneof 흡수)** — Accepted _(2026-05-21)_ — related: ADR-0030
- [ADR-0073](./decisions/0073-stop-category-matrix.md) **StopCategory matrix — 구조적 정지 사유 (Cursor 흡수, Spec B3)** — Accepted _(2026-05-21)_ — related: ADR-0062
- [ADR-0079](./decisions/0079-tool-choice-orthogonal-gate.md) **tool_choice forcing as an orthogonal control gate** — Accepted _(2026-05-21)_
- [ADR-0081](./decisions/0081-shell-output-delta-streaming.md) **Shell output delta streaming** — Accepted (default-OFF seam; byte-identical when observer absent) _(2026-05-21)_ — related: ADR-0006, ADR-0011
- [ADR-0082](./decisions/0082-memory-citation-provenance.md) **memory_citation provenance surface** — Accepted _(2026-05-21)_ — related: ADR-0003, ADR-0021
- [ADR-0084](./decisions/0084-speculative-branch-search.md) **Speculative branch search — N-best verifier-prover** — Accepted (default-OFF seam; byte-identical when `AgentConfig.branchSearch` absent) _(2026-05-22)_ — related: ADR-0011, ADR-0015, ADR-0027, ADR-0066, ADR-0074, ADR-0076
- [ADR-0089](./decisions/0089-lint-grounded-reflect.md) **Lint-grounded reflect gate with typed 3-way decision** — Proposed (design draft — NO implementation; default-OFF seam intended, byte-identical when unwired) _(2026-05-22)_ — related: ADR-0063, ADR-0065, ADR-0076, ADR-0067
- [ADR-0092](./decisions/0092-mode-expansion-ide-daemon.md) **Run-mode expansion — `ide` + `daemon` (C1)** — Accepted (additive; the original 4 modes are byte-identical) _(2026-05-22)_ — related: ADR-0080, ADR-0084, ADR-0081
- [ADR-0093](./decisions/0093-effect-channel.md) **EffectChannel — relocatable effect boundary (M1 keystone)** — Accepted (pure module + tests shipped, dispatch 배선은 follow-up)
- [ADR-0098](./decisions/0098-repo-rules-tree-scoping.md) **Repo-rules 트리 scoping + deeper-wins (Codex §18.1 흡수)** — Accepted _(2026-05-23)_
- [ADR-0099](./decisions/0099-git-posture-default-fail-closed.md) **Git posture — default fail-closed (Codex §18.2/§18.4/§18.5 흡수)** — Accepted _(2026-05-23)_
- [ADR-0100](./decisions/0100-destructive-git-hard-deny.md) **Destructive git HARD_DENY 6룰 (런타임 backstop)** — Accepted _(2026-05-23)_
- [ADR-0101](./decisions/0101-push-mass-delete-guard.md) **Push mass-delete guard 3룰 (Claude Desktop `push_refused_mass_delete` 흡수)** — Accepted _(2026-05-23)_
- [ADR-0102](./decisions/0102-turn-diff-updated-event.md) **`turn_diff_updated` stream event + emitter (Codex `turn/diff/updated` 흡수 + CTK 8 skills 같은 batch)** — Accepted _(2026-05-23)_
- [ADR-0103](./decisions/0103-pr-thread-blame-tool.md) **`gh_pr_blame` — PR review-thread blame (Cursor `StreamCodeTour.Blame` 흡수)** — Accepted _(2026-05-23)_
- [ADR-0104](./decisions/0104-gh-pr-typed-tools.md) **`gh_pr_review_diff` / `gh_pr_auto_merge` / `gh_pr_create.draft` (Claude Desktop PR IPC 흡수)** — Accepted _(2026-05-23)_
- [ADR-0106](./decisions/0106-session-git-fingerprint.md) **SessionMeta git fingerprint (Codex §18.9 흡수)** — Accepted _(2026-05-23)_
- [ADR-0107](./decisions/0107-git-capture-budget.md) **`GitBudget` 5-knob capture budget (Cursor `captureGitHistory` 흡수)** — Accepted _(2026-05-23)_
- [ADR-0108](./decisions/0108-shadow-git-odb.md) **Shadow git ODB foundation — 사용자 `.git` 비침습 스냅샷 인프라** — Accepted (구현 + 24-case hellgate 봉인) _(2026-05-23)_
- [ADR-0109](./decisions/0109-moved-code-detector.md) **Moved-code detector + classifier — PR-review canvas §2 "moved" 카테고리 실 구현** — Accepted _(2026-05-23)_
- [ADR-0110](./decisions/0110-git-observability-wiring.md) **Git observability wiring helpers (opt-in seam for ADR-0102/0106)** — Accepted _(2026-05-23)_
- [ADR-0114](./decisions/0114-typed-tool-failures-bash-read.md) **Typed tool failures: bash `permission_denied` + read `not_found` (gap closure)** — Unknown
- [ADR-0115](./decisions/0115-localize-signal-hardening.md) **Localize tool: SOTA++ signal hardening (BM25-lite + FrameTier + def-boost)** — Accepted (R-Phase9, 2026-05-24) — related: ADR-0084
- [ADR-0116](./decisions/0116-branch-search-shadow-odb-anchor.md) **Branch-search ↔ Shadow ODB 앵커 시밍 — 최초 wiring** — Accepted (구현 + 18-case hellgate 봉인) _(2026-05-24)_
- [ADR-0117](./decisions/0117-branch-search-minimal-change-bias.md) **Branch-search minimal-change bias + CLI progress surface** — Accepted (구현 + 25-case hellgate 봉인) _(2026-05-24)_
- [ADR-0118](./decisions/0118-shadow-odb-rewind.md) **Shadow ODB `rewindToLast` — 파괴적 복원 + 자동 안전망** — Accepted (구현 + 15-case hellgate 봉인) _(2026-05-24)_
- [ADR-0120](./decisions/0120-refusal-stop-reason-sotapp.md) **Refusal `stop_reason` typed surface — Gap-1 SOTA++** — Accepted (구현 + 19 unit hellgate + 7 e2e + 30 cross-file 봉인) _(2026-05-23)_
- [ADR-0123](./decisions/0123-verify-checkpoint-bridge.md) **Verify-checkpoint bridge — opt-in markVerified caller seam** — Accepted (2026-05-24)
- [ADR-0124](./decisions/0124-conversation-checkpoint-store.md) **Conversation checkpoint store — primitive for the missing rollback half** — Accepted _(2026-05-24)_ — related: ADR-0108, ADR-0118, ADR-0122, ADR-0123
- [ADR-0125](./decisions/0125-turn-diff-wiring-consolidation.md) **Turn-diff wiring consolidation + integration proof** — Accepted (integration test grounds the pattern; loop wire still deferred) _(2026-05-24)_ — related: ADR-0102, ADR-0106, ADR-0110
- [ADR-0126](./decisions/0126-read-image-tool.md) **`read_image` 도구 + ToolResult.images 필드 + 컴포저 헬퍼** — Accepted _(2026-05-24)_ — related: ADR-0123, ADR-0124, ADR-0125
- [ADR-0129](./decisions/0129-localize-recall-at-1-closure.md) **Localize: closing the recall@1 gap (sibling-`.js` penalty + `VENDORED_RE` for generator dirs)** — Accepted (R-Phase10, 2026-05-24) — related: ADR-0115
- [ADR-0130](./decisions/0130-extracted-source-absorption-roadmap.md) **Extracted-source absorption roadmap (R1–R6 → ADR 후보 catalog)** — Proposed (2026-05-24, roadmap only — individual ADRs are 0131+)
- [ADR-0138](./decisions/0138-token-budget-ledger.md) **Token budget ledger — typed BudgetBreach primitive over per-model pricing** — Accepted _(2026-05-24)_ — related: ADR-0124, ADR-0128
- [ADR-0141](./decisions/0141-lsp-expansion.md) **LSP 4-tool 확장 — code-action / rename-apply / format / signature-help** — Accepted (2026-05-24)
- [ADR-0142](./decisions/0142-wire-finalization.md) **Wire finalization — web-search env factory + document-tools default registration** — Accepted (2026-05-24)
- [ADR-0146](./decisions/0146-read-image-url.md) **`read_image_url` 도구 — URL → vision 파이프라인 (read_image + web_fetch 합성)** — Accepted _(2026-05-24)_ — related: ADR-0126, ADR-0127, ADR-0125
- [ADR-0152](./decisions/0152-lsp-atomic-workspace-edit.md) **LSP `applyWorkspaceEdit` 2-phase temp+rename atomicity** — Accepted (2026-05-24)
- [ADR-0153](./decisions/0153-subagent-persistence.md) **BackgroundSubagentScheduler cross-restart persistence** — Accepted _(2026-05-24)_ — related: ADR-0145, ADR-0130, ADR-0124, ADR-0136
- [ADR-0156](./decisions/0156-lsp-exdev-fallback.md) **LSP `applyWorkspaceEdit` Phase 2 EXDEV cross-FS fallback** — Accepted (2026-05-24)
- [ADR-0157](./decisions/0157-session-import-export.md) **Session import / export envelope** — Accepted (2026-05-24)
- [ADR-0158](./decisions/0158-monitoring-recipe.md) **Monitoring recipe — 새 슬라이스 instrumentation 패턴** — Accepted (recipe doc; caller-wire 패턴) _(2026-05-24)_ — related: ADR-0144, ADR-0154, ADR-0155
- [ADR-0160](./decisions/0160-connectors-rest-api.md) **Connectors REST API (W7)** — Proposed (2026-05-25)
- [ADR-0160](./decisions/0160-monitoring-completion.md) **Monitoring completion — ShadowOdb/Tool wraps + AlertManager routing + Grafana provisioning** — Accepted _(2026-05-24)_ — related: ADR-0158, ADR-0159
- [ADR-0160](./decisions/0160-skybridge-microvm-impl.md) **Skybridge Phase 2 — Lima + Apple-VZ external-binary microVM adapters** — Accepted (Phase 2 — external-binary wrapper adapter pair + registry auto-pick) _(2026-05-24)_ — related: ADR-0155, ADR-0136, ADR-0150
- [ADR-0163](./decisions/0163-multicloud-oauth-lock.md) **Multi-cloud LLM + OIDC federation + distributed OAuth refresh lock + mid-session GitHub token rotation (W12)** — Unknown
- [ADR-0166](./decisions/0166-burnrate-alerts.md) **Multi-window multi-burn-rate alert rules** — Unknown
- [ADR-0168](./decisions/0168-prometheus-recording-rules.md) **Prometheus recording rules for SLO burn rates** — Unknown
- [ADR-0170](./decisions/0170-session-export-v2.md) **Session export envelope v2** — Accepted (2026-05-25)
- [ADR-0173](./decisions/0173-repl-solid-split-wire-up.md) **runRepl SOLID split — extraction PLUS wire-up in the same PR** — Unknown
- [ADR-0174](./decisions/0174-plan-queue-lib-evaluation.md) **`p-queue` library evaluation — KEEP self-implementation for `PlanQueueStore`** — Accepted (decision: keep self-implementation) _(2026-05-25)_ — related: ADR-0128, ADR-0167
- [ADR-0179](./decisions/0179-per-tool-ttl.md) **Per-tool TTL config for `defaultToolCallCache` — staleness-tolerance by tool class** — Accepted _(2026-05-25)_ — related: ADR-0176
- [ADR-0182](./decisions/0182-prompt-cache-observability.md) **Prompt cache observability** — Accepted _(2026-05-25)_ — related: ADR-0138, ADR-0144
- [ADR-0183](./decisions/0183-streaming-cancellation.md) **Streaming cancellation + cleanup** — Accepted _(2026-05-25)_ — related: ADR-0138, ADR-0123, ADR-0128
- [ADR-0189](./decisions/0189-tool-dedup-drift.md) **Per-tool TTL drift detector — config-vs-preset divergence as typed signal** — Accepted _(2026-05-25)_ — related: ADR-0179, ADR-0169, ADR-0175
- [ADR-0191](./decisions/0191-architecture-generator.md) **Architecture generator — `tools/arch-gen` walks ADRs + slices + emits `ARCHITECTURE.generated.md`** — Accepted _(2026-05-25)_ — related: ADR-0001, ADR-0187

## ADR Timeline

### 2026-05-25

- [ADR-0159](./decisions/0159-retrieval-sota-stack.md) Retrieval SOTA stack — reranker registry, token-bucket re-chunker, commit-embedding, multi-vendor embedding port, hybrid query _(Accepted)_
- [ADR-0161](./decisions/0161-scheduled-agent.md) Scheduled agent — RRULE + Weekday nth-occurrence + automation lifecycle + model reroute _(Accepted)_
- [ADR-0162](./decisions/0162-budget-cost-histogram.md) Budget per-event cost histogram — RecordResult shape + wrap emit _(Accepted)_
- [ADR-0163](./decisions/0163-otel-resource-auto.md) OTel Resource attribute auto-enrichment — opt-in helper for OTLP / Prometheus sinks _(Accepted)_
- [ADR-0165](./decisions/0165-code-coverage.md) Code coverage observability — typed V8-coverage port + branch/statement breakdown + MetricSink emission _(Accepted)_
- [ADR-0166](./decisions/0166-subagent-conversation-replay.md) Subagent conversation-seed replay (Phase 2.5) _(Accepted)_
- [ADR-0167](./decisions/0167-plan-queue-collapse-metric.md) PlanQueue enqueue collapse metric — `EnqueueResult` + dedicated counter _(Accepted)_
- [ADR-0169](./decisions/0169-observability-skipped-warning.md) Observability skipped-slice warning — opt-in operator log + `skippedExpected` allowlist _(Accepted)_
- [ADR-0170](./decisions/0170-coverage-ast-branch.md) AST-precise branch counter — `astCoverageSource()` adapter behind the ADR-0165 `CoverageSource` port _(Accepted)_
- [ADR-0172](./decisions/0173-git-log-search-skill.md) git-log-search system skill (pickaxe/regex/author/since via shell git) _(Accepted)_
- [ADR-0172](./decisions/0174-tool-call-dedup.md) Tool-call collapse / dedup — closed-port `ToolCallCache` with `[from_cache]` model-transparency marker _(Accepted)_
- [ADR-0172](./decisions/0175-observability-wired-gauge.md) Observability wired-status gauge — `observability.wired.total{slice}` machine-readable counterpart to ADR-0169 log _(Accepted)_
- [ADR-0173](./decisions/0173-coverage-istanbul-per-branch.md) Istanbul per-branch counter — `istanbulCoverageSource()` + Istanbul-shape emitter + merge _(Accepted (Phase 3 of [ADR-0165](./0165-code-coverage.md) / [ADR-0170](./0170-coverage-ast-branch.md)))_
- [ADR-0174](./decisions/0174-plan-queue-lib-evaluation.md) `p-queue` library evaluation — KEEP self-implementation for `PlanQueueStore` _(Accepted (decision: keep self-implementation))_
- [ADR-0175](./decisions/0175-linux-sandbox-native.md) Linux sandbox Phase 3 — native Landlock + seccomp via napi-rs scaffold _(Accepted (scaffold + TS adapter; full Rust impl deferred to Phase 3.1))_
- [ADR-0175](./decisions/0175-subagent-tool-history-replay.md) Subagent tool-history replay (Phase 3 of ADR-0166) _(Accepted)_
- [ADR-0176](./decisions/0176-tool-call-dedup.md) Tool-call collapse / dedup — closed-port `ToolCallCache` with `[from_cache]` model-transparency marker _(Accepted)_
- [ADR-0178](./decisions/0178-mid-turn-interruption.md) Mid-turn user interruption — capture facade over `PlanQueueStore` with 3-arm mode + `InterruptionPolicy` port _(Accepted)_
- [ADR-0179](./decisions/0179-per-tool-ttl.md) Per-tool TTL config for `defaultToolCallCache` — staleness-tolerance by tool class _(Accepted)_
- [ADR-0180](./decisions/0180-health-snapshot-file.md) File-based health snapshot — `~/.quanta/health.json` JSON mirror of the wired-gauge _(Accepted)_
- [ADR-0181](./decisions/0181-debug-blame-skills-trio.md) debug/blame skills trio (debug-trace, explain-stack-trace, blame-section) _(Accepted)_
- [ADR-0182](./decisions/0182-prompt-cache-observability.md) Prompt cache observability _(Accepted)_
- [ADR-0183](./decisions/0183-streaming-cancellation.md) Streaming cancellation + cleanup _(Accepted)_
- [ADR-0184](./decisions/0184-linux-sandbox-native-impl.md) Linux sandbox native impl (Phase 3.1 — Rust bodies + cargo build verify) _(Accepted (Phase 3.1 — Rust impl wired + workspace + cargo build success on darwin; Phase 3.2 = strict seccomp + GitHub Actions matrix + npm publish 별도 라운드))_
- [ADR-0186](./decisions/0186-distributed-tracing.md) Distributed tracing — typed `Tracer` port + OTel SDK adapter + W3C propagator _(Accepted (no-op default + OTel adapter))_
- [ADR-0187](./decisions/0187-health-snapshot-watcher.md) Health snapshot watcher — periodic re-emit + SIGHUP hot-reload _(Accepted)_
- [ADR-0188](./decisions/0188-bug-fix-proposal-queue.md) Bug-fix proposal queue (debug-trace automated bug-fix loop, Phase 1) _(Accepted)_
- [ADR-0189](./decisions/0189-tool-dedup-drift.md) Per-tool TTL drift detector — config-vs-preset divergence as typed signal _(Accepted)_
- [ADR-0190](./decisions/0190-darwin-vz-native-scaffold.md) Darwin VZ native scaffold (Skybridge Phase 3.3 — napi-rs binding to Virtualization.framework) _(Accepted (Phase 3.3 scaffold — typed surface + 20-case fake-binding hellgate + workspace member; Phase 3.4 = real `VZVirtualMachine` bring-up + DMG image management + vsock IPC + AVF entitlements))_
- [ADR-0191](./decisions/0191-architecture-generator.md) Architecture generator — `tools/arch-gen` walks ADRs + slices + emits `ARCHITECTURE.generated.md` _(Accepted)_
- [ADR-0191](./decisions/0191-linux-sandbox-strict-mode.md) Linux sandbox strict mode (Phase 3.2 — strict seccomp + rlimit/alarm caps) _(Accepted (Phase 3.2 — strict default-deny seccomp filter + rlimit/alarm cap wire; CI matrix + npm publish 별도 ADR — Phase 3.3 deferred))_

### 2026-05-24

- [ADR-0116](./decisions/0116-branch-search-shadow-odb-anchor.md) Branch-search ↔ Shadow ODB 앵커 시밍 — 최초 wiring _(Accepted (구현 + 18-case hellgate 봉인))_
- [ADR-0117](./decisions/0117-branch-search-minimal-change-bias.md) Branch-search minimal-change bias + CLI progress surface _(Accepted (구현 + 25-case hellgate 봉인))_
- [ADR-0118](./decisions/0118-shadow-odb-rewind.md) Shadow ODB `rewindToLast` — 파괴적 복원 + 자동 안전망 _(Accepted (구현 + 15-case hellgate 봉인))_
- [ADR-0124](./decisions/0124-conversation-checkpoint-store.md) Conversation checkpoint store — primitive for the missing rollback half _(Accepted)_
- [ADR-0125](./decisions/0125-turn-diff-wiring-consolidation.md) Turn-diff wiring consolidation + integration proof _(Accepted (integration test grounds the pattern; loop wire still deferred))_
- [ADR-0126](./decisions/0126-read-image-tool.md) `read_image` 도구 + ToolResult.images 필드 + 컴포저 헬퍼 _(Accepted)_
- [ADR-0127](./decisions/0127-web-tool-slice.md) `web_fetch` + `web_search` tool slice (web 가용성 갭 봉합) _(Accepted)_
- [ADR-0128](./decisions/0128-plan-queue.md) Plan-queue helper — Codex mid-turn follow-up queue as a typed primitive _(Accepted)_
- [ADR-0136](./decisions/0136-os-sandbox-helper.md) OS-level sandbox helper — Cursor `cursorsandbox` + Codex Seatbelt 흡수 _(Accepted)_
- [ADR-0137](./decisions/0137-document-readers-extensions.md) Document readers extensions — YAML / PDF (native attachment) / XLSX (stub) _(Accepted (yaml + pdf shipped; xlsx deferred to ADR-0138 deps decision))_
- [ADR-0138](./decisions/0138-token-budget-ledger.md) Token budget ledger — typed BudgetBreach primitive over per-model pricing _(Accepted)_
- [ADR-0144](./decisions/0144-observability-metrics.md) Observability metrics — typed counter/histogram/gauge primitive over `AgentEvent` trace stream _(Accepted)_
- [ADR-0145](./decisions/0145-background-subagent.md) Background subagent scheduler — Cursor `force_background_subagent` 흡수 _(Accepted)_
- [ADR-0146](./decisions/0146-read-image-url.md) `read_image_url` 도구 — URL → vision 파이프라인 (read_image + web_fetch 합성) _(Accepted)_
- [ADR-0147](./decisions/0147-document-tools.md) `csv_read` + `ndjson_read` document tool slice (text-format structured-data gap closure) _(Accepted)_
- [ADR-0148](./decisions/0148-web-search-providers.md) Web search provider concrete impls (Brave primary + DuckDuckGo fallback) _(Accepted)_
- [ADR-0149](./decisions/0149-engineering-skills-bundle.md) Engineering-task skill bundle (4 system skills — debug / test / explain / refactor) _(Accepted)_
- [ADR-0150](./decisions/0150-landlock-phase2.md) Linux sandbox Phase 2 — `bwrap` (bubblewrap) shell-out adapter _(Accepted)_
- [ADR-0153](./decisions/0153-subagent-persistence.md) BackgroundSubagentScheduler cross-restart persistence _(Accepted)_
- [ADR-0154](./decisions/0154-otel-sink.md) OTel `MeterProvider`-backed metric sink — closed-port adapter for production export _(Accepted)_
- [ADR-0155](./decisions/0155-mcp-skybridge.md) MCP Skybridge Phase 1 — typed sandbox port + passthrough adapter _(Accepted (Phase 1 — typed-port + passthrough adapter + Phase-2 stubs))_
- [ADR-0155](./decisions/0155-otlp-helper.md) OTLP HTTP + Prometheus exporter wiring helpers — lazy-load + typed deps-missing error _(Accepted)_
- [ADR-0158](./decisions/0158-monitoring-recipe.md) Monitoring recipe — 새 슬라이스 instrumentation 패턴 _(Accepted (recipe doc; caller-wire 패턴))_
- [ADR-0158](./decisions/0158-subagent-persistence.md) Subagent persistence Phase 1 — disk-backed store + interrupted arm _(Accepted)_
- [ADR-0159](./decisions/0159-linux-sandbox.md) Linux sandbox — 2-backend auto-detect (bubblewrap + landlock-cli) _(Accepted (Phase 2 external-binary wrapper))_
- [ADR-0159](./decisions/0159-monitoring-impl-wrap-dashboard-alerts.md) Monitoring impl — instrument wrap helpers + Grafana dashboard + alert rules + E2E coverage _(Accepted)_
- [ADR-0159](./decisions/0159-subagent-work-resume.md) Subagent work-resume Phase 2 — interrupted-handle orchestrator _(Accepted)_
- [ADR-0160](./decisions/0160-monitoring-completion.md) Monitoring completion — ShadowOdb/Tool wraps + AlertManager routing + Grafana provisioning _(Accepted)_
- [ADR-0160](./decisions/0160-skybridge-microvm-impl.md) Skybridge Phase 2 — Lima + Apple-VZ external-binary microVM adapters _(Accepted (Phase 2 — external-binary wrapper adapter pair + registry auto-pick))_
- [ADR-0161](./decisions/0161-monitoring-full-coverage.md) Monitoring full coverage — LSP/PlanQueue/Budget wraps + withFullObservability + SLO doc + E2E coverage _(Accepted)_
- [ADR-0162](./decisions/0162-plugin-process-isolation.md) Plugin process isolation — DXT UtilityProcess pattern (5s spawn timeout + 5s SIGTERM grace) _(Accepted)_

### 2026-05-23

- [ADR-0095](./decisions/0095-plan-mode-structured-tools.md) Structured plan-mode tools (data model + 4 tools + 6 events) _(Accepted)_
- [ADR-0096](./decisions/0096-plan-store-port-and-slice-isolation.md) PlanStore port + ToolContext duck-typed PlanMutator seam (slice isolation) _(Accepted)_
- [ADR-0097](./decisions/0097-request-user-input-port.md) `request_user_input` host port (ADR-0086 자매) _(Accepted)_
- [ADR-0098](./decisions/0098-repo-rules-tree-scoping.md) Repo-rules 트리 scoping + deeper-wins (Codex §18.1 흡수) _(Accepted)_
- [ADR-0099](./decisions/0099-git-posture-default-fail-closed.md) Git posture — default fail-closed (Codex §18.2/§18.4/§18.5 흡수) _(Accepted)_
- [ADR-0100](./decisions/0100-destructive-git-hard-deny.md) Destructive git HARD_DENY 6룰 (런타임 backstop) _(Accepted)_
- [ADR-0101](./decisions/0101-push-mass-delete-guard.md) Push mass-delete guard 3룰 (Claude Desktop `push_refused_mass_delete` 흡수) _(Accepted)_
- [ADR-0102](./decisions/0102-turn-diff-updated-event.md) `turn_diff_updated` stream event + emitter (Codex `turn/diff/updated` 흡수 + CTK 8 skills 같은 batch) _(Accepted)_
- [ADR-0103](./decisions/0103-pr-thread-blame-tool.md) `gh_pr_blame` — PR review-thread blame (Cursor `StreamCodeTour.Blame` 흡수) _(Accepted)_
- [ADR-0104](./decisions/0104-gh-pr-typed-tools.md) `gh_pr_review_diff` / `gh_pr_auto_merge` / `gh_pr_create.draft` (Claude Desktop PR IPC 흡수) _(Accepted)_
- [ADR-0105](./decisions/0105-git-env-determinism-and-machine-log.md) Git env determinism + US-separator log format (Codex §18.7 흡수) _(Accepted)_
- [ADR-0106](./decisions/0106-session-git-fingerprint.md) SessionMeta git fingerprint (Codex §18.9 흡수) _(Accepted)_
- [ADR-0107](./decisions/0107-git-capture-budget.md) `GitBudget` 5-knob capture budget (Cursor `captureGitHistory` 흡수) _(Accepted)_
- [ADR-0108](./decisions/0108-shadow-git-odb.md) Shadow git ODB foundation — 사용자 `.git` 비침습 스냅샷 인프라 _(Accepted (구현 + 24-case hellgate 봉인))_
- [ADR-0109](./decisions/0109-moved-code-detector.md) Moved-code detector + classifier — PR-review canvas §2 "moved" 카테고리 실 구현 _(Accepted)_
- [ADR-0110](./decisions/0110-git-observability-wiring.md) Git observability wiring helpers (opt-in seam for ADR-0102/0106) _(Accepted)_
- [ADR-0111](./decisions/0111-git-skill-bundle.md) CTK git-skill bundle (8 system skills, Cursor cursor-team-kit absorption) _(Accepted)_
- [ADR-0112](./decisions/0112-git-review-diff-isolated.md) `git_review_diff` — isolated diff reviewer sub-agent (Claude Desktop `reviewDiff` 흡수) _(Accepted)_
- [ADR-0113](./decisions/0113-hook-updated-input.md) `pre_tool_use` hook `updatedInput` (Cursor parity) _(Accepted)_
- [ADR-0120](./decisions/0120-refusal-stop-reason-sotapp.md) Refusal `stop_reason` typed surface — Gap-1 SOTA++ _(Accepted (구현 + 19 unit hellgate + 7 e2e + 30 cross-file 봉인))_

### 2026-05-22

- [ADR-0078](./decisions/0078-secret-redaction-content-plane-invariant.md) Secret redaction as content-plane invariant _(Accepted)_
- [ADR-0083](./decisions/0083-multimodal-image-input.md) Multi-modal image input (dual-provider) _(Accepted)_
- [ADR-0084](./decisions/0084-speculative-branch-search.md) Speculative branch search — N-best verifier-prover _(Accepted (default-OFF seam; byte-identical when `AgentConfig.branchSearch` absent))_
- [ADR-0085](./decisions/0085-cost-cache-dashboard.md) Cost & cache dashboard _(Accepted)_
- [ADR-0086](./decisions/0086-request-plan-exit-tool.md) request_plan_exit tool — plan-exit 3-way wire _(Accepted)_
- [ADR-0087](./decisions/0087-eval-schema-additive.md) eval 스키마 additive 필드 — keyed metrics / token·cost / run status·params (Cursor `EvalTrackingService` 흡수) _(Accepted)_
- [ADR-0088](./decisions/0088-phasegate-hitl-ladder.md) PhaseGate HITL feedback ladder (Cursor AiProjectService 흡수) _(Proposed (design-only — 구현은 후속 라운드))_
- [ADR-0089](./decisions/0089-lint-grounded-reflect.md) Lint-grounded reflect gate with typed 3-way decision _(Proposed (design draft — NO implementation; default-OFF seam intended, byte-identical when unwired))_
- [ADR-0090](./decisions/0090-declarative-automation.md) Declarative event-triggered agent automation (`trigger → agentic filter → agent spawn → run record`) _(Proposed (design draft — NO implementation; default-OFF seam intended, byte-identical when unwired))_
- [ADR-0091](./decisions/0091-git-write-protection.md) git-write-protection static deny — `.git/{hooks,config}` + `.vscode` write = 코드실행 탈옥 벡터 (Cursor `cursorsandbox` 흡수) _(Accepted)_
- [ADR-0092](./decisions/0092-mode-expansion-ide-daemon.md) Run-mode expansion — `ide` + `daemon` (C1) _(Accepted (additive; the original 4 modes are byte-identical))_

### 2026-05-21

- [ADR-0028](./decisions/0028-apply-patch-v4a.md) `apply_patch` V4A format + deterministic fuzzy match _(Accepted)_
- [ADR-0029](./decisions/0029-reviewer-three-tier.md) Reviewer 3-tier enum + 8-state approval outcome _(Accepted)_
- [ADR-0030](./decisions/0030-mid-turn-steering.md) Mid-turn steering + NonSteerableTurnKind _(Accepted)_
- [ADR-0031](./decisions/0031-prefix-rule-dsl.md) Prefix-rule allowlist DSL + 3-layer precedence _(Accepted)_
- [ADR-0032](./decisions/0032-otel-attribute-vocabulary.md) OTel canonical attribute vocabulary _(Accepted)_
- [ADR-0033](./decisions/0033-jsonrpc-envelope.md) JSON-RPC 2.0 envelope + 명시적 -timeout 채널 + version lockstep _(Accepted)_
- [ADR-0034](./decisions/0034-session-jsonl-envelope.md) Session JSONL envelope (5 top-level types + 17 turn_context fields + v3 subagent linkage) _(Accepted)_
- [ADR-0035](./decisions/0035-jsonl-cumulative-retention.md) jsonl-recorder cumulative-bytes sliding-window retention _(Accepted)_
- [ADR-0036](./decisions/0036-plan-mode-dispatch-seam-block.md) Plan vs Default collaboration mode — dispatch-seam mutating block _(Accepted)_
- [ADR-0037](./decisions/0037-queued-follow-ups.md) Queued follow-ups (PausedReason + per-thread FIFO 큐) _(Accepted)_
- [ADR-0038](./decisions/0038-external-agent-import.md) External-agent import 4-stage lifecycle _(Accepted)_
- [ADR-0039](./decisions/0039-plugin-manifest-layout.md) 플러그인 매니페스트 레이아웃 (.quanta-plugin/) _(Accepted)_
- [ADR-0040](./decisions/0040-skills-vs-extensions-split.md) Skills vs Extensions split + SKILL.md frontmatter _(Accepted)_
- [ADR-0041](./decisions/0041-subagent-6-tool-standard.md) Subagent 6-tool 표준 (exec_command / write_stdin / spawn_agent / wait_agent / close_agent / send_input) _(Accepted)_
- [ADR-0042](./decisions/0042-agent-role-and-nicknames.md) agent_role enum (explorer/worker/none) + maestro nickname pool _(Accepted)_
- [ADR-0043](./decisions/0043-desktop-surface-reference.md) 데스크톱 표면 reference (Seatbelt / Skybridge / microVM) _(Reference-only (코드 변경 없음))_
- [ADR-0044](./decisions/0044-negative-invariants.md) Negative invariants (Codex/Claude Desktop에서 의도적으로 채택 안 하는 패턴들) _(Accepted (negative-space 결정))_
- [ADR-0045](./decisions/0045-progress-audit-system-skill.md) progress-audit system skill (bundled, code-evidence audit discipline) _(Accepted)_
- [ADR-0046](./decisions/0046-permission-stack-thread-host-postdenial.md) Permission stack: per-thread + per-host + post-denial precedence _(Accepted)_
- [ADR-0047](./decisions/0047-hitl-4-tier-gate.md) HITL 4-tier gate: annotation registry + handoff seam _(Accepted)_
- [ADR-0048](./decisions/0048-response-in-progress-event.md) `response.in_progress` streaming event 처음부터 처리 — Codex forward-compat gap 보완 _(Accepted)_
- [ADR-0049](./decisions/0049-side-conversation-seam.md) Side-conversation seam (Codex `codex.thread.side` 흡수) _(Accepted)_
- [ADR-0051](./decisions/0051-prompt-sections-default-on.md) Sectioned system prompt default ON (Claude Desktop `systemPromptSectionCache` 흡수) _(Accepted)_
- [ADR-0052](./decisions/0052-message-id-rewind.md) Message-id rewind (Claude Desktop 1.7196.3 parity) _(Accepted)_
- [ADR-0053](./decisions/0053-git-mutating-tools.md) Git mutating 1급 도구 (commit, branch_switch) — Claude Desktop `commitWipForBranchSwitch` 흡수 _(Accepted)_
- [ADR-0054](./decisions/0054-context-usage-metrics.md) Context-usage metrics + surface-agnostic status line _(Accepted (small slice; behavior-preserving))_
- [ADR-0055](./decisions/0055-awf-tool-matcher-hook-channel.md) AWF 2-matcher PreToolUse hook channel _(Accepted)_
- [ADR-0056](./decisions/0056-disclaimer-shell-wrapper.md) Disclaimer shell wrapper (dotfile-skipping spawn) _(Accepted)_
- [ADR-0057](./decisions/0057-effort-5-tier.md) Session effort dimension (5-tier) _(Accepted)_
- [ADR-0058](./decisions/0058-anthropic-beta-headers-and-skill-size-cap.md) Anthropic beta channels + 30 MB skill size cap _(Accepted)_
- [ADR-0059](./decisions/0059-built-in-slash-commands-five.md) Five built-in slash commands (CLI surface) _(Accepted)_
- [ADR-0060](./decisions/0060-tool-output-schema-factory.md) defineTool — output-schema + toModelOutput + deferred + streaming-input (v0.dev `createProviderToolFactoryWithOutputSchema` 흡수) _(Accepted)_
- [ADR-0061](./decisions/0061-permission-remember-patterns.md) rememberPatterns — 권한 패턴 학습 + cascade 자동해소 (v0.dev 흡수) _(Accepted)_
- [ADR-0062](./decisions/0062-tool-failure-and-exploration-ladder.md) Tool-failure ladder + exploration multi-step pattern _(Accepted)_
- [ADR-0063](./decisions/0063-plan-exit-three-way.md) Plan 모드 3-way exit (approve / reject / request-changes) (v0.dev 흡수) _(Accepted)_
- [ADR-0064](./decisions/0064-git-upstream-check.md) git_upstream_check — upstream 분기 감지 read-only 도구 (v0.dev chat=branch 흡수) _(Accepted)_
- [ADR-0065](./decisions/0065-work-metrics.md) workMetrics — turn별 비용·작업 투명성 (v0.dev 흡수) _(Accepted)_
- [ADR-0066](./decisions/0066-model-swap-retry.md) 모델 교체 retry — SubmitRetryBotMessage 흡수 (v0.dev) _(Accepted)_
- [ADR-0067](./decisions/0067-prompt-template-sota-plus-plus.md) Prompt template SOTA++ (vs Codex / Claude Code parity gaps) _(Accepted)_
- [ADR-0068](./decisions/0068-codex-2-phase-memory-consolidator.md) Codex 2-Phase memory consolidator (SOTA++ v2) _(Accepted)_
- [ADR-0068](./decisions/0068-persona-slot.md) Persona slot (Codex `{{ personality }}` Handlebars absorption) _(Accepted)_
- [ADR-0069](./decisions/0069-typed-tool-failure-modes.md) typed per-failure-mode tool results — discriminated `ToolFailure` 유니온 (Cursor `EditResult`/`ShellResult` 흡수) _(Accepted)_
- [ADR-0070](./decisions/0070-review-kind-permission-matrix.md) review-kind × isExecutionBlocking × reason_code 권한 매트릭스 + scoped-allowlist 결정 verb (Cursor HITL gate 흡수) _(Accepted)_
- [ADR-0071](./decisions/0071-conversation-action-steering.md) ConversationAction — 타입드 mid-turn steering 액션 대수 (Cursor `ConversationAction` oneof 흡수) _(Accepted)_
- [ADR-0072](./decisions/0072-submission-op-envelope.md) Submission op envelope — host→agent 입력의 타입드 봉투 (Codex 흡수, Spec A3) _(Accepted)_
- [ADR-0073](./decisions/0073-stop-category-matrix.md) StopCategory matrix — 구조적 정지 사유 (Cursor 흡수, Spec B3) _(Accepted)_
- [ADR-0074](./decisions/0074-otel-span-tree.md) OTel span tree (Codex 10-step) — core 4-stage wrap _(Accepted (default-OFF seam; behavior-preserving))_
- [ADR-0075](./decisions/0075-pre-compact-hitl-and-summary-archive.md) Pre-Compact HITL + ConversationSummaryArchive (Cursor 흡수) _(Accepted)_
- [ADR-0076](./decisions/0076-agent-loop-branch-hardening.md) Agent-loop branch hardening (refusal / reasoning / submission-op / deny-and-steer) _(Accepted)_
- [ADR-0077](./decisions/0077-phase-ttft-readonly-trio.md) Phase marker + TTFT + readonly deny-steer trio _(Accepted)_
- [ADR-0079](./decisions/0079-tool-choice-orthogonal-gate.md) tool_choice forcing as an orthogonal control gate _(Accepted)_
- [ADR-0080](./decisions/0080-ide-context-provider-seam.md) IDE context provider seam _(Accepted)_
- [ADR-0081](./decisions/0081-shell-output-delta-streaming.md) Shell output delta streaming _(Accepted (default-OFF seam; byte-identical when observer absent))_
- [ADR-0082](./decisions/0082-memory-citation-provenance.md) memory_citation provenance surface _(Accepted)_

### 2026-05-20

- [ADR-0013](./decisions/0013-verify-before-finish-guard.md) 완료 전 검증 가드 (verify-before-finish) _(Accepted)_
- [ADR-0014](./decisions/0014-bench-repair-rounds.md) bench 외부 repair 라운드 (continue-from-patched-tree) _(Accepted)_
- [ADR-0024](./decisions/0024-lsp-nav-surface-expansion.md) LSP nav surface 확장 (definition/references/hover/symbol/rename-preview) _(Accepted)_
- [ADR-0025](./decisions/0025-git-first-class-tools.md) Git 1급 도구 (diff/status/log/blame) _(Accepted)_
- [ADR-0026](./decisions/0026-admissibility-gate-ssot.md) Admissibility-gate SSOT 추출 _(Accepted)_
- [ADR-0027](./decisions/0027-anti-signals-policy-injection-hardening.md) Anti-signal 카탈로그 + policy-injection 적대성 게이트 _(Accepted)_

### 2026-05-19

- [ADR-0001](./decisions/0001-biome2-slice-isolation.md) Biome 2.x로 슬라이스 경계 lint 강제 _(Accepted)_
- [ADR-0002](./decisions/0002-openai-provider.md) OpenAI를 2번째 LLM provider로 추가 _(Accepted)_
- [ADR-0003](./decisions/0003-test-pyramid.md) 테스트 피라미드를 4티어로 분리하고 CI로 강제 _(Accepted)_
- [ADR-0004](./decisions/0004-prompt-cache-prefix.md) 시스템 프롬프트를 정적 프리픽스로 고정해 캐시 적중 _(Accepted)_
- [ADR-0005](./decisions/0005-skipped.md) (의도적 결번) _(Skipped)_
- [ADR-0006](./decisions/0006-runtime-sandbox.md) runtime 샌드박스 추상화 — Local(약식) + Docker(opt-in) _(Accepted)_
- [ADR-0007](./decisions/0007-mcp-slice.md) MCP 클라이언트를 신규 슬라이스로 추가하고 agent에서 브리지 _(Accepted)_
- [ADR-0008](./decisions/0008-sota-memory.md) SOTA++ 계층형 시맨틱 메모리 _(Accepted)_
- [ADR-0009](./decisions/0009-lsp-diagnostics-tool.md) LSP를 `diagnostics` 도구로 에이전트에 노출 _(Accepted)_
- [ADR-0010](./decisions/0010-observability-trajectory.md) 관측 플랫폼 — Trajectory 스키마 + Probe (SDK 비의존) _(Accepted)_
- [ADR-0011](./decisions/0011-sota-cc-v2-absorption.md) Claude Code v2 SOTA++ 흡수 (Tier 0+1) _(Accepted)_
- [ADR-0012](./decisions/0012-retire-loc-cap.md) 전역 LoC 예산 철회 _(Accepted)_

## Dependency Graph (plane summary)

```
domain   (llm · tool · permission · storage · runtime · patch · rules · shared)
   ↓
application   (agent · runner · scheduler · subagent · reactor)
   ↓
infrastructure   (apps · adapters · connectors · plugin-isolation · migration)

observability ─┐
security      ─┤  cross-cut (importable from any plane via injected ports)
ipc · ui · session · skill · memory · mcp · lsp · retrieval · git · auth · stream · scheduler
```

## Catalog parity

- Total ADR files: 216
- Distinct ADR numbers: 191
- ADR collisions: 25
- Total slices: 29
- Hellgate test files referenced: 15

> Footer auto-emitted 2026-05-24. Re-run `bun tools/arch-gen/main.ts` to regenerate.
