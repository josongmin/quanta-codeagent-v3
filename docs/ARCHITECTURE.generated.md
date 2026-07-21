# Quanta — Architecture (Generated)

> Auto-generated from `tools/arch-gen` on **2026-07-19** by walking `docs/decisions/` + `src/**`. Edit the source — re-run `bun tools/arch-gen/main.ts` to refresh. The hand-curated companion lives at `docs/ARCHITECTURE.md`.

## Slices (43 total)

### `@/activity`

> Agent Activity Spine — public barrel (jun-15 P0-a). The canonical model + pure reducer + derived projections + producer adapters. Surfaces (CLI `/activity`, Web Mission Control, embedded) consume `materialize` + `projectFleet`/`projectTr...

- Public surface: `ActivityAggregate`, `ActivityKind`, `ActivityNode`, `ActivitySnapshot`, `ActivityState`, `ActivityStatus`, `ActivityStore`, `ActivityTreeNode`, `AgentActivityEvent`, `createActivityStore`, `createWorkflowSink`, `emptyActivityState`, `FleetRow`, `FleetRowLike`, `fleetRowToActivity`, `fleetRowToItemStream`, `fleetToActivity`, `fleetToItemStream`, `formatAge`, `materialize`, `NodeInit`, `projectFleet`, `projectTree`, `pumpFleetRowsToItemStream`, `reduceActivity`, `reduceAll`, `renderActivity`, `RenderActivityOpts`, `seedStoreFromSnapshot`, `SideAgentSnapshotLike`, `SideAgentStatusLike`, `sideAgentsToActivity`, `sideAgentToActivity`, `Stuck`, `StuckReason`, `workflowCloseActivity`, `WorkflowEventLike`, `WorkflowSink`, `WorkflowSinkOpts`, `workflowToActivity`, `WorkflowToActivityOpts`
- Hellgate: _(none)_

### `@/agent`

> (no description)

- Public surface: `__resetHitlOverrides`, `ADVISOR_TRANSCRIPT_MAX_CHARS`, `ADVISOR_TRANSCRIPT_MAX_MESSAGES`, `advisorConsultFromLLM`, `AdvisorConsultFromLLMOptions`, `AgentConfig`, `agentlessLocalize`, `AgentlessLocalizeDeps`, `AgentlessLocalizeResult`, `AgentMode`, `AgentOutcome`, `AgentRecorder`, `ALL_AGENT_MODES`, `ALL_CONFIRM_DECISIONS`, `ALL_PLAN_EXIT_DECISIONS`, `appendSummary`, `applyMcpClientWiring`, `arbitrateConsolidation`, `archivedTokens`, `asDials`, `assertModeMatrix`, `assertSideConversationEffort`, `attachLspDiagnosticsHook`, `Blocker`, `BlockerSurface`, `BranchSearchConfig`, `BreakerVerdict`, `BriefStore`, `BUDGET_PRESETS`, `BudgetCaps`, `BudgetClampEvent`, `BudgetDials`, `BudgetEvent`, `BudgetExhaustedEvent`, `BudgetExhaustion`, `BudgetExhaustionPolicy`, `BudgetMeter`, `BudgetMeterOptions`, `BudgetTickEvent`, `BudgetUsage`, `buildAdvisorBlock`, `buildAgentlessPrompt`, `buildComposeAuthoringBlock`, `buildControlTestPrompt`, `buildDenySteerMessage`, `buildPlanExit`, `buildPrShipBlock`, `buildSkillGate`, `buildSkillScopeView`, `buildSystemPrompt`, `buildTurnContext`, `builtinAnnotations`, `CachingEmbedder`, `charsOf`, `clampDials`, `classifyErrorReason`, `classifyLLMError`, `CloseoutCritic`, `CloseoutCriticConfig`, `CloseoutCriticObservation`, `CloseoutCriticRequest`, `CloseoutCriticVerdict`, `COMMAND_HOOKS_ENABLED_WITHOUT_ACK_MESSAGE`, `CommandHookBinding`, `CommandHookConfig`, `CommandHookConfigError`, `CommandHookDeps`, `CommandHookEvent`, `CommandHookExecOpts`, `CommandHookExecPort`, `CommandHookExecResult`, `CommandHookGate`, `CommandHookPermissionPort`, `CommandHookReviewPort`, `CommandHookSource`, `CommandHookVerdict`, `compactIfNeeded`, `CompactionBreaker`, `CompactionBreakerCaps`, `completedCategory`, `composeAgentlessHint`, `ComposeForSurfaceOpts`, `composeGlobRulesWithDetected`, `composeIssueHint`, `composeSystemPromptForSurface`, `ConfirmDecision`, `ConfirmDecisionError`, `ConsolidationOp`, `ConversationSummaryArchive`, `ConversationSummaryEntry`, `createArchive`, `createAutoClassifierPort`, `createBriefStore`, `createEffortStore`, `createOnConfirmReviewerPort`, `createSandboxCommandHookExec`, `createSubagentRunner`, `createTokenDeltaCounter`, `createVerifyGuardState`, `createWorkingStateSession`, `createWorktreeSlot`, `decideVerifyGuard`, `decorateWithDeltaCounter`, `DEFAULT_COMMAND_HOOK_MAX_OUTPUT_BYTES`, `DEFAULT_COMMAND_HOOK_TIMEOUT_MS`, `DEFAULT_COMPACTION_BREAKER_CAPS`, `DEFAULT_EFFORT`, `DEFAULT_HOOK_DENY_REASON`, `DEFAULT_SIDE_CONVERSATION_INPUT_TOKEN_BUDGET`, `DEFAULT_SIDE_CONVERSATION_OUTPUT_TOKEN_BUDGET`, `defaultHookApprovalsPath`, `DeferredValidation`, `DeltaTokenWorkingMemory`, `disambiguateMcpToolNames`, `DispatchOutcome`, `dispatchSideConversation`, `DistilledMemory`, `distillSession`, `dropOldestSalvage`, `DropOldestSalvageInput`, `DropOldestSalvageResult`, `dropOldestTurn`, `EFFORT_LEVELS`, `EffortLevel`, `EffortStore`, `effortToTokenBudget`, `ElicitationPrompterFactory`, `embedUntrusted`, `EMPTY_ISSUE_HINT`, `emptyPersistStats`, `emptyWorkingState`, `EnvironmentPosture`, `escapeBoundary`, `escapeReminderBoundary`, `estimateSideConversationTokens`, `estimateTokens`, `evidenceLspStatic`, `executeReproTests`, `ExternalDepsLever`, `extractCodeFences`, `extractErrors`, `extractFiles`, `extractIssueHint`, `extractSeedMessages`, `extractSymbols`, `extractTracebackPaths`, `FileSystemIdeContextProvider`, `FileSystemIdeContextProviderOpts`, `filterSideConversationTools`, `filterSpecsByScope`, `finalAssistantText`, `findBoundary`, `FROZEN_SURFACE_PROFILE`, `generateControlTests`, `generateReproTests`, `GitWriteLever`, `GLOB_RULE_DIRS`, `GlobRule`, `HandoffRequiredEvent`, `HitlAnnotation`, `HitlTier`, `HITLTier`, `HookAbort`, `HookApprovalRecord`, `hookBindingKey`, `HookBus`, `HookDeny`, `HookEmitResult`, `HookEvent`, `HookEventType`, `HookHandler`, `HookPermissionDecision`, `HookPermissionResponse`, `HookPromptInject`, `HookReviewStore`, `HookToolOverride`, `HookUpdatedInput`, `IdeContextMetadata`, `IdeContextMetadataSink`, `IdeContextProvider`, `IdeContextTier`, `IdeSnapshot`, `installCommandHooks`, `interruptedCategory`, `isAlwaysInScope`, `isBudgetEvent`, `isConfirmDecisionAllowed`, `isHandoffRequiredEvent`, `isMutatingToolBlockedInMode`, `isMutatingToolBlockedInPlan`, `isRetryable`, `IssueHint`, `isTestLikeCommand`, `isUserInputSubmission`, `isVerifyOutputFailing`, `isVerifySignalCommand`, `LEVER_FIELDS`, `LeverField`, `LineCitation`, `LineCitationProvenance`, `lineSpanOf`, `LLMErrorKind`, `loadCommandHookBindings`, `loadGlobRules`, `loadGlobRulesWithVendors`, `LoadGlobRulesWithVendorsOpts`, `loadMcpTools`, `LoadMcpToolsOpts`, `loadNamedAgents`, `loadRepoRules`, `loadSession`, `lspBinaryAvailable`, `LspDiagnosticsHookHandle`, `LspDiagnosticsHookOptions`, `lspDiagnosticsTool`, `lspExtensionToLanguage`, `lspNavCheapToolList`, `lspNavToolList`, `makeClampEvent`, `mapClaudeEvent`, `markBaselineStaleIfShrunk`, `matchesExactVerifyCommand`, `matchVerifyCommand`, `MAX_AGENT_FILES`, `MAX_AGENT_SYSTEM_BYTES`, `MAX_DROP_OLDEST_ROUNDS`, `MAX_RENDER_BYTES`, `MAX_RULE_BYTES`, `MAX_RULE_FILES`, `maybeProposeRadarCard`, `MaybeProposeRadarCardArgs`, `McpStoppable`, `mcpToolName`, `mcpToolToTool`, `mcpToolToToolSupervised`, `MemoryLever`, `memoryTools`, `MemoryToolsDeps`, `MemoryWriteGuard`, `MemoryWriteGuardArm`, `METRIC`, `mintActiveWorktreeSlot`, `MODE_PRESETS`, `MODE_REPO_RULES_POLICY`, `modeBlockReason`, `modeLoadsRepoRules`, `ModePolicy`, `mutatingToolKind`, `NAMED_AGENT_DIRS`, `NamedAgentDefinition`, `NamedAgentRegistry`, `NamedAgentResolver`, `narrowMode`, `NetworkLever`, `NextStep`, `normaliseReproSource`, `normalizeCommandHookGate`, `normalizeConfirm`, `normalizePermissionDecision`, `NullEmbedder`, `ObservationLever`, `OnConfirmReviewerPortOptions`, `OpenAIEmbedder`, `OpenAIEmbedderOptions`, `OpenDiagnosticsSession`, `OutputLever`, `OwnerCandidate`, `parseAgentlessResponse`, `parseBoolKnob`, `parseCommandHookBindings`, `parseEffort`, `PermissionHookRouting`, `PermissionLever`, `PersistDeps`, `PersistInput`, `persistSession`, `PersistStats`, `PersonaKind`, `planExitAllowsMutation`, `PlanExitDecision`, `PlanExitInvariantError`, `PlanExitOutcome`, `planExitStaysInPlan`, `PreCompactDecision`, `PreCompactRequestQuery`, `probeRepoMap`, `probeRepoMap3`, `ProbeRepoMap3Opts`, `ProbeRepoMapOpts`, `probeTurnEnv`, `ProbeTurnEnvOpts`, `PROMPT_HOOK_MAX_CHARS`, `PromptInjectPush`, `PromptPackLever`, `proveStrictLspReady`, `pytestReportPathFor`, `RadarProducerBlock`, `READONLY_DENY_STEER_NOTE`, `recallContext`, `RecallDeps`, `RecallStats`, `RECOVERY_CAPS`, `redactTranscript`, `reflectConsultFromLLM`, `ReflectConsultFromLLMOptions`, `renderEnvBlock`, `renderGlobRulesBlock`, `renderIdeContext`, `renderRepoRulesBlock`, `renderTaskBudgetBlock`, `renderWorkingStateBlock`, `REPO_MAP_DEFAULT_MAX_CHARS`, `REPO_MAP_DEFAULT_MAX_DEPTH`, `REPO_MAP_DEFAULT_MAX_FILES`, `REPO_RULE_CANDIDATES`, `RepoRules`, `REPRO_CONTROL_DEFAULT_SAMPLES`, `REPRO_TEST_DEFAULT_SAMPLES`, `REPRO_TEST_DEFAULT_TIMEOUT_MS`, `REPRO_TEST_MAX_SAMPLES`, `ReproExecPort`, `ReproExecuteArgs`, `ReproReadFilePort`, `ReproTestConfig`, `ReproTestOutcome`, `ReproTestSample`, `ReproTestSelection`, `ReproWriteFilePort`, `resolveAgentMode`, `resolveCompactionLimitTokens`, `resolveEffort`, `resolveHitlAnnotation`, `resolvePersona`, `RetryingLLM`, `RetryingLLMOptions`, `routePermissionHookVerdict`, `runAgent`, `runCloseoutCritic`, `runCommandHooks`, `RunMode`, `runSideConversation`, `SamplingWiringInput`, `SandboxLever`, `saveSession`, `SaveSessionInput`, `SecretsLever`, `selectGlobRules`, `selectReproTest`, `SESSION_TAG`, `SIDE_CONVERSATION_PROMPT`, `SIDE_CONVERSATION_PROMPT_BASE`, `SIDE_CONVERSATION_PROMPT_DELIMITER`, `SIDE_CONVERSATION_QUANTA_ADDENDUM`, `SIDE_CONVERSATION_TOOL_EXCLUSIONS`, `SIDE_CONVERSATION_TOOL_NAMES`, `SideConversationAbortedError`, `SideConversationBudgetError`, `SideConversationEffort`, `SideConversationEffortError`, `SideConversationOptions`, `SideConversationRequest`, `SideConversationResolver`, `SideConversationResponse`, `SideConversationResult`, `SideConversationSpanAttributes`, `SideConversationToolError`, `SkillEffortAdvisory`, `SkillGate`, `SkillScopeView`, `SkillTurnOverride`, `sourceNeedsReview`, `STOP_REASON_CODE`, `StopCategory`, `StopCategoryKind`, `StopReason`, `StopReasonCode`, `StreamingCall`, `StreamingDispatch`, `streamingTurn`, `StreamingTurnArgs`, `StreamingTurnResult`, `stripMarkdownFences`, `stripPythonComments`, `SubagentRunnerOptions`, `Submission`, `SUBMISSION_LEGACY_ID_PREFIX`, `submissionFromMessages`, `SubmissionOp`, `SurfaceProfile`, `SWE_SURFACE_PROFILE`, `TaskBudget`, `TerminationLever`, `TEST_LIKE_RE`, `ThreadMemoryMode`, `TickKind`, `TokenBaseline`, `TokenBaselineBox`, `TokenBaselineBoxState`, `TokenDeltaCounter`, `toMetadataSnapshot`, `TOOL_FAILURE_RETRY_MAX`, `ToolSurfaceLever`, `toRelativePath`, `triggerTokenCount`, `TurnContext`, `TurnContextInput`, `TurnEnvContext`, `TurnWorkMetricsCollector`, `VERIFY_FORCE_MESSAGE`, `VERIFY_MATCHERS`, `VerifyGuardState`, `VerifyMatcher`, `wireOptionalAgentPorts`, `WorkingState`, `WorkingStatePatch`, `WorkingStateSession`, `WorkMetricsSink`
- Hellgate: `tests/unit/agent-prewarm-loop-wire-hellgate.test.ts`

### `@/artifact`

> Artifact slice barrel (C1 — Canvas / artifact persistence store, backlog §7). Pure in-memory registry for non-code generation outputs. See `./registry.ts`.

- Public surface: `Artifact`, `ARTIFACT_KINDS`, `ARTIFACT_URL_SCHEME`, `ArtifactKind`, `ArtifactRegistry`, `ArtifactRegistryOptions`, `ArtifactSpec`, `createArtifactRegistry`, `DEFAULT_ARTIFACT_REGISTRY_MAX`, `detectRichSegments`, `detectRichSegmentsGated`, `hasRichSegments`, `monotonicIdFactory`, `previewUrl`, `RichSegment`, `segmentsToText`
- Hellgate: `tests/unit/artifact-store-e2e-hellgate.test.ts`

### `@/auth`

> (no description)

- Public surface: `chatgptOAuth`
- Hellgate: _(none)_

### `@/browser` [ADR-0427]

> Browser automation slice (ADR-0427, jun-1-browser-automation). Wave 1: pure core + deterministic headless stub. Wave 2: the real CDP adapter (system-chrome spawn) behind the same `BrowserPort`, with all IO injected.

- Public surface: `BrowserError`, `BrowserFs`, `BrowserHandle`, `BrowserPort`, `BrowserStartOpts`, `buildNetworkEntry`, `buildSnapshot`, `CDP_ALLOWED_METHODS`, `CdpAllowedMethod`, `CdpBrowserDeps`, `CdpConnection`, `CdpTransport`, `Clock`, `consoleArgsToText`, `ConsoleBuffer`, `ConsoleBufferOpts`, `ConsoleEntry`, `ConsoleLevel`, `ConsoleOpts`, `createCdpBrowser`, `createConsoleBuffer`, `createHeadlessBrowser`, `createNetworkBuffer`, `createRefMap`, `DEFAULT_CHROME_CANDIDATES`, `DEFAULT_MAC_CHROME_PATHS`, `defaultBrowserFs`, `defaultCdpTransport`, `defaultProcessSpawner`, `DomModel`, `DomNode`, `HeadlessBrowserOpts`, `HeadlessPage`, `isCdpMethodAllowed`, `LocatorHint`, `mapConsoleApiType`, `mapLogEntryLevel`, `NetworkBuffer`, `NetworkBufferOpts`, `NetworkEntry`, `NetworkOpts`, `PageSnapshot`, `ProcessSpawner`, `ReadOpts`, `ReadWhat`, `realClock`, `realScheduler`, `RefMap`, `resolveChromeBinary`, `Scheduler`, `SnapshotOpts`, `SpawnedProcess`, `TypeOpts`, `WaitOpts`
- Hellgate: `tests/unit/browser-tool-mapping-hellgate.test.ts`

### `@/capability` [ADR-0503]

> `@/capability` — cross-surface capability-exposure layer (ADR-0503 P3 / RFC §4). One declaration per feature (gate + surfaces) → one resolver → no split-brain. The whole layer is behind the master `QUANTA_CAPABILITY_LAYER` gate (default-...

- Public surface: `allCapabilities`, `CAPABILITIES`, `CAPABILITY_LAYER_ENV`, `CapabilityDescriptor`, `CapabilityProbeResult`, `CapabilitySurfaces`, `ExposureProbe`, `probeExposureConsistency`, `resolveExposure`, `runCapabilityProbe`, `Surface`
- Hellgate: _(none)_

### `@/codemode`

> `@/codemode` — QuickJS-WASM code-cell sandbox (RFC jun-6-code-mode, Phase 1). A DUMB sandbox: it runs a model-authored JS program in an isolated WASM heap and can reach the host ONLY via an injected {@link CodeCellDispatchPort}. The secu...

- Public surface: `capOutput`, `CellToolCallRecord`, `CODE_MODE_DEFAULTS`, `CodeCellDispatchPort`, `CodeCellLimits`, `CodeCellResult`, `CodeCellStatus`, `DispatchOutcome`, `isCellToolIdentifier`, `PHASE1_CELL_TOOLS`, `redactAndCap`, `runCodeCell`, `RunCodeCellOptions`, `wrapExecMain`
- Hellgate: _(none)_

### `@/config` [ADR-0497]

> `@/config` — central on-disk config loader + per-project trust gate barrel (ADR-0497, jun-7-misc 05). The PUBLIC closed-port surface. `@/shared` `runtime-config` and `@/agent/command-hooks` depend on these interfaces; the concrete file I...

- Public surface: `ALL_SETTING_SOURCES`, `canonicalizeProjectPath`, `canonicalizeTrustedPaths`, `EMPTY_RESOLVED`, `filterMcpServersByPolicy`, `HookGroupSetting`, `LAYER_PRECEDENCE`, `LayerBenign`, `LayerPaths`, `LayerSecurity`, `LOCAL_SETTINGS_FILE`, `MACHINE_OWNED_LAYERS`, `McpFilterResult`, `McpLaunchPolicy`, `mergeDiskLayers`, `mergeSettings`, `osManagedSettingsPath`, `parseSettingsLayer`, `parseSettingSources`, `PermissionSettings`, `PROJECT_CONFIG_DIRNAME`, `PROJECT_SETTINGS_FILE`, `readDiskLayers`, `readLayers`, `ReadTextPort`, `REPO_LAYERS`, `resolveDiskConfig`, `ResolvedSettings`, `ResolveInput`, `SettingsLayer`, `SettingsLayerName`, `SettingSources`, `TrustPersistencePort`, `TrustRecord`, `TrustStore`, `USER_SETTINGS_FILE`, `WarnSink`
- Hellgate: `tests/unit/config-cred-cluster-hardening-r1-hellgate.test.ts`

### `@/connectors` [ADR-0160]

> Connectors — public surface barrel (ADR-0160). Phases A–E ship: type model + ports + REST/in-memory registry + OAuth discovery + dynamic registration + availability prober + token rotation. Default-OFF: this slice is additive. `src/mcp/`...

- Public surface: `AvailabilityCheckerPort`, `AvailabilityVerdict`, `BACKOFF_BASE_MS`, `BACKOFF_MAX_MS`, `BUNDLED_MCP_CONNECTORS`, `CacheEntry`, `CachePort`, `checkMarketplaceSource`, `ClockPort`, `Connector`, `ConnectorMarketplace`, `ConnectorRegistryPort`, `connectorsToEntries`, `connectorToMcpEntry`, `createAvailabilityProber`, `createConnectorMarketplace`, `createInMemoryConnectorRegistry`, `createInMemoryInstalledAppStore`, `createMcpConnectorCatalog`, `createRestConnectorRegistry`, `createTokenRefreshScheduler`, `createTokenRotator`, `DirectoryApp`, `DirectoryAppSchema`, `discoverOAuthEndpoints`, `DnsPort`, `enforceMarketplacePolicy`, `fetchCatalogFromRegistry`, `FetchPort`, `FetchPortResponse`, `InstalledApp`, `InstalledAppState`, `InstalledAppStorePort`, `isConnectorMarketplaceEnabled`, `LEAD_MS`, `LifecycleResult`, `MarketplaceBlockReason`, `MarketplaceLifecycleError`, `MarketplacePolicy`, `MarketplaceVerdict`, `McpConnectorCatalogPort`, `McpConnectorEntry`, `McpConnectorTransport`, `McpInstallError`, `McpInstallResult`, `McpServerConfigShape`, `OAuthClientMetadata`, `OAuthClientRegistration`, `OAuthDiscoveryError`, `OAuthDiscoveryErrorCode`, `OAuthEndpoints`, `OAuthRegistrationError`, `OAuthRegistrationErrorCode`, `RefreshOutcome`, `registerOAuthClient`, `RestRegistryConfig`, `restRegistrySnapshotToCatalog`, `SupportedAuth`, `TimerHandle`, `TimerPort`, `TokenRecord`, `TokenRefreshScheduler`, `TokenRefreshSchedulerConfig`, `TokenRotationError`, `TokenRotationErrorCode`, `TokenRotator`, `TokenRotatorConfig`, `TokenStorePort`, `toMcpServerConfig`
- Hellgate: `tests/unit/connectors-rest-registry-backward-clock-hellgate.test.ts`

### `@/git`

> `@/git` — pure / library-slice git utilities. Importers must inject any subprocess access via the closed ports declared here. No upward deps. The existing `src/tool/git/*` first-class tools are unrelated (they live downstream in `@/tool`...

- Public surface: `ConflictBlock`, `ConflictParseDiagnostic`, `ConflictParseResult`, `ConflictParserInputError`, `createInMemoryFileLock`, `FileLockPort`, `GitProcessPort`, `GitProcessResult`, `parseConflicts`, `SnapshotClock`, `snapshotDirtyToCloudBranch`, `SnapshotError`, `SnapshotErrorThrown`, `SnapshotOpts`, `SnapshotResult`, `SnapshotStage`
- Hellgate: `tests/unit/git-directive-stage-push-pr-hooks-hellgate.test.ts`

### `@/ipc`

> `@/ipc` — surface-agnostic CLI ↔ Web ↔ Tauri event bridge (Claude A11 deep-dive absorption). Two contracts: 1. `EventBridge` — high-level publish/subscribe over typed `BridgePayload` events. Loopback delivery to local subscribers, transp...

- Public surface: `BridgeEvent`, `BridgeOutcomeSummary`, `BridgePayload`, `BridgePermissionPreview`, `BridgeSessionMeta`, `BridgeTransport`, `createEventBridge`, `CreateEventBridgeOpts`, `createInMemoryHub`, `createInMemoryTransport`, `createStdioTransport`, `CreateStdioTransportOpts`, `createWebSocketServerTransport`, `EventBridge`, `exportSession`, `ImportError`, `ImportErrorKind`, `importSession`, `ImportSessionOpts`, `InMemoryHub`, `isoNow`, `isWireEnvelope`, `metaToPortable`, `parsePortableSession`, `PORTABLE_SESSION_VERSION`, `PortableSessionImportError`, `PortableSessionV1`, `StdioReader`, `StdioWriter`, `udsSocketPath`, `udsSocketSuffix`, `WebSocketLike`, `WireEnvelope`, `wrapDuplexAsUdsTransport`, `wrapWebSocketLikeAsTransport`
- Hellgate: _(none)_

### `@/llm`

> (no description)

- Public surface: `__resetUnknownEventRateLimitForTests`, `ADAPTIVE_THINKING_FAMILIES`, `AnthropicAdapter`, `AssembledTurn`, `assembleFromEvents`, `BatchError`, `BatchProcessingStatus`, `BatchRequest`, `BatchRequestCounts`, `BatchResult`, `BatchResultEntry`, `buildModelPinnedPort`, `BUILTIN_MODEL_PRESETS`, `CloudKind`, `codexSpecRoute`, `codexSpecRouterEmittedActions`, `ContentBlock`, `CreateBatchInput`, `createCredentialSource`, `createLLM`, `CreateLLMOptions`, `createMessageBatchesClient`, `createMulticloudLLM`, `CreateMulticloudOptions`, `createStickyPresetResolver`, `CredentialHelperError`, `CredentialHelperErrorCode`, `CredentialSource`, `CredentialSourceOptions`, `DecodedProviderEvent`, `decodeSseEvent`, `decodeWsEvent`, `DEFAULT_EMPTY_STREAM_BREAKER_K`, `DEFAULT_HELPER_TTL_MS`, `DEFAULT_MODEL`, `DEFAULT_STREAM_TRACE_INTERVAL_MS`, `defaultResponsesContinuationStore`, `determinePhases`, `DocumentBlock`, `EMPTY_STREAM_BREAKER_ERROR_MARKER`, `EmptyStreamBreakerOpts`, `EnvLike`, `estimateTokensFromChars`, `FALLBACK_METRIC_NAMES`, `FallbackLLM`, `FallbackLLMOptions`, `FallbackMetricSink`, `GREEDY`, `hasPrewarm`, `hasToolUse`, `ImageBlock`, `isFallbackKind`, `isFallbackTrigger`, `isRefusalStopReason`, `isStreamEventContentful`, `JsonSchema`, `JsonSchemaType`, `KNOWN_EVENT_KINDS`, `laneLabeledPort`, `listModelPresets`, `LiveUsageKnobs`, `LlmCheckpoint`, `LLMPort`, `LlmPrewarmPort`, `LlmSurfaceId`, `LlmTransportId`, `logUnknownEventRateLimited`, `Message`, `MessageBatch`, `MessageBatchesClient`, `MessageBatchesClientOpts`, `MINTABLE_PROVIDERS`, `MissingApiKeyError`, `MODEL_CONTEXT_WINDOWS`, `ModelCandidate`, `ModelPreset`, `modelSupportsSamplingTemperature`, `ModelSwapRetryOptions`, `ModelWindow`, `MULTICLOUD_AUTH_ENV_KEYS`, `MULTICLOUD_DEFAULT_MODEL`, `MulticloudProviderId`, `NoAlternateModelError`, `normalizeModelFamily`, `OpenAIAdapter`, `OpenAIResponseFormatParam`, `OpenAIResponsesAdapter`, `ParsedSseFrame`, `parseSseFrame`, `pickNextModel`, `pickProvider`, `PresetError`, `prewarmLlm`, `PrewarmOutcome`, `PromptCacheRetention`, `Provider`, `PROVIDER_ENV_KEYS`, `ProviderEnv`, `ProviderId`, `RecoveryAction`, `ResolvedProvider`, `resolveModelForRole`, `resolveModelPreset`, `resolveModelWindow`, `resolveProvider`, `resolveRetryModel`, `resolveVendorApiKey`, `RESPONSE_FORMAT_ANTHROPIC_NOTE`, `ResponseFormat`, `ResponseFormatError`, `ResponsesCheckpoint`, `ResponsesContinuationEntry`, `responsesContinuationLlmPort`, `ResponsesContinuationMode`, `ResponsesContinuationObservation`, `ResponsesContinuationPhase`, `ResponsesContinuationReason`, `ResponsesContinuationStore`, `RetryDisposition`, `retryDispositionForKind`, `sampleTemperatureForCandidate`, `SelectPresetResult`, `ShellExecFn`, `ShellExecResult`, `splitSseFrames`, `StickyPresetResolver`, `StreamEvent`, `StreamInput`, `StreamProgressTraceOpts`, `streamWithModel`, `supportsAdaptiveThinking`, `SystemBlock`, `SystemPromptInput`, `TEMPERATURE_SAMPLE`, `TextBlock`, `ThinkingBlock`, `ThinkingConfig`, `toAnthropicForcedTool`, `ToolChoice`, `ToolResultBlock`, `ToolSchema`, `ToolUseBlock`, `toOpenAIResponseFormat`, `TraceTimer`, `tryCreateLLM`, `validateAgainstResponseSchema`, `validateResponseFormat`, `withEmptyStreamCircuitBreaker`, `withLiveUsage`, `withStreamProgressTrace`, `withTemperature`
- Hellgate: `tests/unit/llm-providers-fromsdkerror-16-hellgate.test.ts`

### `@/lsp` [ADR-0141]

> (no description)

- Public surface: `anyLspServerOnPath`, `CLANGD_BIN`, `ClangdAdapter`, `ClangdAdapterOptions`, `CodeAction`, `CodeActionDocumentEdit`, `CodeActionKind`, `CodeActionPort`, `CodeActionPos`, `CodeActionRange`, `CodeActionTextEdit`, `CodeActionWorkspaceEdit`, `DefaultCodeActionAdapter`, `DefaultFormatAdapter`, `DefaultRenameApplyAdapter`, `DefaultSignatureHelpAdapter`, `Diagnostic`, `DiagnosticSeverity`, `FormatPort`, `FormatPos`, `FormatRange`, `GOPLS_BIN`, `GoplsAdapter`, `GoplsAdapterOptions`, `Hover`, `languageIdFor`, `Location`, `LSP_SERVER_BINS`, `LSP_SERVER_REGISTRY`, `LspClient`, `LspClientOptions`, `LspClientSpec`, `lspExtensionToServerBin`, `LspPort`, `LspRequestError`, `lspServerBinForExtension`, `lspServerBinForFile`, `LspServerInfo`, `LspServerRegistryEntry`, `Pos`, `PYRIGHT_LANGSERVER_BIN`, `PyrightAdapter`, `PyrightAdapterOptions`, `Range`, `RenameApplyPort`, `RenameDocumentEdit`, `RenamePos`, `RenamePreview`, `RenameRange`, `RenameTextEdit`, `RenameWorkspaceEdit`, `RUST_ANALYZER_BIN`, `RustAnalyzerAdapter`, `RustAnalyzerAdapterOptions`, `SignatureHelpPort`, `SignatureInfo`, `SignatureParameter`, `SymbolInfo`, `SymbolKind`, `TextEdit`, `TYPESCRIPT_LANGUAGE_SERVER_BIN`, `TypescriptAdapter`, `TypescriptAdapterOptions`
- Hellgate: `tests/unit/lsp-call-hierarchy-adapter-hellgate.test.ts`

### `@/mcp`

> MCP (Model Context Protocol) stdio client — public API. Selective re-export only: framing internals (LineReader, codec) stay private to the slice.

- Public surface: `backoffDelay`, `BackoffPolicy`, `buildMcpServer`, `CapabilityNegotiator`, `clientTasksPort`, `cliPrompter`, `CliPrompterIO`, `CreateMessageRequest`, `CreateMessageResult`, `DEFAULT_BACKOFF_POLICY`, `DEFAULT_PAGE_SIZE`, `defaultNegotiator`, `defaultTasksPort`, `DefaultTaskStore`, `ElicitationFailureReason`, `ElicitationLeasePool`, `ElicitationPrompter`, `ElicitationResult`, `enumOptionLabel`, `extractMedia`, `fullNegotiator`, `FullNegotiatorOptions`, `headlessOAuthRejecter`, `headlessRejecter`, `headlessSamplingRejecter`, `HttpFetchFn`, `HttpFetchResponse`, `HttpSseMcpTransport`, `HttpSseTransportOpts`, `isProgressMethod`, `isResourceNotificationMethod`, `isRootsMethod`, `isSamplingMethod`, `isSupportedProtocolVersion`, `LATEST_PROTOCOL_VERSION`, `LeaseContext`, `MAX_RESULT_CHARS`, `MCP_ROOTS_LIST_METHOD`, `MCP_SAMPLING_METHOD`, `McpCallResult`, `McpCapabilityRecord`, `McpClient`, `McpClientFactory`, `McpClientTransport`, `McpCompletionArgument`, `McpCompletionRef`, `McpCompletionResult`, `McpError`, `McpMediaBlock`, `McpOAuthProviderPort`, `McpProgress`, `McpProgressHandler`, `McpPrompt`, `McpPromptArgument`, `McpPromptMessage`, `McpPromptResult`, `McpReconnectSupervisor`, `McpResource`, `McpResourceContent`, `McpResourceFailure`, `McpResourceNotification`, `McpResourceObserver`, `McpResourceTemplate`, `McpResult`, `McpRoot`, `McpServer`, `McpServerConfig`, `McpServerCtorOptions`, `McpServerOptions`, `McpTaskInfo`, `McpTasksPort`, `McpToolAnnotations`, `McpToolDef`, `McpTransport`, `McpTransportExitHandler`, `McpTransportMessageHandler`, `McpTransportPayload`, `parseCompletionResult`, `parseProgress`, `parseResourceTemplateList`, `PendingPolicy`, `pollTask`, `PROGRESS_MAX_MESSAGE_CHARS`, `PROGRESS_METHOD`, `PROMPT_LIST_CHANGED_METHOD`, `PROTOCOL_DOWNGRADE_FLOOR`, `resolveOfferedVersion`, `RESOURCE_LIST_CHANGED_METHOD`, `RESOURCE_UPDATED_METHOD`, `RootsListResponse`, `RootsProviderPort`, `routeResourceNotification`, `routeRootsList`, `routeSampling`, `SAMPLING_DECLINED_CODE`, `SamplingDeclineReason`, `SamplingHandlerPort`, `SamplingMessage`, `SamplingOutcome`, `SamplingResponse`, `sanitizeAnnotations`, `ServerToolSpec`, `StdioMcpTransport`, `StdioSpawnFn`, `StdioTransportOpts`, `SupervisableMcpClient`, `SupervisorDeps`, `SupervisorSnapshot`, `SupervisorState`, `SUPPORTED_PROTOCOL_VERSIONS`, `SupportedProtocolVersion`, `TaskCancelResult`, `TaskListOutcome`, `TaskListPage`, `TaskResult`, `tasksPortOver`, `TasksRpc`, `TaskState`, `TERMINAL_TASK_STATES`, `ToolCallPort`, `ToolListSource`, `unsupportedTypeMarker`, `urlRequestSchema`
- Hellgate: `tests/unit/mcp-elicitation-inbound-hellgate.test.ts`

### `@/media`

> (no description)

- Public surface: _(none parsed)_
- Hellgate: _(none)_

### `@/memory` [ADR-0068]

> (no description)

- Public surface: `AppliesTo`, `assembleDreamPolicy`, `bucketOf`, `cosine`, `createWorkingMemory`, `CrossSessionDreamTrigger`, `CrossSessionDreamTriggerOpts`, `DEFAULT_DREAM_POLICY`, `DEFAULT_DUPE_THRESHOLDS`, `DEFAULT_EVICTION_CAPS`, `DEFAULT_RECALL_LIMIT`, `deserializeVec`, `DREAM_LOCK_KEY`, `DREAM_LOCK_TTL_MS`, `DreamConfigView`, `DreamConsolidatePort`, `DreamConsolidateResult`, `DreamError`, `DreamLockPort`, `DreamOutcome`, `DreamPolicy`, `DreamSlot`, `DreamState`, `DreamStatePort`, `DreamTelemetryPort`, `DreamWriteTargetPort`, `DupeThresholds`, `EMBED_DIM`, `EmbedderPort`, `EVICTION_DECAY`, `EvictionCaps`, `EvictionPlan`, `FileDreamWriteTarget`, `findNearDuplicates`, `FORBIDDEN_TELEMETRY_KEYS`, `FRESH_MAX_MS`, `FreshnessBucket`, `InMemoryDreamState`, `InMemoryStore`, `MEMORY_CONSOLIDATE_MIN_TURNS`, `MEMORY_KINDS`, `MEMORY_SUMMARY_MAX_BYTES`, `MEMORY_TIERS`, `MemoryEntry`, `MemoryKind`, `MemoryOutcome`, `MemoryQuery`, `MemoryTelemetryPort`, `MemoryTier`, `MemoryWriteError`, `MemoryWriter`, `noopDreamTelemetry`, `noopMemoryTelemetry`, `normalize`, `NormalizedEntry`, `normalizeEntry`, `PersistentStorePort`, `PHASE1_EVENT_ALLOWED_KEYS`, `Phase1DistillError`, `Phase1Input`, `Phase1Outcome`, `Phase1OutcomeKind`, `Phase1Port`, `Phase1TelemetryEvent`, `PHASE2_AUTO_TRIGGER_MAX_AGE_MS`, `PHASE2_AUTO_TRIGGER_PENDING`, `PHASE2_EVENT_ALLOWED_KEYS`, `Phase2ConsolidateError`, `Phase2Input`, `Phase2Outcome`, `Phase2OutcomeKind`, `Phase2Port`, `Phase2Summarizer`, `Phase2TelemetryEvent`, `planEviction`, `rankEntries`, `RECALL_EVENT_ALLOWED_KEYS`, `RecallTelemetryEvent`, `RECENT_MAX_MS`, `resolveDreamTeamPath`, `RoutingContext`, `runPhase1`, `runPhase2`, `scoreEntry`, `serializeVec`, `SqliteStore`, `Stage1Output`, `Stage1Store`, `Stage1StorePort`, `STALE_MAX_MS`, `StoredMessage`, `WatermarkConflictError`, `WatermarkState`, `WorkingMemory`
- Hellgate: `tests/unit/memory-fence-no-llm-import-hellgate.test.ts`

### `@/migration` [ADR-0038]

> External-agent import slice (ADR-0038, Cluster D Feature 4). Public re-exports for the migration slice. Slice isolation: only `@/ agent` (and the migration slice's own tests) may import from this index.

- Public surface: `ALL_PROVIDERS`, `appendImportLog`, `claudeCodeTranslator`, `contentSha256`, `contentSha256OfText`, `CredentialReadBannedError`, `defaultImportLogSync`, `DetectedAgent`, `detectExternalAgents`, `detectorContracts`, `ExternalAgentProvider`, `ExternalSessionId`, `ImportEvent`, `ImportEventSink`, `ImportLog`, `ImportLogBusyError`, `ImportLogEntry`, `importLogPath`, `ImportLogSync`, `ImportResult`, `ImportStage`, `isCredentialPath`, `loadImportLog`, `readImportFile`, `runImport`, `RunImportOptions`, `SessionTranslator`, `TranslatableProvider`, `TranslatedHook`, `TranslatedMcpServer`, `TranslatedRule`, `TranslatedSession`, `translateHooks`, `translateMcpServers`, `translateRules`, `translatorFor`, `UnknownProviderRejectedError`, `wasAlreadyImported`
- Hellgate: `tests/unit/migration-import-redaction-hellgate.test.ts`

### `@/observability`

> (no description)

- Public surface: `__resetSpanSink`, `accumulateWorkMetrics`, `attrs`, `Attrs`, `buildCostDashboard`, `buildLlmCostMetricsSink`, `buildMemoryTelemetry`, `buildShellOtelObserver`, `buildWorkMetrics`, `CostDashboard`, `costUsd`, `Counter`, `createTurnTimingCapture`, `emitLlmCostToOtel`, `endSpan`, `ERROR_ATTRS`, `FileDiffStat`, `Gauge`, `GEN_AI_ATTRS`, `getActiveTraceRef`, `getSpanSink`, `instrumentToolsForExport`, `LlmCostLabels`, `LlmCostSink`, `log`, `LogRecord`, `LogSink`, `makeContextOnlySpanSink`, `markSpanScoped`, `MEMORY_TELEMETRY_KEYS`, `mergeAttrs`, `metrics`, `Metrics`, `MetricsSnapshot`, `MODEL_RATE_CARD`, `ModelPrice`, `MonotonicClock`, `parseNumstat`, `permissionAttrs`, `postDenialAttrs`, `PREVIEW_MAX`, `previewPayload`, `PRICING_VERSION`, `Provider`, `providerOf`, `QUANTA_ATTRS`, `QUANTA_SPAN_NAMES`, `recordAttrs`, `renderDashboardMarkdown`, `renderDashboardText`, `safeTtftMs`, `setSpanSink`, `Span`, `SPAN_NAMES`, `SpanName`, `SpanSink`, `SpanStatus`, `spanTraceRef`, `startSpan`, `StructuredLogger`, `StructuredLoggerOptions`, `summarizeWorkMetrics`, `Timer`, `TimerStats`, `TimerStop`, `TraceRef`, `TurnTiming`, `TurnTimingCapture`, `WorkMetrics`, `workMetricsAttrs`
- Hellgate: `tests/unit/observability-emitter-hellgate.test.ts`

### `@/patch` [ADR-0464]

> V4A apply_patch — public API barrel. Stable surface for consumers (agent / tool slice). Internal modules are not exported; cross-slice imports go through this file.

- Public surface: `AppliedChange`, `ApplyChangeType`, `applyPatch`, `applyPatchStructured`, `ApplyResult`, `Change`, `Hunk`, `isUnifiedDiff`, `messageForModel`, `parsePatch`, `Patch`, `PatchAnchorNotFoundError`, `PatchApplyError`, `PatchFileSystemPort`, `PatchObservation`, `PatchObserver`, `PatchOp`, `PatchParseError`, `PatchTracePort`, `StructuredApplyOutcome`, `unifiedDiffToV4A`
- Hellgate: `tests/unit/patch-structured-apply-hellgate.test.ts`

### `@/permission` [ADR-0135, ADR-0453, ADR-0497]

> ADR-0135 — Permission profile + file_system_sandbox_policy 2-layer.

- Public surface: `__resetAutoApprovalReviewObserver`, `__resetDefaultPermissionStore`, `__resetPermissionRecorder`, `AccessVerdict`, `ActionAssessment`, `actionMatchesPrefixGrant`, `ALL_ASSESSMENT_KINDS`, `ALL_AUTORUN_ELIGIBILITY_REASONS`, `ALL_AUTORUN_PRIOR_OUTCOMES`, `ALL_GIT_WRITE_PROTECT_REASONS`, `ALL_OUTCOMES`, `ALL_PERMISSION_MODES`, `ALL_REASON_CODES`, `ALL_REVIEW_DECISION_VERBS`, `ALL_REVIEW_KINDS`, `ALL_REVIEWERS`, `APPROVAL_LADDER`, `APPROVAL_LADDER_NAMES`, `APPROVAL_RANK`, `ApprovalDecision`, `ApprovalLadderName`, `ApprovalMode`, `approvalModeToContextMode`, `ApprovalOutcome`, `ApprovalPolicy`, `ApprovalRecord`, `ApprovalReviewer`, `ApprovalReviewerOpts`, `AssessmentEscalation`, `AssessmentKind`, `AUTO_MODE_BASELINES`, `AUTO_MODE_DEFAULTS_SENTINEL`, `AutoApprovalReviewEvent`, `AutoApprovalReviewObserver`, `AutoDecision`, `AutoModeClassifier`, `AutoModeOverlay`, `autoPassByPatterns`, `AutoPassInput`, `AutoPassOptions`, `AutoPassResult`, `autoResolvable`, `AutorunApprovalPolicy`, `AutorunEligibility`, `AutorunEligibilityInput`, `AutorunEligibilityReason`, `AutorunMode`, `AutorunPriorOutcome`, `AxisOutcome`, `AxisStep`, `BranchOnlyVerdict`, `buildAutoModeOverlay`, `buildAutorunEligibility`, `buildDecision`, `buildDefinition`, `CachedResolver`, `canAccess`, `CanAccessOpts`, `canonicalizeEffectPath`, `CIRCUMVENTION_TAXONOMY_LINE`, `CIRCUMVENTION_TTL_TURNS`, `CircumventionSignal`, `CircumventionTracker`, `ClassifiedCommand`, `CLASSIFIER_SYSTEM_PROMPT`, `ClassifierPort`, `classifyCommand`, `ClassifyDecision`, `ClassifyRequest`, `clearDenialRecord`, `clearHostMode`, `clearThreadPermission`, `collapseAssessment`, `computeActionSignature`, `computeSubcommandTokens`, `ConfigLayer`, `containsPath`, `ControlManagedBy`, `ControlPolicy`, `createApprovalReviewer`, `createCachedResolver`, `createInMemoryTrustScopeRegistry`, `CreatePermissionInspectorOptions`, `createPermissionStore`, `CreatePermissionStoreOptions`, `createPersistentTrustScopeRegistry`, `createTwoLayerManager`, `CwdPort`, `decideBranchOnly`, `decideFloor`, `DEFAULT_FILE_SYSTEM_SANDBOX_POLICY`, `DEFAULT_PERMISSION_PROFILE`, `DEFAULT_PROTECTED_BRANCHES`, `defaultCwdPort`, `defaultOsPort`, `defaultProjectOverlayPath`, `defaultStateFilePath`, `defaultTrustScopeStatePath`, `DENIAL_LIMITS`, `DenialMemory`, `DenialPrecedenceConflictError`, `DenialRecord`, `DenialState`, `DENY_LAYERS`, `DENY_PILLARS`, `denyContentPrefix`, `DenyLayer`, `DenyPillar`, `derivePrefixGrantKey`, `EffectiveAccessResult`, `EffectSignature`, `emitPermissionDecision`, `emitPostDenialEvent`, `evaluate`, `evaluateAuto`, `EvaluateAutoOptions`, `evaluateAutorunEligibility`, `evaluateStack`, `EvaluateStackOptions`, `exceedsCeiling`, `EXFIL_SCOUTING_TAXONOMY_LINE`, `extractShellWritePaths`, `extractWriteEffect`, `extractWriteEffects`, `FallThroughReason`, `FieldCombiner`, `FieldCombinerSpec`, `FileSystemAccess`, `FileSystemEntry`, `FileSystemPath`, `FileSystemPolicyType`, `FileSystemSandboxPolicy`, `finalDecisionFor`, `FloorVerdict`, `getDefaultPermissionStore`, `getDenialRecord`, `getHostMode`, `getPermissionInspector`, `getPermissionRecorder`, `getThreadPermission`, `GitPort`, `gitWriteProtectReason`, `GitWriteProtectReason`, `grantAndCascade`, `grantPatterns`, `hardDenyReason`, `hardDenySafeReason`, `hasPostDenialOverride`, `HITLTier`, `HostAgentMode`, `hostAllowsMutation`, `inferApprovalPolicy`, `inferControlPolicy`, `inferNetworkPolicy`, `inferReviewKind`, `inferSandboxPolicy`, `inferSuggestedAllowlistEntry`, `inferToolTier`, `inferToolTierDetailed`, `InspectAction`, `inspectPermission`, `InspectToolMeta`, `isAdmissible`, `isAllowed`, `isDecisionLegalFor`, `isExecutionBlocking`, `isGitWriteProtected`, `isLayerSource`, `isNamedProfileName`, `isPermissionMode`, `isPermissionScope`, `isSimpleCommand`, `isSpecialPathKind`, `isTerminal`, `LAYER_SOURCE_PRECEDENCE_ASC`, `LayeredRule`, `LayerSource`, `layerSourceRank`, `LearningSource`, `listHardDenyRuleDescriptors`, `listPermissionProfiles`, `ListProfilesOptions`, `MatchedHardDenyRule`, `mergeLayered`, `MergeOptions`, `mergeOverlayCategory`, `mergeProfileLayers`, `MergeResult`, `MergeStrategy`, `ModePolicyMatrix`, `ModeVerdict`, `NAMED_PROFILE_NAMES`, `NAMED_PROFILES`, `NamedApprovalLadderRung`, `NamedProfileName`, `NETWORK_RANK`, `NetworkMode`, `NetworkPolicy`, `OsFamily`, `OsPort`, `OsSandboxKind`, `OutcomeInvariantError`, `OverriddenMetadata`, `parseApprovalLadderName`, `parseUserProfile`, `parseUserProfileDefinition`, `PatternGrantStore`, `PendingPermission`, `PERMISSION_AXES`, `PERMISSION_SCOPE_PRECEDENCE_DESC`, `PermissionAxis`, `PermissionContext`, `PermissionDecidedBy`, `PermissionDecision`, `PermissionDecisionRecord`, `PermissionDenyDecision`, `PermissionDenySource`, `PermissionInspection`, `PermissionInspector`, `PermissionMode`, `permissionModeFromProfile`, `PermissionOutcomeLabel`, `PermissionProfile`, `PermissionReader`, `PermissionRecorder`, `PermissionRiskLevel`, `PermissionSandboxPolicy`, `PermissionScope`, `PermissionSoftDenySource`, `PermissionStackContext`, `PermissionStackSource`, `PermissionState`, `PermissionStore`, `PersistentTrustScopeOptions`, `PersistentTrustScopeRecord`, `PersistentTrustScopeRegistry`, `PostDenialAction`, `PostDenialClock`, `PostDenialEventKind`, `PostDenialEventRecord`, `prefixGrantLabel`, `PROFILE_COMBINERS`, `PROFILE_RESTRICTIVENESS`, `ProfileDefinition`, `ProfileDefinitionRegistry`, `ProfileInheritanceError`, `ProfileLayerSlots`, `ProfileListEntry`, `ProfileLoadErrorMode`, `ProfileSelectError`, `ProfileTag`, `ProfileValidationError`, `ProposePatternInput`, `ProposePatternResult`, `ProposeRejectReason`, `ReasonCode`, `reasonCodeFor`, `recordDenial`, `recordProposedPattern`, `recordRiskSeen`, `recordUserOverride`, `requiresUserConfirmation`, `ResolutionExplanation`, `ResolutionSource`, `resolveHostId`, `ResolveInheritanceOpts`, `resolvePermissionProfileField`, `resolvePolicyLayers`, `resolveProfileByName`, `resolveProfileInheritance`, `resolveSpecialPath`, `ResolveSpecialPathOpts`, `RestrictivenessSpec`, `reviewAction`, `ReviewContext`, `ReviewDecision`, `ReviewDecisionVerb`, `ReviewerPort`, `ReviewerSandboxProfile`, `ReviewerTier`, `ReviewerUnavailableError`, `ReviewKind`, `selectDefaultReviewer`, `selectPermissionProfile`, `SelectProfileOptions`, `setAutoApprovalReviewObserver`, `setHostMode`, `setPermissionRecorder`, `setThreadPermission`, `SPECIAL_PATH_KINDS`, `SpecialPathKind`, `STAGE1_BOTH_TAIL`, `STAGE1_FAST_TAIL`, `STAGE2_THINKING_TAIL`, `stopCategoryFor`, `strongerScope`, `structuredDenyReason`, `StructuredDenyReason`, `StructuredDenyReasonInput`, `threadAllowsMutation`, `ThreadPermission`, `ToolAction`, `ToolActionKeyed`, `ToolCapability`, `TrustScope`, `TrustScopeAction`, `TrustScopeGrant`, `TrustScopeRegistry`, `TwoLayerManager`, `withCircumventionContext`, `withExfilScoutingTaxonomy`, `withUserRuleOverlay`
- Hellgate: `tests/unit/permission-host-custom-fail-closed-hellgate.test.ts`

### `@/plugin-isolation` [ADR-0162]

> Plugin process isolation slice (ADR-0162). Barrel.

- Public surface: `CallOpts`, `createBunSpawner`, `DEFAULT_CALL_TIMEOUT_MS`, `DEFAULT_GRACEFUL_KILL_MS`, `DEFAULT_LIFECYCLE_POLICY`, `DEFAULT_SPAWN_TIMEOUT_MS`, `DxtError`, `DxtErrorKind`, `DxtManifest`, `DxtManifestSchema`, `HEARTBEAT_PING_METHOD`, `HEARTBEAT_PONG_METHOD`, `IsolatedProcess`, `IsolatedProcessSpawnerPort`, `IsolatedSpawnError`, `launchDxt`, `LifecycleError`, `LifecycleOpts`, `LifecyclePolicy`, `LifecycleState`, `MAX_DXT_MANIFEST_BYTES`, `MAX_MESSAGE_BYTES`, `PluginHost`, `PluginHostError`, `PluginHostOpts`, `PluginLifecycleManager`, `PUMP_DEATH_EXIT_GRACE_MS`, `SpawnOpts`, `validateDxt`
- Hellgate: `tests/unit/plugin-isolation-spawner-hellgate.test.ts`

### `@/radar` [ADR-0231]

> `@/radar` slice barrel — ADR-0231 (radar cards proposal queue MVP). Surface: - `RadarStore` port (5 methods) + 2 adapters + 1 headless stub - 1 sample heuristic Default-OFF: no other slice imports `@/radar` in V1. The store is constructe...

- Public surface: `BugFixHypothesis`, `BugFixProposalMetadata`, `CardKind`, `CardStatus`, `HeadlessRadarStore`, `IdleLongTaskInputs`, `InMemoryRadarStore`, `InMemoryRadarStoreOpts`, `JsonlFileRadarStore`, `JsonlFileRadarStoreOpts`, `proposeOnIdleForLongTask`, `ProposeOpts`, `RadarCard`, `RadarError`, `RadarOpError`, `RadarStore`
- Hellgate: _(none)_

### `@/reactor` [ADR-0132]

> Public seam for `@/reactor` — ADR-0132 autonomous proactive reactor. Only ports + factory functions are exported. Internal helpers (snippet clamps, in-memory stores) stay module-local; the composition root binds the production adapters a...

- Public surface: `AgentLoopPort`, `ALL_TRIGGER_REASONS`, `AutorunVerdict`, `CiTriggerOpts`, `ClockPort`, `createCiTriggerSource`, `createInMemorySeenRuns`, `createInMemoryWatermarkStore`, `createPrCommentTriggerSource`, `EnvPort`, `GhCliPort`, `GhCliResult`, `injectSimulatedTurn`, `LastTurnOutcome`, `lastTurnOutcomeFromAgentOutcome`, `PrCommentTriggerOpts`, `ProactiveTrigger`, `QUIET_WINDOW_MS`, `REACTOR_ENV_FLAG`, `ReactorSelfWakeEvent`, `SeenRunsStore`, `SelfWakeOpts`, `SelfWakeResult`, `SnapshotSeenRunsStore`, `TriggerEvidence`, `TriggerReason`, `TriggerSourcePort`, `WatermarkStore`
- Hellgate: `tests/unit/reactor-pr-comment-watermark-hole-hellgate.test.ts`

### `@/realtime` [ADR-0230]

> Realtime slice barrel (ADR-0230). Codex absorption — bidirectional WebSocket port + Bun-native adapter + deterministic headless stub + SDP/codec helpers. 8-method surface mirroring Codex Desktop's realtime API. Plane-clean: only `@/share...

- Public surface: `AudioCodec`, `BunAdapterOpts`, `createBunWebSocketAdapter`, `createHeadlessStub`, `DEFAULT_CODEC_PREFERENCE`, `HeadlessStubHandle`, `HeadlessStubOpts`, `negotiateCodec`, `negotiateSdp`, `RealtimeConnectOpts`, `RealtimeError`, `RealtimeFrame`, `RealtimeInboundMessage`, `RealtimeMessageHandler`, `RealtimeOutboundSignal`, `RealtimePort`, `RealtimeStatus`, `RealtimeUnsubscribe`, `SdpAnswer`, `StubOutbound`, `VoiceInfo`, `VoicesProvider`, `WebSocketCtor`, `WebSocketLike`, `wrapAudioChunk`
- Hellgate: _(none)_

### `@/remote` [ADR-0288]

> ADR-0288/0289 — `@/remote` slice barrel. Public surface for the remote execution plane (E6 productization). Currently re-exports the runner sub-slice — future sub-slices (e.g. git-remote integration, PR auto-attach) can land alongside wi...

- Public surface: _(none parsed)_
- Hellgate: _(none)_

### `@/retrieval` [ADR-0159]

> `@/retrieval` slice barrel — ADR-0159. Five axes, exposed as a single surface so assemblers in `@/agent` wire one import path. Adapters live INSIDE the slice (every adapter is "compose vendor X with our generic port" — no slice-isolation...

- Public surface: `ALL_LEXICAL_ERROR_KINDS`, `Bm25LexicalSearchOptions`, `Bm25SecondaryOptions`, `BUCKET_TOKENS`, `CandidateTier`, `ChunkBucket`, `ChunkBucketOptions`, `CodebaseIndexer`, `CodeParserPort`, `CohereEmbedderOptions`, `CommitEmbedder`, `CommitEmbedderOptions`, `CommitNote`, `CommitNoteWithEmbedding`, `createBm25LexicalSearch`, `createBm25SecondaryReranker`, `createBunRipgrepSpawner`, `createCohereEmbedder`, `createCommitEmbedder`, `createDefaultIndexer`, `createGeminiEmbedder`, `createMoonshotEmbedder`, `createNvidiaEmbedder`, `createOpenAIEmbedder`, `createRipgrepLexicalSearch`, `createTierAwareReranker`, `createTreeSitterParser`, `createVoyageEmbedder`, `createXaiEmbedder`, `createZaiEmbedder`, `DeclNode`, `DEFAULT_OVERLAP_RATIO`, `DEFAULT_TIER_PENALTY`, `DeltaPartition`, `DeltaTracker`, `EmbeddingAdapterOptions`, `EmbeddingPort`, `EmbeddingsHttp`, `EmbeddingVendor`, `fakeParser`, `FakeParser`, `FileStamp`, `fuseByRrf`, `GeminiEmbedderOptions`, `GitLogPort`, `headlessIndexerStub`, `headlessLexicalStub`, `HeadlessLexicalStubOptions`, `HybridQueryInput`, `identityReranker`, `IndexerChunkerOptions`, `indexerChunkFile`, `indexerChunkFileSyntactic`, `IndexerChunkInput`, `IndexerChunkUpsertPort`, `IndexerFileChunk`, `IndexerOptions`, `IndexError`, `IndexerScanOptions`, `IndexStats`, `langForPath`, `LexicalDegradeReason`, `LexicalDoc`, `LexicalError`, `LexicalErrorKind`, `LexicalHit`, `LexicalIndexResult`, `LexicalQueryOptions`, `LexicalSearch`, `MoonshotEmbedderOptions`, `NvidiaEmbedderOptions`, `OpenAIRetrievalEmbedderOptions`, `ParsedFile`, `ParseLang`, `ParseOutcome`, `QueryType`, `rechunk`, `RerankerKind`, `RerankInput`, `RerankPort`, `RerankRegistry`, `RetrievalCandidate`, `RetrievalError`, `RipgrepLexicalSearchOptions`, `RipgrepSpawner`, `RipgrepSpawnOptions`, `RipgrepSpawnResult`, `RRF_K`, `rrfReranker`, `runHybridQuery`, `ScannerOptions`, `SkipReason`, `TierAwareOptions`, `TierClassifierPort`, `TokenizerPort`, `tokenizeUtf8`, `VoyageEmbedderOptions`, `VoyageHttp`, `XaiEmbedderOptions`, `ZaiEmbedderOptions`
- Hellgate: `tests/unit/retrieval-embedding-multi-vendor-hellgate.test.ts`

### `@/rules` [ADR-0031, ADR-0205]

> Prefix-rule allowlist DSL — barrel. This slice is consumed by the admissibility-gate (per ADR-0031). Callers SHOULD import from `./index` (or `@/rules` when the path alias is added) and NOT reach into individual sub-modules — the barrel ...

- Public surface: `createDefaultVendorDetector`, `DEFAULT_MAX_BODY_BYTES`, `DEFAULT_MAX_FILES`, `DetectedRule`, `DetectionResult`, `DetectOptions`, `DetectorError`, `matchArgvRule`, `matchCommand`, `MatchOutcome`, `normalizeOne`, `parseArgvArrayLiteral`, `ParserKind`, `parseRules`, `PathEntry`, `PathKind`, `resolveCollisions`, `Rule`, `RuleAction`, `RuleConflictError`, `RuleLayer`, `RuleParseError`, `RuleScope`, `RulesSnapshot`, `RulesStore`, `RuleTrigger`, `tokenizeArgv`, `VENDOR_PRIORITY`, `VENDOR_TABLE`, `VendorDescriptor`, `VendorDetectorPort`, `VendorId`
- Hellgate: _(none)_

### `@/runner`

> `@/runner` — surface-agnostic Layer-2 orchestration slice. Contains: - `assemble/` — typed-config → built collaborators (LLM, Store, Memory, …). Input is plain config objects; NO `process.env` / `argv` reading. Surface entry (CLI/Web/Tau...

- Public surface: _(none parsed)_
- Hellgate: `tests/unit/runner-storage-leak-hellgate.test.ts`

### `@/runtime`

> (no description)

- Public surface: `__resetShellSandbox`, `applyLocalEnv`, `BackgroundDetachSeam`, `buildBaseShellArgv`, `createPersistentWorktree`, `createPpidWalkKiller`, `DEFAULT_ENV_ALLOWLIST`, `DEFAULT_SANDBOX_EXEC_PATH`, `defaultPpidWalkKiller`, `discoverShells`, `DockerSandbox`, `DockerSandboxOptions`, `escalatingKill`, `EscalatingKill`, `getShellSandbox`, `GuardedSpawnHooks`, `installShellSandbox`, `isGitRepo`, `isTransientWorktreeLockError`, `KILL_GRACE_MS`, `KillableChild`, `loadLocalEnvConfig`, `LoadLocalEnvResult`, `LOCAL_ENV_CANDIDATES`, `LocalEnvConfig`, `LocalEnvParseErrorReason`, `LocalEnvParseResult`, `LocalEnvSelection`, `LocalSandbox`, `MAX_WORKTREE_LOCK_RETRIES`, `OsSandboxPolicy`, `OsSandboxProfile`, `parseLocalEnvConfig`, `parsePsTable`, `PersistentWorktree`, `POSIX_SHELL_ARGV`, `PpidWalkDeps`, `ProcessRow`, `ProcessTableProvider`, `ProcessTreeKiller`, `removeWorktree`, `resolveSandboxProfileFromEnv`, `resolveWinShellMode`, `runShell`, `RunShellEvent`, `runWorktreeAddWithRetry`, `Sandbox`, `SandboxPolicy`, `SandboxPolicyError`, `SandboxUnavailableError`, `scrubEnv`, `selectEnvironment`, `ShellArgvDecision`, `ShellDialect`, `ShellOptions`, `ShellProbe`, `ShellResult`, `ShellSandboxSlot`, `SignalSender`, `TomlParse`, `TreeSignal`, `WinShellMode`, `withSpawnedChild`, `withWorktree`, `WORKTREE_LOCK_BACKOFF_MS`, `WorktreeForkError`, `WrappedShellArgv`, `wrapShellArgv`
- Hellgate: `tests/unit/runtime-config-knobs-default-parity-hellgate.test.ts`

### `@/scheduler` [ADR-0161, ADR-0215]

> ADR-0161 — Scheduled agent slice barrel. Re-exports the closed-port types, parsers, evaluator, store, model reroute, and runtime. Importers MUST go through this barrel; reaching into `@/scheduler/*` deep paths is allowed for adapter wiri...

- Public surface: `AgentLoopPort`, `ALL_AUTOMATION_KINDS`, `ALL_AUTOMATION_STATUSES`, `ALL_ENGINE_STATUSES`, `ALL_FREQUENCIES`, `ALL_WEEKDAYS`, `allOccurrencesInMonth`, `Automation`, `AutomationEnginePort`, `AutomationHandler`, `AutomationKind`, `AutomationRun`, `AutomationStatus`, `AutomationStoreError`, `AutomationStorePort`, `AutorunEligibilityResolverPort`, `AutorunVerdict`, `buildThreadDeeplink`, `chooseModel`, `ChooseModelOpts`, `ChooseModelResult`, `ClockPort`, `computeNextFire`, `createCronSlashAdapter`, `CronCreateResult`, `CronInboxRow`, `CronRow`, `CronSlashAdapterDeps`, `CronSlashState`, `daysInUtcMonth`, `EngineAutomation`, `EngineErrorResult`, `EngineResult`, `EngineStatus`, `ensureAutomationEngineSchema`, `EnvPort`, `Frequency`, `HeartbeatPolicySnapshot`, `InboxBuilder`, `InboxItem`, `inMemoryAutomationEngine`, `InMemoryAutomationEngine`, `InMemoryAutomationEngineOpts`, `iterateFires`, `listAutomationRuns`, `listInboxItems`, `MarkRunInput`, `ModelAvailabilityPort`, `ModelRerouteReason`, `nthWeekdayOfMonth`, `parseRRule`, `parseThreadDeeplink`, `parseWeekday`, `resolveThreadRoute`, `RRule`, `RRuleParseError`, `RRuleParseErrorCode`, `RRuleParseResult`, `ScheduleInput`, `SchedulerEvent`, `SchedulerSinkPort`, `serializeRRule`, `serializeWeekday`, `sqliteAutomationEngine`, `SqliteAutomationEngineOpts`, `THREAD_DEEPLINK_PREFIX`, `THREAD_WEB_PARAM`, `ThreadRouteIntent`, `TickOpts`, `TickOutcome`, `tickScheduler`, `Weekday`, `WeekdayDay`
- Hellgate: `tests/unit/scheduler-rrule-parser-hellgate.test.ts`

### `@/sdk`

> `quanta-codeagent/sdk` — the ONE public door for embedding quanta's agent loop in-process (jul-4 SDK embed DX plan). Consumers import ONLY from here. Nothing under `src/sdk/**` may import `@/apps/cli`, `@/apps/bench`, or `@/apps/agent` (...

- Public surface: `AgentEvent`, `AgentOutcome`, `AgentRun`, `AnalysisAgent`, `AnalysisAgentOptions`, `AnalysisProfile`, `ApprovalDecisionResult`, `ApprovalRespondCommand`, `ArtifactRef`, `CapabilityManifest`, `CommandReceipt`, `connect`, `ConnectOptions`, `ConnectWebSocket`, `ConnectWebSocketCtor`, `createAnalysisAgent`, `decodeSessionCommand`, `decodeSessionEvent`, `decodeSessionSnapshot`, `DEFAULT_EVENT_BUFFER`, `DEFAULT_PROFILE`, `defineTool`, `defineToolAsync`, `encodeSessionCommand`, `encodeSessionEvent`, `encodeSessionSnapshot`, `FakeCompletion`, `fakeLlm`, `ImageBlock`, `InputAppendCommand`, `isDone`, `isError`, `isText`, `isThinking`, `isToolCall`, `isToolResult`, `isUsage`, `LLMPort`, `Message`, `NoCredentialError`, `PendingApprovalView`, `RecordingStream`, `RunHooks`, `SESSION_PROTOCOL_VERSION`, `SessionClosedError`, `SessionCommand`, `SessionDispatchFailedError`, `SessionDuplicateCommandError`, `SessionEvent`, `SessionEventType`, `SessionHandle`, `SessionHandleClosedError`, `SessionHandleSnapshot`, `SessionProtocolError`, `SessionProtocolValidationError`, `SessionProtocolVersionError`, `SessionRevisionConflictError`, `SessionSnapshotLite`, `SessionStateView`, `SessionTransport`, `SessionTransportClientRejection`, `SessionTransportCloseInfo`, `SessionTransportConnectionState`, `SessionTransportMessage`, `SessionTransportSpec`, `SessionTurnCorrelationLossReason`, `SessionTurnCorrelationLostError`, `SessionTurnEndEvent`, `SessionVerbSurface`, `StdioTransportOptions`, `StopReason`, `Tool`, `ToolContext`, `ToolEvent`, `ToolRegistrationError`, `transports`, `TurnCancelCommand`, `TurnRunCommand`, `version`, `WsTransportOptions`
- Hellgate: _(none)_

### `@/security` [ADR-0078]

> Security module barrel (ADR-0078). Public surface for the agent loop and dispatch seam to consume.

- Public surface: `assertKindWired`, `classifyCommandShape`, `classifyPath`, `NormalizedRedactionConfig`, `normalizeRedactionConfig`, `PiiRedactionConfig`, `REDACTION_DISABLED_WITHOUT_ACK_MESSAGE`, `RedactionConfig`, `RedactionConfigError`, `RedactionHit`, `RedactionKind`, `RedactionOrigin`, `RedactOptions`, `RedactResult`, `redactSecrets`, `SensitivityClass`
- Hellgate: `tests/unit/security-rails-interactive-cli-wire-hellgate.test.ts`

### `@/session` [ADR-0034]

> Session slice — id-addressable persistence (V2 schema). NEW rail alongside `src/agent/state.ts` (V1, path-based). V1 stays exactly as-is for legacy callers; new flows mint an opaque id and use this slice. Layout on disk: <root>/<id>.json...

- Public surface: `AnySessionExportEnvelope`, `appendEnvelope`, `appendSessionLine`, `ApprovalModeSchema`, `ApprovalPolicySchema`, `ApprovalPolicyStructSchema`, `archivedFilePath`, `archivedFilePathAsync`, `archiveSession`, `assignMessageIds`, `AttachOutcome`, `AttachSessionDeps`, `attachSessionToLive`, `buildCrashResumeMessage`, `buildCrashResumeOffer`, `buildRecoveryGuidance`, `checkSessionStoreHealth`, `clearSessionInterrupted`, `CollaborationModeSchema`, `ControlManagedBySchema`, `ControlPolicySchema`, `CRASH_RESUME_GATE`, `CRASH_RESUME_PARTIAL_GATE`, `crashResumeEnabled`, `CrashResumeOffer`, `crashResumePartialEnabled`, `DecisionOutcomeSchema`, `decodeSessionLine`, `defaultSessionRootProvider`, `deleteSession`, `detectInterruptedSessions`, `DynamicToolActionSchema`, `DynamicToolRecord`, `DynamicToolRecordSchema`, `EffortSchema`, `encodeSessionLine`, `EnvelopeDecodeError`, `EnvelopeDecodeErrorKind`, `EventDecisionSchema`, `EventMsgRecord`, `EventMsgRecordSchema`, `exportSession`, `exportSessionToFile`, `exportSessionToJson`, `FileSystemAccessSchema`, `FileSystemEntrySchema`, `FileSystemPathSchema`, `FileSystemPolicyTypeSchema`, `FileSystemSandboxPolicySchema`, `ForkOptions`, `ForkResult`, `forkSession`, `forkSessionAtMessage`, `importSession`, `importSessionFromFile`, `importSessionFromJson`, `indexFilePath`, `indexFilePathAsync`, `InterruptedSessionDetection`, `iterateSessionFile`, `listSessions`, `loadSessionById`, `markSessionInterrupted`, `NetworkModeSchema`, `NetworkPolicySchema`, `OsSandboxKindSchema`, `PermissionProfileField`, `PermissionProfileFieldSchema`, `PermissionProfileSchema`, `PermissionProfileStructSchema`, `PersistedInterruptedTurn`, `removeFromIndex`, `renameSession`, `resolveMessageIdPrefix`, `ResponseItemKindSchema`, `ResponseItemRecord`, `ResponseItemRecordSchema`, `RewindGitPort`, `RewindOptions`, `RewindResult`, `rewindSession`, `rewindToMessage`, `SandboxPolicySchema`, `SandboxPolicyStructSchema`, `sanitizeId`, `SavedSession`, `SavePayload`, `saveSessionById`, `SESSION_ENVELOPE_VERSION`, `SESSION_VERSION`, `sessionEnvelopePath`, `sessionEnvelopePathAsync`, `SessionEnvelopeRecord`, `SessionEnvelopeRecordSchema`, `SessionExportEnvelope`, `SessionExportEnvelopeV2`, `SessionExportOpts`, `SessionFileHealth`, `sessionFilePath`, `sessionFilePathAsync`, `SessionFileStatus`, `SessionIdError`, `SessionImportError`, `SessionImportErrorCode`, `SessionImportOpts`, `SessionImportResult`, `SessionMeta`, `SessionMetaRecord`, `SessionMetaRecordSchema`, `SessionRootProvider`, `sessionsRoot`, `sessionsRootAsync`, `SpecialPathKindSchema`, `staticSessionRootProvider`, `StoreHealthReport`, `StoreHealthVerdict`, `SUPPORTED_SESSION_ENVELOPE_VERSIONS`, `ThreadRoleSchema`, `ThreadSpawnRecord`, `ThreadSpawnRecordSchema`, `TruncationPolicySchema`, `TurnContextRecord`, `TurnContextRecordSchema`, `unarchiveSession`, `upsertMeta`
- Hellgate: `tests/unit/session-import-export-v2-hellgate.test.ts`

### `@/shared`

> (no description)

- Public surface: `__resetKnobOverrides`, `__resetLoggerRateLimit`, `__resetOperatorNoticeSinkForTest`, `__resetRuntimeConfig`, `__resetTerminalIo`, `__setLoggerNow`, `AbortableReadable`, `AbortableReader`, `abortableSleep`, `AbortError`, `AbortReasonKind`, `abortReasonOf`, `ActivationPolicy`, `AGENT_PROMPT_MODES`, `AgentPromptMode`, `ALL_ACTIVATION_POLICIES`, `ALL_DELIVERY_MODES`, `ALL_HITL_TIERS`, `assertNever`, `byteCompare`, `capFullFidelityField`, `chunkBatches`, `classify`, `classifyLspGroundingError`, `classifyToolItemType`, `currentLane`, `DeadlineFetchFn`, `DegradedData`, `DeliveryMode`, `dispatchNoThrow`, `dispatchNoThrowWith`, `drainAbortable`, `embedUntrusted`, `emitOperatorNotice`, `err`, `errMessage`, `escapeBoundary`, `EXECUTION_SURFACES`, `ExecutionSurface`, `fetchWithDeadline`, `FetchWithDeadlineOpts`, `filesFromUnifiedDiff`, `filterSessionForbidden`, `foldGroundingReceipts`, `FULL_FIDELITY_FLAG`, `FULL_FIDELITY_MAX_CHARS`, `fullFidelityEnabled`, `FullFidelityField`, `gateDisabled`, `gateDisabledStrict`, `gateOn`, `gateOnStrict`, `getKnobOverride`, `getTerminalIo`, `HeaderLookup`, `HITLTier`, `HITLTierReason`, `Id`, `installOperatorNoticeSink`, `isAbort`, `isAbortError`, `isAdmissibleGroundingOutcome`, `isDeliveryMode`, `isExpectedLifecycleOutcome`, `isFalsyToken`, `isLspGroundingOutcome`, `isRealGroundingFailure`, `isRecord`, `isSessionForbidden`, `isTestFilePath`, `isTrajectoryEvent`, `isTruthyToken`, `ITEM_DELTA_KIND_BY_ITEM_TYPE`, `ITEM_STREAM_FLAG`, `ITEM_TYPE_BY_TOOL_NAME`, `ItemStreamCompleted`, `ItemStreamCore`, `ItemStreamDelta`, `ItemStreamDeltaKind`, `itemStreamEnabled`, `ItemStreamItemType`, `ItemStreamPhase`, `ItemStreamSink`, `ItemStreamStarted`, `knobOverrideCount`, `knobOverrides`, `knobOverridesVersion`, `laneContext`, `levelEnabled`, `LlmContinuationObservation`, `LLMError`, `LLMErrorKind`, `LLMProvider`, `LlmRequestObservation`, `LlmUsageData`, `LOG_LEVEL_ORDER`, `LOG_LEVELS`, `LogCallSite`, `logger`, `Logger`, `LogLevel`, `LspGroundingErrorSignals`, `LspGroundingOutcome`, `LspGroundingReceipt`, `LspGroundingStage`, `LspGroundingStatus`, `LspGroundingSummary`, `makeEvent`, `MakeEventOpts`, `normalizePublicIssueText`, `NoThrowErrorSink`, `notifyAllNoThrow`, `ok`, `omitUndef`, `OperatorNotice`, `OperatorNoticeSink`, `parseActivationPolicy`, `parseBool`, `parseDeliveryMode`, `parseEnvFlag`, `parseLspGroundingStatus`, `parseRetryAfterMs`, `parseThinClientRoute`, `PatchData`, `PermissionDeniedError`, `Producer`, `PromptActiveLeversSnapshot`, `PromptBaseSystem`, `PromptHookContextMode`, `PromptPolicySnapshot`, `PromptSummaryPrefix`, `PromptSurfaceEnvPosture`, `PromptSurfacePack`, `PromptSurfaceProfileSnapshot`, `PromptSurfaceVerifyStrategy`, `PromptSystemLayout`, `PtyBackend`, `QuantaError`, `quantaHomeDir`, `quantaHomeDirFrom`, `quantaHomePath`, `ratelimitNoticeWanted`, `readBool`, `RECONCILE_PLACEHOLDER_TEXT`, `reconcileToolPairing`, `Redaction`, `REDACTION_POLICY`, `redactValue`, `renderLspGroundingStatus`, `Result`, `RunContext`, `runtimeConfig`, `RuntimeConfig`, `runtimeConfigFromEnv`, `SandboxData`, `sanitizeCaller`, `sanitizeLogText`, `SESSION_FORBIDDEN_KNOBS`, `sessionSafeKnobOverrides`, `setKnobOverride`, `setTerminalIo`, `ShellExecEvent`, `ShellExecObserver`, `sliceTailWholeChars`, `sliceWholeChars`, `stripHtmlComments`, `summarizeGroundingStatuses`, `SWEBENCH_CACHE_LEVELS`, `SwebenchCacheLevel`, `TerminalIo`, `TerminalWriter`, `THIN_CLIENT_DISPATCH_FLAG`, `THIN_CLIENT_ROUTES`, `ThinClientRoute`, `throwIfAborted`, `TimerPort`, `toError`, `ToolCapability`, `ToolExecutionError`, `ToolInputError`, `ToolResultData`, `TRAJECTORY_CONTRACT_VERSION`, `TRAJECTORY_KIND_CONTRACTS`, `TRAJECTORY_KINDS`, `TRAJECTORY_SCHEMA`, `TrajectoryEvent`, `TrajectoryKind`, `TurnPolicySnapshot`, `TurnPolicyToolChoiceKind`, `VerifyData`, `writeStderr`, `writeStdout`
- Hellgate: `tests/unit/shared-solid-consolidation-hellgate.test.ts`

### `@/side-agent`

> `@/side-agent` — N1 background side-agent daemon (RFC `docs/plans/jun-4-background-side-agent.md`). Phase-1 pure leaf: the supervise-loop registry over injected ports. Default-OFF by construction — nothing imports this unless the host op...

- Public surface: `backoffForAttempt`, `ChildProcessHandle`, `createProcessSideAgentDaemonRegistry`, `createSideAgentDaemonRegistry`, `createSupervisedProcessDaemon`, `DelayScheduler`, `ProcessForkPort`, `ProcessForkSpec`, `ProcessSideAgentRegistryOpts`, `SideAgentDaemonOpts`, `SideAgentDaemonRegistry`, `SideAgentError`, `SideAgentErrorCode`, `SideAgentEventSourcePort`, `SideAgentFinding`, `SideAgentIpcMessage`, `SideAgentMailboxPort`, `SideAgentRunnerPort`, `SideAgentSinkPort`, `SideAgentSnapshot`, `SideAgentSpec`, `SideAgentStatus`, `SideAgentTrigger`, `SupervisedDaemonStatus`, `SupervisedProcessDaemon`, `SupervisedProcessDaemonOpts`
- Hellgate: `tests/unit/side-agent-root-recipient-hellgate.test.ts`

### `@/skill`

> Skill slice (T1.C) — faithful-minimal port of Claude Code v2's skill system. Self-contained: this slice MUST NOT import @/agent. Public seams: - {@link Skill} / {@link ParsedFrontmatter} / {@link SkillEffort} (types) - {@link parseFrontm...

- Public surface: `AddTestsTrigger`, `AdminPolicy`, `AdminPolicyReader`, `AdminPolicySchema`, `appendAuditEntry`, `AuditClock`, `AuditEntry`, `AuditEvent`, `auditLogPathFor`, `AuditWriter`, `BabysitTrigger`, `bannedSkillNames`, `BlameSectionTrigger`, `buildAuditEntry`, `buildSkillRegistry`, `createFsAdminPolicyReader`, `createSkillCreatorTool`, `createSkillTool`, `createToolSearchTool`, `DEBUG_ERROR_SKILL_NAME`, `DEBUG_TRACE_SKILL_NAME`, `DebugErrorTrigger`, `DebugTraceTrigger`, `decideInstall`, `defaultAdminPolicyReader`, `defaultSkillSources`, `discoverSkillImplicitPolicy`, `discoverSkillResources`, `discoverSkills`, `discoverSystemSkills`, `EXPLAIN_CODE_SKILL_NAME`, `EXPLAIN_STACK_TRACE_SKILL_NAME`, `ExplainCodeTrigger`, `ExplainStackTraceTrigger`, `EXTRACT_FUNCTION_SKILL_NAME`, `ExtractFunctionTrigger`, `findAddTestsSkill`, `findBabysitSkill`, `findBlameSectionSkill`, `findDebugErrorSkill`, `findDebugTraceSkill`, `findExplainCodeSkill`, `findExplainStackTraceSkill`, `findExtractFunctionSkill`, `findFixMergeConflictsSkill`, `findGetPrCommentsSkill`, `findGitLogSearchSkill`, `findLocalizeFaultSkill`, `findLoopOnCiSkill`, `findMakePrEasyToReviewSkill`, `findNewBranchAndPrSkill`, `findProgressAuditSkill`, `findPrReviewCanvasSkill`, `findReviewAndShipSkill`, `findRewindSkill`, `FIX_MERGE_CONFLICTS_SKILL_NAME`, `FixMergeConflictsTrigger`, `GET_PR_COMMENTS_SKILL_NAME`, `GetPrCommentsTrigger`, `GIT_LOG_SEARCH_SKILL_NAME`, `GitLogSearchTrigger`, `implicitlyInvocableSkills`, `InstallAttempt`, `InstallDecision`, `isSkillInstallState`, `isSkillScope`, `loadAdminPolicy`, `LoadedAdminPolicy`, `LOCALIZE_FAULT_SKILL_NAME`, `LocalizeFaultTrigger`, `LOOP_ON_CI_SKILL_NAME`, `LoopOnCiTrigger`, `MAKE_PR_EASY_TO_REVIEW_SKILL_NAME`, `MakePrEasyToReviewTrigger`, `matchesAnyGlob`, `MAX_GLOB_LEN`, `MAX_PATH_LEN`, `memoryAuditWriter`, `MemoryAuditWriter`, `migrateClaudeSkillsToQuanta`, `MigrationEntry`, `MigrationFs`, `MigrationOptions`, `MigrationReport`, `NEW_BRANCH_AND_PR_SKILL_NAME`, `NewBranchAndPrTrigger`, `nodeAuditWriter`, `nodeMigrationFs`, `parseAdminPolicy`, `ParsedFrontmatter`, `parseFrontmatter`, `parseOpenaiYamlInterface`, `parseOpenaiYamlPolicy`, `PR_REVIEW_CANVAS_SKILL_NAME`, `PROGRESS_AUDIT_SKILL_NAME`, `ProgressAuditTrigger`, `PrReviewCanvasTrigger`, `renderSkillMarkdown`, `requiredAdminSkillNames`, `resetAuditSeqForTesting`, `REVIEW_AND_SHIP_SKILL_NAME`, `ReviewAndShipTrigger`, `REWIND_SKILL_NAME`, `RewindTrigger`, `scopingNote`, `Skill`, `SKILL_INSTALL_STATES`, `SKILL_RESOURCE_DIRS`, `SKILL_SCOPES`, `SKILL_SCOPES_PRECEDENCE_DESC`, `SkillEffort`, `skillEffortOverride`, `SkillInstallState`, `skillModelOverride`, `SkillRegistry`, `SkillRegistryCollision`, `SkillRegistryEntry`, `SkillRegistryOptions`, `SkillResources`, `skillsActivatedFor`, `skillScope`, `SkillScope`, `SkillSource`, `SkillSourceInputs`, `skillToolAllowlist`, `SkillWriteResult`, `SkillWriterPort`, `systemAuditClock`, `systemSkillsDir`, `triggerAddTests`, `triggerBabysit`, `triggerBlameSection`, `triggerDebugError`, `triggerDebugTrace`, `triggerExplainCode`, `triggerExplainStackTrace`, `triggerExtractFunction`, `triggerFixMergeConflicts`, `triggerGetPrComments`, `triggerGitLogSearch`, `triggerLocalizeFault`, `triggerLoopOnCi`, `triggerMakePrEasyToReview`, `triggerNewBranchAndPr`, `triggerProgressAudit`, `triggerPrReviewCanvas`, `triggerReviewAndShip`, `triggerRewind`, `validateAdminPolicy`, `validateScaffold`
- Hellgate: `tests/unit/skill-mcp-e2e-hellgate.test.ts`

### `@/storage` [ADR-0108, ADR-0398]

> ADR-0398 — atomic single-file commit + sha256 hash helper. Re-exported so the tool slice can compute / compare precondition hashes WITHOUT crossing the slice fence into `@/llm`.

- Public surface: `AtomicWriteSync`, `canonicalizePath`, `clearFsJailDecisionSink`, `DEFAULT_SHADOW_ODB_MAX_BYTES`, `defaultAtomicWriteSync`, `defaultFileSystemPort`, `defaultShadowOdb`, `deleteFile`, `enforceJail`, `evictLru`, `fileExists`, `FileInfo`, `FileSystemPort`, `FsJailError`, `JailedPath`, `parentDir`, `readFile`, `readFileBytes`, `renameFile`, `resolveJailed`, `resolvePath`, `RewindOptions`, `RewindToRefOptions`, `setFsJailDecisionSink`, `sha256Hex`, `SHADOW_LAST_REF`, `SHADOW_LAST_VERIFIED_REF`, `SHADOW_PRE_REWIND_REF_PREFIX`, `ShadowInitResult`, `ShadowOdb`, `ShadowOdbConfig`, `ShadowOdbError`, `ShadowOdbErrorCode`, `SnapshotDiff`, `SnapshotMetadata`, `statFile`, `workspaceHash`, `writeFile`, `writeFileAtomic`
- Hellgate: _(none)_

### `@/stream`

> (no description)

- Public surface: `AGENT_EVENT_TYPES`, `AgentEvent`, `AgentEventType`, `ALL_PLAN_DELTA_KIND_MIRROR`, `applyRetention`, `ApplyRetentionOpts`, `ApplyRetentionResult`, `AssistantTextPainter`, `DecisionEmitter`, `decisionEmitterFromStream`, `DecisionEvent`, `DegradedRecord`, `EscalationOption`, `inspectRetentionState`, `isAgentEventType`, `ITEM_LIFECYCLE_FLAG`, `itemLifecycleEnabled`, `ItemLifecycleTracker`, `ItemStreamProjector`, `JsonlRecorder`, `JsonlRecorderOpts`, `JsonlRecorderRetentionBusyError`, `PlanDeltaKindMirror`, `PlanDeltaReadonlyMirror`, `PlanReadonlyMirror`, `RetentionPolicy`, `safeEmitDecision`, `SseStream`, `StdoutStream`, `StdoutStreamOptions`, `StreamPort`, `TeeStream`, `TeeStreamOpts`, `TodoReadonlyMirror`, `TodoStatusMirror`, `ToolRiskMirror`
- Hellgate: `tests/unit/stream-timeout-hellgate.test.ts`

### `@/subagent`

> Subagent slice — public API. Wire-up the main thread (the only allowed cross-importer, via @/agent) does: const agentTool = createAgentTool({ runner, maxDepth: 3 }) const taskRegistry = agentTool.registry // merge into a fresh ToolRegist...

- Public surface: `AgentMeta`, `AgentMetaRegistry`, `AgentToolOptions`, `AgentTypeClass`, `AgentTypeValidation`, `assignNickname`, `classifyAgentType`, `ControlEndpoint`, `createAgentTool`, `createIntrospectTools`, `createSubagent6Tools`, `createTaskOutputTool`, `createTaskStopTool`, `createTeamRegistry`, `DEFAULT_WAIT_TIMEOUT_POLICY`, `DeliveryOutcomeMirror`, `DeliveryPort`, `DeliveryRequestMirror`, `dispatchSubagent6`, `FollowupTaskInput`, `FollowupTaskInputSchema`, `FollowupTaskOutput`, `GateWaitResult`, `GateWakeResult`, `handleCloseAgent`, `handleExecCommand`, `handleFollowupTask`, `handleListAgents`, `handleSendInput`, `handleSpawnAgent`, `handleWaitAgent`, `handleWriteStdin`, `InputChannelRegistry`, `IntrospectError`, `IntrospectToolsDeps`, `isSubagent6Tool`, `isSubagentType`, `ListAgentsInput`, `ListAgentsInputSchema`, `ListAgentsOutput`, `ListedAgent`, `MAESTRO_NICKNAMES`, `MailboxSendPort`, `MAX_PTY`, `nextSequentialNickname`, `ownersForRegistry`, `PtyTable`, `ROOT_LINEAGE`, `SpawnAgentInput`, `SpawnAgentInputSchema`, `SUBAGENT_6_TOOL_CONTRACTS`, `SUBAGENT_6_TOOL_NAMES`, `SUBAGENT_KINDS`, `Subagent6Deps`, `Subagent6ToolName`, `Subagent6ToolSet`, `SubagentAgentType`, `SubagentEventEmitter`, `SubagentLifecycleEvent`, `SubagentRequest`, `SubagentResult`, `SubagentRunner`, `SubagentTurnGate`, `SubagentType`, `TaskBudget`, `TaskKind`, `TaskOutputTimeoutPolicy`, `TaskRecord`, `TaskRegistry`, `TaskRegistryOptions`, `TaskStatus`, `TeamRegistryPort`, `TurnWakeRegistry`, `validateAgentType`, `ValidateAgentTypeOpts`, `WaitTimeoutPolicy`, `WakeOutcome`, `Waker`
- Hellgate: `tests/unit/subagent-6-tools-hellgate.test.ts`

### `@/tool` [ADR-0142]

> (no description)

- Public surface: `aggregateFileTree`, `ALL_MANIFEST_TOOL_NAMES`, `applyPatchTool`, `APPSHOT_MAX_ITER`, `APPSHOT_MAX_SCREENSHOT_BYTES`, `APPSHOT_MIN_ITER`, `AppshotArtifactSink`, `AppshotAvailability`, `appshotClampIter`, `AppshotPort`, `AppshotRequest`, `AppshotResult`, `AppshotSlot`, `AppshotToolOptions`, `AppshotVerifyInput`, `appshotVerifyInputSchema`, `appshotVerifyTool`, `AppSpec`, `ArtifactDestroyInput`, `artifactDestroyInputSchema`, `ArtifactGetInput`, `artifactGetInputSchema`, `ArtifactListInput`, `artifactListInputSchema`, `ArtifactRegisterInput`, `artifactRegisterInputSchema`, `ArtifactRegistryPort`, `ArtifactSpecInput`, `artifactTools`, `ArtifactView`, `astGrepTool`, `automationUpdateTool`, `BASE_TOOL_NAMES`, `BashAwaitInput`, `bashAwaitInputSchema`, `bashAwaitTool`, `BashKillInput`, `bashKillInputSchema`, `bashKillTool`, `buildDefaultTools`, `buildDocx`, `buildEvidence`, `buildPptx`, `buildStoredZip`, `buildTerminalTools`, `buildXlsx`, `CodeActionPort`, `CodeActionPortAction`, `CodeActionPortDocumentEdit`, `CodeActionPortKind`, `CodeActionPortPos`, `CodeActionPortRange`, `CodeActionPortTextEdit`, `CodeActionPortWorkspaceEdit`, `CodeCellInput`, `codeCellInputSchema`, `codeCellTool`, `CommunicateUpdateInput`, `communicateUpdateInputSchema`, `composeToolResultContent`, `CoverageCheckInput`, `coverageCheckInputSchema`, `coverageCheckTool`, `crc32`, `createCommunicateUpdateTool`, `createFileHistorySink`, `createFileHistoryStore`, `CriticalSectionScheduler`, `defaultGhRunner`, `defaultGitRunner`, `defaultImageWritePort`, `DefaultToolPorts`, `defaultTools`, `DeferredResultRegistry`, `defineTool`, `DefineToolSpec`, `DiagnosticItem`, `DiagnosticsProvider`, `DiagnosticsSession`, `diagnosticsTool`, `DocxSpec`, `DocxWriteInput`, `docxWriteInputSchema`, `docxWriteTool`, `DocxWriteToolOptions`, `driveStreamingInput`, `enforceOutputSchema`, `enterPlanModeTool`, `entryToolNames`, `EvidencePacket`, `EvidenceSources`, `FailureEvidence`, `FileHistoryStore`, `fileTreeSummaryTool`, `findReferencesTool`, `formatDiagnostics`, `FormatPort`, `FormatPortPos`, `FormatPortRange`, `FormatPortTextEdit`, `FsJailViolationError`, `GATED_TOOLS`, `GeneratedImage`, `GhRunner`, `ghTools`, `gitBlameHeatmapTool`, `GitBlameInput`, `gitBlameTool`, `GitBranchSwitchInput`, `gitBranchSwitchTool`, `gitChurnTool`, `gitCoChangeTool`, `GitCommitInput`, `gitCommitTool`, `gitConflictInspectTool`, `GitDiffInput`, `gitDiffTool`, `GitLogInput`, `gitLogTool`, `gitMovedCodeTool`, `GitRunner`, `GitRunResult`, `GitStatusInput`, `gitStatusTool`, `gitTools`, `GitUpstreamCheckInput`, `gitUpstreamCheckTool`, `IMAGE_GEN_MAX_BYTES`, `IMAGE_GEN_MAX_N`, `ImageGenFormat`, `ImageGenInput`, `imageGenInputSchema`, `ImageGenOutcome`, `ImageGenPort`, `ImageGenRequest`, `imageGenTool`, `ImageGenToolOptions`, `ImageWritePort`, `inferNextAction`, `InterruptRouter`, `InterruptRouterObserver`, `isCheapLspNavTool`, `isRealJudgePass`, `judgeVerdict`, `LSP_NAV_EXPENSIVE_TOOL_NAMES`, `lspCodeActionTool`, `lspFormatTool`, `LspNavProvider`, `LspNavSession`, `lspNavTools`, `lspRenameApplyTool`, `lspSignatureHelpTool`, `makeApplyPatchStructuredTool`, `makeBashAwaitTool`, `makeBashKillTool`, `makeDocxWriteTool`, `makeInterruptRouter`, `MakeInterruptRouterArgs`, `makeJailedScaffold`, `makePptxWriteTool`, `makeXlsxWriteTool`, `NavHover`, `NavLocation`, `NavPos`, `NavRange`, `NavRenamePreview`, `NavSymbolInfo`, `NavSymbolKind`, `nullDiagnosticsProvider`, `nullLspNavProvider`, `OOXML_MEDIA_TYPES`, `openAiImagePort`, `parseCommitGroups`, `parseStoredZip`, `PptxSpec`, `PptxWriteInput`, `pptxWriteInputSchema`, `pptxWriteTool`, `PptxWriteToolOptions`, `rankBlame`, `rankChurn`, `rankCoChange`, `rankCoChangePairs`, `READ_IMAGE_MAX_BYTES`, `READ_IMAGE_SUPPORTED_MEDIA_TYPES`, `ReadImageInput`, `readImageInputSchema`, `ReadImageSupportedMediaType`, `readImageTool`, `ReadImageUrlInput`, `readImageUrlInputSchema`, `readImageUrlTool`, `RenameApplyPort`, `RenameApplyPortDocumentEdit`, `RenameApplyPortPos`, `RenameApplyPortRange`, `RenameApplyPortTextEdit`, `RenameApplyPortWorkspaceEdit`, `renderFileTree`, `renderModelOutput`, `renderScaffoldHtml`, `runAppshotLoop`, `RuntimeEvidence`, `RuntimeFrame`, `RuntimeVar`, `ScaffoldResult`, `ScaffoldWritePort`, `seedEnvVarsForSurface`, `SELF_TEST_DISCIPLINE`, `shouldSeedOn`, `SignatureHelpPort`, `SignatureHelpPortInfo`, `SignatureHelpPortParameter`, `sniffMediaType`, `StaticEvidence`, `StreamingInputStep`, `surfaceDefaultFor`, `TERMINAL_OPERATOR_GUIDE`, `terminalOperatorGuide`, `TOOL_SURFACES`, `ToolDefault`, `ToolGate`, `ToolResultContent`, `ToolRisk`, `ToolSurface`, `ToolSurfaceEntry`, `TreeAgg`, `UnknownDeferredHandleError`, `validateToolOutput`, `VerifyVerdict`, `XlsxSpec`, `XlsxWriteInput`, `xlsxWriteInputSchema`, `xlsxWriteTool`, `XlsxWriteToolOptions`
- Hellgate: `tests/unit/tool-interrupt-behavior-tools-hellgate.test.ts`

### `@/ui`

> `src/ui` slice — surface-agnostic UI helpers. Pure string / ANSI / box-drawing utilities that any surface (CLI, REPL, embedded browser, Tauri renderer) can compose. No I/O is performed by this slice; callers own writing the rendered stri...

- Public surface: _(none parsed)_
- Hellgate: _(none)_

### `@/voice` [ADR-0202, ADR-0208]

> Voice slice barrel (ADR-0208). Sibling to `@/media/voice` (ADR-0202). That slice ships the leaf one-shot `captureOnce()` port; this slice ships the handle-based `start()/stop()` port + transcriber port + CLI `/voice` slash. Both coexist;...

- Public surface: `ARECORD_BACKEND`, `AudioBytes`, `AudioRecorderPort`, `createDefaultRecorder`, `createMacMicRecorder`, `createPlatformRecorder`, `DEFAULT_BACKENDS`, `defaultRecorderSpawner`, `MAC_BACKENDS`, `PAREC_BACKEND`, `RecorderBackend`, `RecorderError`, `RecorderFormat`, `RecorderHandle`, `RecorderInternalResult`, `RecorderSpawnedChild`, `RecorderSpawner`, `RecorderStartOpts`, `SOX_BACKEND`
- Hellgate: `tests/unit/voice-transcriber-hellgate.test.ts`

### `@/workflow`

> §25.1 — Declarative workflow orchestration engine. Barrel. SLICE `@/workflow`: a pure library that walks a declarative node tree, spawning subagents through the injected {@link AgentRunPort}. Default-OFF (acts only when `runWorkflow` is ...

- Public surface: `agent`, `AgentNode`, `AgentRunPort`, `AgentRunRequest`, `AgentRunResult`, `BudgetPort`, `compileWorkflowSpec`, `fanout`, `FanoutNode`, `fieldSchemaToZod`, `FieldType`, `loop`, `LoopNode`, `OutputSchemaSpec`, `parallel`, `ParallelNode`, `phase`, `PhaseNode`, `PhaseSpec`, `PhaseSpecSchema`, `pipeline`, `PipelineNode`, `runWorkflow`, `RunWorkflowOptions`, `sequence`, `SequenceNode`, `SkipReason`, `StepFailureReason`, `StepOutcome`, `StepSpec`, `StepSpecSchema`, `WorkflowContext`, `WorkflowEvent`, `WorkflowNode`, `WorkflowResult`, `WorkflowSink`, `WorkflowSpec`, `WorkflowSpecSchema`
- Hellgate: _(none)_

## ADR catalogue by plane (555 entries, 524 distinct numbers)

### Domain / Ports (35)

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
- [ADR-0196](./decisions/0196-mcp-tasks-capability.md) **MCP Tasks Capability — typed long-running-task port + 3 model tools** — Unknown
- [ADR-0197](./decisions/0197-mcp-elicitation-schemas.md) **MCP Elicitation — 7 typed prompt schemas + closed prompter port** — Unknown
- [ADR-0208](./decisions/0208-voice-input-stt-slice.md) **Voice `/voice` slice — handle-based recorder + transcriber ports + CLI** — Accepted _(2026-05-25)_
- [ADR-0214](./decisions/0214-typed-error-enum-16-codex-spec.md) **Flat LLMErrorKind 11→16 + RecoveryRouter port (Codex-spec verbatim)** — Accepted _(2026-05-25)_
- [ADR-0215](./decisions/0215-rrule-automation-engine-wire.md) **RRULE automation engine wire (Codex 3-table schema)** — Unknown
- [ADR-0217](./decisions/0217-typed-error-enum-16-routing.md) **Typed error enum (16-variant) + retry routing port — Codex absorption extending ADR-0069** — Accepted _(2026-05-25)_
- [ADR-0230](./decisions/0230-realtime-websocket-codex.md) **Realtime WebSocket slice — 8 method surface (Codex absorption)** — Accepted _(2026-05-25)_
- [ADR-0244](./decisions/0244-side-chat-session-isolation.md) **Side-chat session isolation (auxiliary conversation seam)** — Unknown
- [ADR-0254](./decisions/0254-semantic-search-port.md) **Semantic-search port — embedding-based retrieval seam (Cline-style)** — Accepted _(2026-05-25)_ — related: ADR-0093
- [ADR-0262](./decisions/0262-reranker-port.md) **Reranker port — closed seam + Cohere/Voyage REST adapters + identity default** — Accepted _(2026-05-25)_ — related: ADR-0159, ADR-0254
- [ADR-0276](./decisions/0276-multimodal-embedding-mvp.md) **Multi-modal embedding MVP — image + audio embedding port** — Accepted _(2026-05-25)_ — related: ADR-0261
- [ADR-0277](./decisions/0277-codebase-indexer.md) **Codebase indexer slice** — Accepted _(2026-05-25)_ — related: ADR-0159, ADR-0260
- [ADR-0320](./decisions/0320-typed-history-event-store.md) **Typed history event store (foundation slice)** — Unknown
- [ADR-0366](./decisions/0366-codex-r2-metrics-relocation-and-histogram-retry.md) **codex-r2-metrics slice relocation + histogram method (R11 W-B retry)** — Unknown
- [ADR-0386](./decisions/0386-bulk-evict-pattern-and-listSessionIds.md) **Bulk evict pattern + closed-port `listSessionIds` extension** — Unknown
- [ADR-0403](./decisions/0403-approval-state-machine.md) **Approval state machine (port + store)** — Unknown
- [ADR-0415](./decisions/0415-observability-live-wire.md) **Observability live-wire (HookBus auto-subscribe + RuntimeFacade port exposure)** — Unknown
- [ADR-0420](./decisions/0420-observability-ws-sink.md) **Observability served-WebSocket sink (closes ADR-0415 emitter-port-only deferral)** — Unknown
- [ADR-0485](./decisions/0485-mcp-resource-tools.md) **MCP resource/prompt tools (N3) — model-callable `resources/*` + `prompts/*` over a duck-typed port** — Accepted _(2026-06-06)_
- [ADR-0486](./decisions/0486-pty-attach.md) **PTY / tmux session attach — a gated, port-inverted attach-to-existing-terminal slice (N6)** — Accepted _(2026-06-06)_ — related: ADR-0471
- [ADR-0507](./decisions/0507-image-downsample.md) **`read_image` downsample codec port** — Accepted _(2026-06-07)_
- [ADR-0526](./decisions/0526-scriptable-statusline-runner.md) **Scriptable statusLine runner (Claude Code stdin contract, args-based spawn, ANSI-aware truncated first line)** — Proposed _(2026-06-09)_
- [ADR-0527](./decisions/0527-cli-knob-readsite-domain-invariant.md) **CLI-knob read-site-domain invariant (a wrong-homed knob is invisible on the web/daemon /knobs surface)** — Proposed _(2026-06-09)_ — related: ADR-0503

### Application / Orchestration (108)

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
- [ADR-0207](./decisions/0207-stage1-outputs-persist.md) **Stage1 outputs 2-Phase memory persistence** — Unknown
- [ADR-0213](./decisions/0213-tool-profile-preset.md) **Tool profile preset — 4 named bundles + UP-nudge composition** — Unknown
- [ADR-0216](./decisions/0216-stage1-store-port-agent-side.md) **Stage1Store port (agent-side, no-throw, 4-verb surface)** — Unknown
- [ADR-0225](./decisions/0225-cli-slash-mid-edit.md) **CLI `/edit-plan` + `/edit-message` (mid-execution external editor)** — Accepted _(2026-05-25)_
- [ADR-0229](./decisions/0229-dispatch-guard-wiring.md) **Dispatch Guard wiring — single port over 3 already-shipped detectors** — Accepted _(2026-05-25)_
- [ADR-0235](./decisions/0235-shell-snapshot-runshell-wire.md) **Per-turn shell-snapshot — runShell prefix wire (composition root)** — Accepted _(2026-05-25)_ — related: ADR-0204
- [ADR-0236](./decisions/0236-composition-root-mega-wire.md) **Composition-root mega-wire (11 subsystems, default-OFF)** — Unknown
- [ADR-0240](./decisions/0240-loop-trio-integration-auto-bg-automation-identity.md) **Loop trio integration — auto-background accept + automation engine tick + identity per-turn reminder** — Accepted _(2026-05-25)_
- [ADR-0241](./decisions/0241-playbook-auto-dispatch-and-git-directive-completion.md) **Playbook auto-dispatch + Git directive completion (5 directive kinds wired)** — Accepted _(2026-05-25)_
- [ADR-0243](./decisions/0243-n-phase-hitl.md) **N-phase HITL (plan-exit-flow 일반화, Cursor 흡수)** — Accepted _(2026-05-25)_ — related: ADR-0063
- [ADR-0247](./decisions/0247-agent-nickname-pool-role-enum.md) **Codex agent nickname pool (39) + agent_role enum** — Accepted _(2026-05-25)_ — related: ADR-0030
- [ADR-0248](./decisions/0248-jwks-agent-identity.md) **JWKS agent identity — remote JWK fetch + cache + verify** — Unknown
- [ADR-0250](./decisions/0250-inline-trigger-wiring.md) **Inline-trigger wiring — Aider-style source-comment dispatch primitive** — Accepted _(2026-05-25)_ — related: ADR-0203
- [ADR-0255](./decisions/0255-cross-subagent-todo-readback.md) **Cross-subagent todo readback (Roo bidirectional extension)** — Accepted _(2026-05-25)_
- [ADR-0259](./decisions/0259-plan-writeback-bidirectional.md) **Plan-writeback — bidirectional skill ↔ plan sync** — Accepted _(2026-05-25)_
- [ADR-0272](./decisions/0272-pipeline-composition-root-wire.md) **Pipeline composition-root wire — `assemblePipeline(env)` + `search_codebase` tool** — Accepted _(2026-05-25)_ — related: ADR-0265
- [ADR-0273](./decisions/0273-model-tag-auto-hook.md) **ModelTag invalidator auto-hook — EmbedCache + VectorStore registrar seam** — Accepted _(2026-05-25)_ — related: ADR-0266
- [ADR-0279](./decisions/0279-automation-engine-wire.md) **Automation engine composition-root wire (E2 productization)** — Unknown
- [ADR-0281](./decisions/0281-memory-auto-trigger.md) **Memory auto-trigger (session-end → phase1 → phase2 promote)** — Unknown
- [ADR-0282](./decisions/0282-cross-session-memory-inject.md) **Cross-session memory inject (selectForInject → prompt section)** — Unknown
- [ADR-0284](./decisions/0284-fork-session-wire.md) **fork-session-wire composition root** — Unknown
- [ADR-0298](./decisions/0298-subagent-fanout-parallel.md) **Subagent Fanout Parallelization (Cursor `is_parallel_worker`)** — Accepted (always-ON — the safety argument is structural, not a feature toggle).
- [ADR-0300](./decisions/0300-per-tool-granular-registry.md) **Per-tool granular checkpoint registry (in-memory snapshot store)** — Unknown
- [ADR-0310](./decisions/0310-surface-composition-wire-r1.md) **REPL surface composition wire (R1 — ADR-0291/0292/0293/0294)** — Accepted — landed `src/apps/cli/repl/surface-compose.ts` (extended) +
- [ADR-0332](./decisions/0332-composition-wire-install-helper.md) **`installCodexR2Wires` composition helper (ADR-0327 family wire-up)** — Accepted. Slice landed. Composition root call sites (`apps/cli/repl/session-setup.ts`, `apps/web-daemon/runtime-factory.ts`, `apps/bench/eval/driver.ts`, `apps/agent/assemble.ts`) intentionally left for a separate follow-up so the user's in-flight surface work is not invaded.
- [ADR-0334](./decisions/0334-composition-root-codex-r2-wires.md) **Composition-root call sites for `installCodexR2Wires`** — Accepted. ADR-0332 install helper shipped without callers; ADR-0334 closes the gap by adding one-line install calls in the four composition roots flagged in ADR-0332 §Wiring. Default-OFF semantics are preserved at every site: an absent dep yields a byte-identical pre-install cfg.
- [ADR-0339](./decisions/0339-plugin-declared-skill-set-extension.md) **Plugin-declared skill set extension** — Unknown
- [ADR-0345](./decisions/0345-session-keyed-resource-registry.md) **Session-keyed resource registry (in-memory store/cache reuse)** — Accepted. Registry slice + tests landed. Composition-root adoption (a 1-line swap at `apps/agent/assemble.ts:167` and sibling assembly points) intentionally deferred to a follow-up so the user's in-flight surface work is not invaded.
- [ADR-0346](./decisions/0346-loop-activation-hook.md) **Loop hook for plugin activation trigger** — Accepted. Slice landed (`src/agent/loop-activation-hook.ts` +
- [ADR-0347](./decisions/0347-composition-registry-wire.md) **Composition-root session-keyed registry wire** — Accepted. Slice landed: process-level singleton + `assemble.ts` 1-line swap + hellgate.
- [ADR-0350](./decisions/0350-composition-activation-auto-wire.md) **Composition-root `cfg.activatePlugins` auto-wire** — Accepted. Slice landed: `autoWirePluginActivation` helper +
- [ADR-0358](./decisions/0358-codex-r2-metrics-composition-wire.md) **Codex-r2 metrics composition wire (cache decorator + emitter side-channel)** — Accepted — 2026-05-27.
- [ADR-0371](./decisions/0371-agent-dispatch-staleness-pattern.md) **Agent dispatch staleness pattern hardening** — Unknown
- [ADR-0389](./decisions/0389-worktree-agent-api-instability-retry.md) **Worktree-agent API-instability retry harness (process)** — Unknown
- [ADR-0401](./decisions/0401-run-ledger-attribution.md) **Run Ledger attribution via hook bus** — Unknown
- [ADR-0405](./decisions/0405-edit-after-diagnostics-hook.md) **edit-after-diagnostics auto-injection hook** — Unknown
- [ADR-0406](./decisions/0406-composition-root-observability-wire.md) **Composition-root observability wire** — Unknown
- [ADR-0407](./decisions/0407-approval-gate-wire.md) **Approval-gate wire (attribute HITL to Objective + RunLedger)** — Unknown
- [ADR-0413](./decisions/0413-memory-learning-default-on-via-session-factory.md) **Memory learning DEFAULT-ON via session factory** — Unknown
- [ADR-0416](./decisions/0416-subagent-mailbox.md) **Managed-subagent mailbox (`subagent_send_message` between agents)** — Unknown
- [ADR-0419](./decisions/0419-subagent-read-inbox-tool.md) **Subagent read-inbox tool (`subagent_read_messages`)** — Unknown
- [ADR-0429](./decisions/0429-advisor-consult-tool.md) **Advisor consult tool (agent-callable second opinion)** — Unknown
- [ADR-0431](./decisions/0431-mcp-tasks-live-binding.md) **MCP tasks live binding (outbound `tasks/*` dispatch + composition-root wiring)** — Unknown
- [ADR-0432](./decisions/0432-memory-line-citation-mode-guard.md) **Memory line-level citations + per-thread mode + write-guard** — Unknown
- [ADR-0436](./decisions/0436-batch-spawn.md) **`spawn_batch` structured subagent fan-out** — Unknown
- [ADR-0437](./decisions/0437-subagent-introspect.md) **Subagent introspection: `list_agents` + `followup_task`** — Unknown
- [ADR-0446](./decisions/0446-external-editor-keybind.md) **external `$EDITOR` composition via ctrl-x ctrl-e** — Unknown
- [ADR-0451](./decisions/0451-subagent-model-override.md) **per-subagent model / role / effort override** — Unknown
- [ADR-0453](./decisions/0453-heartbeat-eligibility.md) **Heartbeat autorun eligibility — per-thread approval gate for scheduler + reactor** — Accepted _(2026-06-02)_ — related: ADR-0046
- [ADR-0455](./decisions/0455-local-environments.md) **agent-driven DECLARED local-environment selection** — Unknown
- [ADR-0457](./decisions/0457-codex-skill-ecosystem-frontmatter-and-bundled-resources.md) **codex skill ECOSYSTEM frontmatter (argument-hint / metadata) + bundled resources** — Unknown
- [ADR-0459](./decisions/0459-command-hooks-composition-root-wire.md) **Command-hooks composition-root wire (security-reviewed activation of ADR-0454)** — Unknown
- [ADR-0461](./decisions/0461-proactive-token-refresh-scheduler.md) **Proactive token-refresh scheduler for connectors** — Unknown
- [ADR-0462](./decisions/0462-sticky-model-per-mode-loop-consume.md) **sticky-model-per-mode: loop consume site (dead-seam → live)** — Unknown
- [ADR-0472](./decisions/0472-edit-repair-loop.md) **Edit-repair-loop: lint-delta + bounded fast-model repair to green** — Unknown
- [ADR-0476](./decisions/0476-skill-mcp-deps.md) **skill-mcp-deps: skill-declared MCP dependencies, auto-attached on activation** — Unknown
- [ADR-0478](./decisions/0478-communicate-update.md) **`communicate_update` — structured mid-turn progress channel (Cursor `agent.v1.CommunicateUpdateArgs` absorption)** — Accepted _(2026-06-06)_ — related: ADR-0010
- [ADR-0479](./decisions/0479-team-dag-coordination.md) **Team DAG coordination — task dependency DAG over the subagent batch fan-out** — Accepted _(2026-06-06)_ — related: ADR-0436
- [ADR-0481](./decisions/0481-heartbeat-automation.md) **Heartbeat automation — thread-attached repeating agent (kind cron|heartbeat)** — Accepted _(2026-06-06)_ — related: ADR-0453
- [ADR-0482](./decisions/0482-team-idle-barrier-coordination.md) **Team-idle barrier coordination — idle-beacon fan-in over the side-agent daemon team (Capability C)** — Accepted _(2026-06-06)_ — related: ADR-0479
- [ADR-0488](./decisions/0488-code-mode-js-runtime.md) **code_mode — JS-runtime tool-calling (QuickJS-WASM cell as a dispatch model)** — Accepted _(2026-06-07)_
- [ADR-0493](./decisions/0493-thin-client-dispatch.md) **thin-client dispatch routing** — Accepted _(2026-06-07)_
- [ADR-0499](./decisions/0499-manifest-codex-compat-ingest.md) **plugin/skill manifest codex-compat INGEST (strict schemas reject real codex artifacts)** — Accepted _(2026-06-07)_
- [ADR-0509](./decisions/0509-agent-requested-rules.md) **agent-requested rules (description-only, fetch-on-demand)** — Accepted _(2026-06-07)_
- [ADR-0510](./decisions/0510-batch-jobs-agent-toolification.md) **batch-jobs agent tool-ification (GAP7)** — Accepted _(2026-06-08)_
- [ADR-0522](./decisions/0522-side-agent-os-process-daemon.md) **Side-agent OS-PROCESS daemon V1 — a forked, supervised child with exponential-backoff respawn** — Proposed _(2026-06-09)_ — related: ADR-0483
- [ADR-0524](./decisions/0524-subagent-typed-agent-kind.md) **Typed subagent `agentType` — closed-set SSOT + boundary classifier (§4.4)** — Proposed _(2026-06-09)_
- [ADR-0534](./decisions/0534-session-config-tool.md) **session_config — agent self-visibility tool (effort tier / identity mode / tool profile / model)** — Accepted (fully wired; CLI composition root, dispatch seam, BASE_TOOL_NAMES) _(2026-06-15)_

### Infrastructure / Adapters (40)

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
- [ADR-0192](./decisions/0192-shell-execa-swap.md) **Shell — swap self-rolled `Bun.spawn` runner for `execa`** — Unknown
- [ADR-0194](./decisions/0194-darwin-vz-native-scaffold.md) **Darwin VZ native scaffold (Skybridge Phase 3.3 — napi-rs binding to Virtualization.framework)** — Accepted (Phase 3.3 scaffold — typed surface + 20-case fake-binding hellgate + workspace member; Phase 3.4 = real `VZVirtualMachine` bring-up + DMG image management + vsock IPC + AVF entitlements) _(2026-05-25)_ — related: ADR-0136, ADR-0155, ADR-0160, ADR-0175, ADR-0193
- [ADR-0195](./decisions/0195-dead-sibling-cleanup.md) **Dead-sibling cleanup — delete 5 lib-swap adapters that shipped 0 callers** — Unknown
- [ADR-0234](./decisions/0234-llm-providers-onchunk-and-16-kind-wire.md) **LLM provider adapter onChunk wire + fromSdkError 16-kind extension** — Unknown
- [ADR-0261](./decisions/0261-pluggable-embedder-store-registry.md) **Pluggable Embedder + VectorStore provider registry** — Accepted _(2026-05-25)_ — related: ADR-0254
- [ADR-0264](./decisions/0264-embed-batcher.md) **EmbedBatcher — 50ms window + single-flight dedupe + provider batch_size honoured** — Accepted _(2026-05-25)_ — related: ADR-0159
- [ADR-0268](./decisions/0268-otlp-http-exporter.md) **OTLP/HTTP exporter — `QUANTA_OTEL_ENDPOINT` realtime ship** — Unknown
- [ADR-0307](./decisions/0307-repl-host-slim-down.md) **CLI-06 — REPL host slim-down (lift 10 surface-adapter factories)** — Unknown
- [ADR-0311](./decisions/0311-github-actions-trigger-adapter.md) **GitHub Actions trigger adapter (Tier 0 PR webhook bot)** — accepted (2026-05-26)
- [ADR-0318](./decisions/0318-screen-ocr-native-sidecar.md) **Screen OCR native sidecar (Swift + ScreenCaptureKit + Vision)** — accepted (2026-05-26) — related: ADR-0309
- [ADR-0330](./decisions/0330-mention-runner-skill-resolver.md) **Mention runner: skill resolver impl + injector composition** — Unknown
- [ADR-0343](./decisions/0343-per-turn-image-retry-rebuild.md) **Per-turn rebuild of `withImageSanitizationRetry` wrap** — Unknown
- [ADR-0344](./decisions/0344-provider-wm-live-reads.md) **Provider adapter `wm-live` reads beyond the image-retry decorator (negative decision)** — **Negative / Deferred.** No code mutation. This ADR documents the deliberate decision **not** to broaden any provider adapter's read of `input.messages` to a `wm-live` reference (whether by signature extension or by a generic decorator) at this time. The single live use case (image sanitize-and-retry) was already closed by ADR-0328 / ADR-0333 with documented, bounded semantics; widening that pattern would be a hypothetical-future cost without a hypothetical-future benefit visible in the current codebase.
- [ADR-0348](./decisions/0348-disk-persistent-session-registry.md) **Disk-persistent session-resource registry (jsonl adapter)** — Accepted. New sibling adapter inside the ADR-0345 slice + tests landed. Composition-root adoption deferred (explicit opt-in by default; in-memory adapter remains the production path).
- [ADR-0351](./decisions/0351-session-registry-disk-env-swap.md) **Session-registry disk-adapter env-var swap** — Unknown
- [ADR-0361](./decisions/0361-sqlite-session-registry-backend.md) **SQLite backend for `SessionResourceRegistry` (Codex `logs_2.sqlite` parity)** — Unknown
- [ADR-0367](./decisions/0367-sqlite-session-registry-env-var-swap.md) **SQLite session-registry env-var swap** — Unknown
- [ADR-0385](./decisions/0385-sqlite-wal-truncate-checkpoint-mode.md) **SQLite WAL TRUNCATE checkpoint mode option** — Unknown
- [ADR-0391](./decisions/0391-mcp-transport-port-and-http-sse.md) **MCP client transport port + stdio extraction + Streamable-HTTP/SSE carrier** — Unknown
- [ADR-0392](./decisions/0392-semantic-index-real-embedder-and-sqlite-persist.md) **Semantic index real embedder wiring + sqlite delta persist** — Unknown
- [ADR-0537](./decisions/0537-bench-checkpoint-resume.md) **Bench turn-boundary checkpoints + resume (sender-deterministic, not provider-deterministic)** — Unknown
- [ADR-0540](./decisions/0540-inline-resumable-approval-resolver.md) **인라인 resumable 승인 resolver — turn-loop이 승인을 in-line await하고, 재설계로 "SDK가 다 처리"를 진짜로** — Proposed _(2026-07-16)_ — related: ADR-0303, ADR-0512, ADR-0528

### Observability / Telemetry (35)

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
- [ADR-0222](./decisions/0222-otel-emit-new-slices.md) **OTel emit unified across 5 new slices (fence-aware narrow ports)** — Accepted _(2026-05-25)_
- [ADR-0270](./decisions/0270-decision-counter-sink.md) **Decision → MetricsRegistry Counter Sink** — Unknown
- [ADR-0360](./decisions/0360-activation-hook-telemetry.md) **Per-turn plugin activation telemetry** — Accepted — 2026-05-27.
- [ADR-0364](./decisions/0364-flock-operations-telemetry.md) **Flock operations telemetry** — Unknown
- [ADR-0368](./decisions/0368-flock-telemetry-composition-wire-deferred.md) **Flock telemetry composition wire (deferred)** — Unknown
- [ADR-0372](./decisions/0372-caller-owned-registry-flock-telemetry-wire.md) **Caller-owned registry path for flock telemetry production wire** — Unknown
- [ADR-0373](./decisions/0373-auto-sweep-telemetry.md) **Auto-sweep telemetry (codex-r2 metric emit for disk + sqlite retention)** — Unknown
- [ADR-0378](./decisions/0378-sqlite-wal-size-telemetry.md) **SQLite WAL size telemetry** — Unknown
- [ADR-0452](./decisions/0452-session-prewarm.md) **session-startup LLM prewarm + Time-To-First-Message metric** — Unknown
- [ADR-0483](./decisions/0483-background-side-agent.md) **Background side-agent daemon — a resident, self-waking monitor that pushes findings without blocking the main loop** — Accepted _(2026-06-06)_ — related: ADR-0130
- [ADR-0525](./decisions/0525-session-crash-resume-and-store-health.md) **Session resilience — persisted crash-resume marker (§13.2) + aggregate store-health diagnostic (§13.1)** — Proposed _(2026-06-09)_

### Security / Sandboxing (47)

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
- [ADR-0193](./decisions/0193-linux-sandbox-native-impl.md) **Linux sandbox native impl (Phase 3.1 — Rust bodies + cargo build verify)** — Accepted (Phase 3.1 — Rust impl wired + workspace + cargo build success on darwin; Phase 3.2 = strict seccomp + GitHub Actions matrix + npm publish 별도 라운드) _(2026-05-25)_ — related: ADR-0136, ADR-0159, ADR-0175
- [ADR-0199](./decisions/0199-macos-seatbelt-verbatim.md) **macOS Seatbelt verbatim profile + strict knobs** — Accepted (Phase 1 — verbatim parity fixtures + 4 strict knobs default-OFF + injection-defended workspace escape; Phase 2 = sandbox-exec live integration battery extension) _(2026-05-25)_ — related: ADR-0136
- [ADR-0242](./decisions/0242-refusal-stop-reason-branching.md) **Stop-reason 8-arm typed branching policy (Cursor 3.2.16)** — Accepted _(2026-05-25)_
- [ADR-0246](./decisions/0246-bridge-attestation.md) **Bridge Attestation — remote permission preflight + STS token** — Accepted _(2026-05-25)_
- [ADR-0269](./decisions/0269-decision-emit-phase-3-wire.md) **Decision emit Phase 3: cap / jail / budget gates** — Accepted (default-OFF) _(2026-05-25)_
- [ADR-0295](./decisions/0295-bash-mode-per-call-sandbox.md) **bash `mode` parameter + per-call OS sandbox wrap** — Unknown
- [ADR-0297](./decisions/0297-sandbox-driven-hitl.md) **Sandbox-driven HITL — remove always-confirm command pattern matching** — Accepted — 2026-05-25
- [ADR-0314](./decisions/0314-mention-filter-trust-scope.md) **Mention filter & trust-scope gating** — accepted (2026-05-26)
- [ADR-0399](./decisions/0399-pii-redaction-dispatch-wire.md) **PII-redaction wire in dispatch.applyRedaction** — Unknown
- [ADR-0412](./decisions/0412-check-secrets-llm-tool.md) **`check_secrets` LLM-facing tool over async secret-detection** — Unknown
- [ADR-0426](./decisions/0426-logger-leaky-bucket-and-stripped-policy.md) **Logger sanitize STRIPPED policy + leaky-bucket DoS closure (R3+R4+R5 consolidated)** — Unknown
- [ADR-0428](./decisions/0428-network-egress-proxy.md) **Socket-level network egress proxy + runtime policy amendment** — Unknown
- [ADR-0438](./decisions/0438-permission-profile-inheritance.md) **Permission-profile inheritance (`extends` + cycle detection + Managed tagging)** — Unknown
- [ADR-0441](./decisions/0441-windows-sandbox.md) **Windows OS-sandbox backend (pure compiler + native boundary)** — Unknown
- [ADR-0443](./decisions/0443-mode-cycle-pill.md) **shift+tab permission/agent mode-cycle + input pill** — Unknown
- [ADR-0480](./decisions/0480-team-broker-coordination.md) **Team broker coordination — leader-mediated permission escalation for worker subagents** — Accepted _(2026-06-06)_ — related: ADR-0026
- [ADR-0489](./decisions/0489-exfil-scouting-detector.md) **exfil-scouting detector — deterministic probe-sequence signal over the egress deny-log** — Accepted _(2026-06-07)_
- [ADR-0490](./decisions/0490-secret-aware-egress.md) **secret-aware egress — outbound body/header secret scan (plaintext-HTTP)** — Accepted _(2026-06-07)_
- [ADR-0491](./decisions/0491-tls-mitm-egress.md) **TLS-MITM egress — HTTPS body/header secret scanning (ephemeral-CA decrypt → reuse scan → re-encrypt)** — Accepted _(2026-06-07)_
- [ADR-0498](./decisions/0498-central-config-loader-project-trust.md) **central on-disk config loader + per-project trust gate** — Accepted _(2026-06-07)_
- [ADR-0512](./decisions/0512-skill-tool-scope-availability-permission.md) **skill 도구 스코핑 — 가용성(visibility) ⟂ 권한(permission) 2축 분리 + escalation UX** — Accepted — P0~P2 LANDED + P3 코어 LANDED (3R 적대 어딧 통과). 잔여 surface 후속은 아래 §구현 현황. _(2026-06-09)_ — related: ADR-0011
- [ADR-0519](./decisions/0519-connector-marketplace-v1-and-policy.md) **Connector marketplace V1 (DirectoryApp lifecycle) + enterprise marketplace policy** — Proposed (2026-06-09)
- [ADR-0523](./decisions/0523-worktree-agent-tool-slot-and-cwd-override.md) **git-worktree agent tools — session-scoped slot + relative-cwd override (NOT a trust-boundary redefinition)** — Proposed _(2026-06-09)_ — related: ADR-0091

### Uncategorized (290)

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
- [ADR-0130](./decisions/0130-extracted-source-absorption-roadmap.md) **Extracted-source absorption roadmap (R1–R6 → ADR 후보 catalog)** — ✅ **CLOSED / fully absorbed (jun-06)** — all 12 waves landed (W1–W5 = ADR 0131–0135 / W6 = 0159-retrieval-sota-stack / W7 = 0160-connectors-rest-api / W8 = 0161-scheduled-agent / W11 = 0162-plugin-process-isolation / W12 = 0163-multicloud-oauth-lock + 0163-foundry-future-ready). W9/W10 dropped as redundant. 코드 grep 전수검증(jun-06): reactor·hook-RPC·skill-scope·retrieval·connectors·scheduler 전부 src에 존재. 활성 backlog **0**. (was: Proposed 2026-05-24, roadmap only)
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
- [ADR-0193](./decisions/0193-plane-clean-enforcement.md) **Plane-clean — enforce or de-claim** — Unknown
- [ADR-0198](./decisions/0198-identity-mode-variant.md) **Identity mode-variant — per-mode system-prompt identity slot** — Unknown
- [ADR-0200](./decisions/0200-stream-idle-timeout.md) **Stream idle timeout watchdog + snooze** — Unknown
- [ADR-0201](./decisions/0201-fork-session.md) **Fork session (parent-child snapshot branching)** — Unknown
- [ADR-0202](./decisions/0202-voice-input-stt.md) **Voice input (microphone capture + STT)** — Accepted _(2026-05-25)_
- [ADR-0203](./decisions/0203-user-authored-playbook-frontmatter.md) **User-authored playbook frontmatter (procedure / success-criteria / forbidden-actions / macros / inline-trigger)** — Accepted _(2026-05-25)_
- [ADR-0204](./decisions/0204-shell-snapshot.md) **Per-turn shell environment snapshot (hermetic shell)** — Unknown
- [ADR-0205](./decisions/0205-multi-source-rules-vendor-detector.md) **Multi-source rules vendor-detector (S2 — 5-vendor convergence)** — Accepted _(2026-05-25)_
- [ADR-0206](./decisions/0206-per-thread-dynamic-tools.md) **Per-thread dynamic tools with `defer_loading`** — Unknown
- [ADR-0209](./decisions/0209-per-tool-checkpoint-granularity.md) **Per-tool-call checkpoint granularity (Cline / Cursor / Codex absorption)** — Accepted (default-OFF; not yet wired into dispatch — opt-in for callers) _(2026-05-25)_ — related: ADR-0108, ADR-0118, ADR-0121, ADR-0122, ADR-0124
- [ADR-0210](./decisions/0210-three-way-restore.md) **3-way restore — Files Only / Task Only / Both (Cline 패턴)** — Accepted (default-OFF; slash command `/rewind-tool` 등록, 조립 layer가 wiring opt-in) _(2026-05-25)_ — related: ADR-0118, ADR-0122, ADR-0124, ADR-0209
- [ADR-0211](./decisions/0211-identity-mode-variant.md) **System-prompt mode-variant — registry + 6-mode variant table** — Unknown
- [ADR-0212](./decisions/0212-sticky-model-per-mode.md) **Sticky model-per-mode — fs-backed `{mode → modelId}` store + resolver** — Unknown
- [ADR-0218](./decisions/0218-subagent-mode-typed-delegation.md) **Mode-typed delegation (parent → child mode-typed handoff)** — Accepted _(2026-05-25)_
- [ADR-0219](./decisions/0219-focus-chain-auto-reinject.md) **Focus Chain (automatic N-turn todo-list re-injection)** — Accepted _(2026-05-25)_
- [ADR-0220](./decisions/0220-git-directive-emit.md) **Git directive emit protocol (`::git-*`)** — Accepted _(2026-05-25)_
- [ADR-0221](./decisions/0221-git-directive-emit-protocol.md) **Git `::git-*` 5-directive emit protocol — phase-guarded behavioral layer** — Accepted _(2026-05-25)_
- [ADR-0223](./decisions/0223-auto-background-stuck-detector.md) **Auto-background after 2 s — stuck-detector + propose-handler** — Accepted _(2026-05-25)_
- [ADR-0224](./decisions/0224-cli-slash-web-paste.md) **CLI `/web` + `/paste` (text-inbox absorption)** — Accepted _(2026-05-25)_
- [ADR-0226](./decisions/0226-fork-session-port.md) **Fork session — ForkSessionPort (branch-name + signal + shadow-tag)** — Unknown
- [ADR-0227](./decisions/0227-spinner-stall-detection.md) **Spinner stall detection (B6 — Claude Code `tengu_spinner_stalled_ui` 흡수)** — Unknown
- [ADR-0228](./decisions/0228-queued-followup-per-msg-mutators.md) **Queued follow-up per-msg mutators (`retry` / `edit` / `delete` / `sendNow`)** — Accepted _(2026-05-25)_
- [ADR-0231](./decisions/0231-radar-cards-proposal-queue.md) **Radar cards — background proposal queue engine (MVP)** — Accepted _(2026-05-25)_
- [ADR-0232](./decisions/0232-git-directive-turn-collector-wire.md) **Git directive turn-collector wire (phase-aware emit)** — Accepted _(2026-05-25)_
- [ADR-0233](./decisions/0233-stage1-phase2-consume-and-vendor-glob-wire.md) **Stage1→Phase2 reuse-consume + vendor-detector ↔ glob-rules wire** — Partially superseded (2026-07-19) _(2026-05-25)_
- [ADR-0237](./decisions/0237-llm-error-16-kind-layer-owned-arms-wire.md) **LLM error 16-kind close-out: layer-owned arms wire** — Unknown
- [ADR-0238](./decisions/0238-shell-snapshot-production-spawner-and-size-prune.md) **Shell-snapshot — production Bun spawner, size-budget prune, CLI opt-in** — Accepted _(2026-05-25)_ — related: ADR-0204
- [ADR-0239](./decisions/0239-debug-tracer-decision-event.md) **Debug tracer + `decision` event (developer mode for gate observability)** — Accepted _(2026-05-25)_
- [ADR-0245](./decisions/0245-custom-3p-setup-mvp.md) **Custom 3P Setup MVP (5 core method + lifecycle)** — Unknown
- [ADR-0249](./decisions/0249-node-repl-persistent-kernel.md) **Node REPL persistent kernel — Jupyter-style per-session node process** — Accepted _(2026-05-25)_ — related: ADR-0204
- [ADR-0251](./decisions/0251-streaming-boomerang.md) **Streaming boomerang (parent ↔ child progressive consumption)** — Accepted _(2026-05-25)_
- [ADR-0252](./decisions/0252-template-literal-windsurf.md) **Template-literal `{{ variable }}` expander — Windsurf workflow parity (sibling to ADR-0203 `!macro`)** — Accepted _(2026-05-25)_ — related: ADR-0203
- [ADR-0253](./decisions/0253-spec-to-test-gen-devin.md) **Devin playbook spec → bun:test fixture auto-generation** — Accepted _(2026-05-25)_
- [ADR-0256](./decisions/0256-role-based-model-override.md) **Role-based model override — `{role → modelId}` resolver (Roo orchestrator absorption)** — Unknown
- [ADR-0257](./decisions/0257-ai-attribution-tool.md) **AI-attribution tool — training-data attribution search MVP** — Superseded (2026-06-04) — the `ai_attribution` tool was REMOVED. _(2026-05-25)_ — related: ADR-0127
- [ADR-0258](./decisions/0258-playbook-nesting.md) **Playbook nesting — bounded recursive call chain with cycle detection** — Accepted _(2026-05-25)_ — related: ADR-0203
- [ADR-0260](./decisions/0260-lexical-search-bm25-ripgrep.md) **LexicalSearch — BM25 + ripgrep pluggable retrieval engine** — Accepted _(2026-05-25)_ — related: ADR-0159
- [ADR-0263](./decisions/0263-embed-cache.md) **EmbedCache — idempotent content-hash + model-tag embed cache** — Accepted _(2026-05-25)_ — related: ADR-0159
- [ADR-0265](./decisions/0265-search-pipeline-composer.md) **SearchPipeline composer + 5 pre-built presets** — Accepted _(2026-05-25)_ — related: ADR-0159, ADR-0136
- [ADR-0266](./decisions/0266-model-tag-versioning.md) **ModelTag versioning — cache + index invalidation when the embedder model changes** — Accepted _(2026-05-25)_ — related: ADR-0254
- [ADR-0267](./decisions/0267-decision-emit-phase-2-wire.md) **`decision` event emit — Phase 2 wire-up at the admissibility gate** — Accepted _(2026-05-25)_
- [ADR-0271](./decisions/0271-why-meta-llm-reasoning-query.md) **`/why <toolCallId|last>` — meta-LLM reasoning query for a recorded tool call** — Unknown
- [ADR-0274](./decisions/0274-budget-probe-ledger-wire.md) **BudgetProbe — real wire from ADR-0138 budget-ledger to ADR-0265 budget-aware preset** — Accepted _(2026-05-25)_ — related: ADR-0138
- [ADR-0275](./decisions/0275-real-api-smoke-eval.md) **Real-API smoke eval for retrieval — drift detection (eval tier, non-blocking)** — Accepted _(2026-05-25)_ — related: ADR-0003
- [ADR-0277](./decisions/0277-session-effort-wire.md) **Session-level reasoning effort wire — `/effort` slash + `EffortStore` precedence fold-in** — Unknown
- [ADR-0278](./decisions/0278-search-codebase-auto-register.md) **`search_codebase` tool + auto-register wire** — Accepted _(2026-05-25)_ — related: ADR-0265, ADR-0277
- [ADR-0280](./decisions/0280-automation-tool-inbox-cli.md) **`automation_update` tool + REPL inbox banner (E2 productization)** — Unknown
- [ADR-0286](./decisions/0286-deferred-result-registry-production.md) **Production `DeferredResultRegistry` — registry-managed deferred work** — Accepted _(2026-05-25)_ — related: ADR-0064
- [ADR-0287](./decisions/0287-async-tool-kind-poll-deferred.md) **Async tool kind + `poll_deferred` — `defineToolAsync` + LLM probe** — Accepted _(2026-05-25)_ — related: ADR-0286
- [ADR-0291](./decisions/0291-repl-slash-ctx-mega-wire.md) **REPL slash-surface ctx mega-wire** — Unknown
- [ADR-0292](./decisions/0292-conv-checkpoint-auto-record.md) **Conversation-Checkpoint Per-Turn Auto-Record + `/rewind-conv` Slash** — Accepted (default-OFF).
- [ADR-0293](./decisions/0293-playbook-trigger-cli-bind.md) **playbookTrigger CLI auto-bind opt-in** — Unknown
- [ADR-0294](./decisions/0294-session-export-import-slash.md) **`/session export <id>` + `/session import <path>` slash** — Accepted — landed `src/apps/cli/session-cmd.ts` + BUILTINS slot +
- [ADR-0296](./decisions/0296-async-shell-background.md) **Async-shell: `timeout_behavior:"background"` + `bash_await` + `bash_kill`** — Accepted (default-OFF — the new schema field is optional, absent ⇒ legacy
- [ADR-0297](./decisions/0297-cli-runtime-feature-config-unification.md) **CLI runtime feature-config unification** — Unknown
- [ADR-0299](./decisions/0299-cli-bootstrap-host-extraction.md) **Host-bootstrap extraction — thin CLI / headless engine seam** — Accepted _(2026-05-25)_ — related: ADR-0024
- [ADR-0301](./decisions/0301-playbook-trigger-flag-echo.md) **`--playbook-trigger` CLI flag echo through to wire** — Unknown
- [ADR-0302](./decisions/0302-identity-mid-session-prompt-rebuild.md) **`/identity <mode>` mid-session system-prompt rebuild** — Unknown
- [ADR-0303](./decisions/0303-thin-surface-headless-core.md) **Thin surfaces, headless core, and the surface-coupling ratchet** — Unknown
- [ADR-0304](./decisions/0304-side-conversation-port.md) **`SideConversationPort` — slash-surface ↔ runner seam for `/side`** — Unknown
- [ADR-0305](./decisions/0305-cli-session-cmd-shim-removal.md) **CLI-05 — Remove `session-commands.ts` shim, wire two adapters at call site** — Unknown
- [ADR-0306](./decisions/0306-slash-registry-split.md) **CLI-03 — Slash registry split (`surface` / `session` / `app`)** — Unknown
- [ADR-0308](./decisions/0308-headless-second-consumer.md) **ARCH-07 — Headless second-consumer proof** — Unknown
- [ADR-0309](./decisions/0309-surface-wire-r2.md) **Surface-Wire R2: identity onChange + granular registry + per-tool auto-record** — Unknown
- [ADR-0312](./decisions/0312-github-app-webhook-host-scaffold.md) **GitHub App webhook host scaffold (Tier 1, intentionally deferred)** — accepted (2026-05-26) — scaffold + signature path; impl deferred until host decision
- [ADR-0313](./decisions/0313-pr-output-sink-redaction.md) **PR output sink redaction + idempotency invariants** — accepted (2026-05-26)
- [ADR-0315](./decisions/0315-web-daemon-surface.md) **Web daemon surface (Bun.serve + WebSocket → RuntimeSession)** — accepted (2026-05-26)
- [ADR-0316](./decisions/0316-web-frontend-surface.md) **Web frontend surface (Vite + React + Tailwind SPA)** — accepted (2026-05-26)
- [ADR-0317](./decisions/0317-tauri-desktop-shell.md) **Tauri desktop shell (macOS v1)** — accepted (2026-05-26) — scaffold + sidecar wiring landed; production signing/notarization deferred
- [ADR-0319](./decisions/0319-system-prompt-vision-priority.md) **System-prompt vision priority** — Unknown
- [ADR-0321](./decisions/0321-context-change-persistent-injection.md) **Context-change detector + persistent typed-event injection** — Unknown
- [ADR-0322](./decisions/0322-cache-control-thread-stability.md) **Cache-control thread-stability audit** — Unknown
- [ADR-0323](./decisions/0323-image-history-sanitization.md) **Image content sanitization in history** — accepted (2026-05-27) — related: ADR-0083, ADR-0126, ADR-0137, ADR-0214, ADR-0234
- [ADR-0324](./decisions/0324-compaction-typed-history-event.md) **Compaction event as typed history variant (ADR-0320 closed-set extension)** — Unknown
- [ADR-0325](./decisions/0325-mention-based-explicit-injection.md) **Mention-based explicit context injection** — Unknown
- [ADR-0326](./decisions/0326-system-prompt-session-cache.md) **System prompt session-level cache** — Unknown
- [ADR-0327](./decisions/0327-buildturncontext-wire-seam.md) **`buildTurnContext` wire seam for ADR-0321 / 0325 / 0326** — Unknown
- [ADR-0328](./decisions/0328-image-sanitization-retry-wire.md) **invalid_image classification + sanitization-retry wire (ADR-0323 production wire)** — Accepted and landed. Slice + production hookup both in main: the wrap mutates
- [ADR-0329](./decisions/0329-context-events-closure-factory.md) **Context-events closure factory (ADR-0321 producer wire)** — Accepted — 2026-05-27. Slice landed; composition-root wiring deferred to
- [ADR-0331](./decisions/0331-reactive-compaction-emit-wire.md) **Reactive (mid-turn) compaction emit wire** — Unknown
- [ADR-0333](./decisions/0333-image-retry-production-hookup.md) **image-sanitization-retry production hookup in `createRunAgentContext`** — Accepted. Hookup landed in `src/agent/loop.ts#createRunAgentContext` via user commit `1f95988554fa2a5cdb913c966088b15ef0730f7f` (`done`), which absorbed the W-D draft and tightened two decisions.
- [ADR-0335](./decisions/0335-typed-event-closed-set-bulk-extension.md) **Typed-event closed-set bulk extension (`plugin_activation` + `app_activation`)** — Unknown
- [ADR-0336](./decisions/0336-plugin-app-resolver.md) **Plugin manifest absorption + app catalog + composite resolver** — Unknown
- [ADR-0337](./decisions/0337-image-retry-wm-live-snapshot.md) **image-retry wm-live snapshot on sanitize-and-retry** — Accepted (2026-05-27). Closes the ADR-0328 / ADR-0333 §Limitations entry _(2026-05-27)_
- [ADR-0338](./decisions/0338-llm-surface-transport-and-openai-checkpoint-seams.md) **LLM surface/transport metadata, Anthropic codec SSOT, and OpenAI cache/checkpoint seams** — Accepted (2026-05-27). _(2026-05-27)_
- [ADR-0338](./decisions/0338-plugin-mcp-launcher.md) **Plugin-declared MCP server launcher primitive** — Accepted. Slice landed (`src/agent/plugin-mcp-launcher/`) + production
- [ADR-0340](./decisions/0340-plugin-activation-trigger.md) **Plugin activation trigger handler** — Accepted. Slice landed (`src/agent/plugin-activation-handler/`) + the
- [ADR-0341](./decisions/0341-plugin-manifest-shape-unification.md) **Plugin manifest shape unification (ADR-0039 ↔ ADR-0336)** — Accepted _(2026-05-27)_
- [ADR-0342](./decisions/0342-workspace-app-catalog-override.md) **Per-workspace `.quanta/apps.json` app-catalog override** — Unknown
- [ADR-0344](./decisions/0344-context-grounding-benchmark-and-gate.md) **Context grounding benchmark and release gate** — Unknown
- [ADR-0352](./decisions/0352-codex-r2-observability-metrics.md) **Codex-r2 observability metrics** — Unknown
- [ADR-0355](./decisions/0355-cross-machine-session-replication.md) **Cross-machine session-registry replication — Negative** — Unknown
- [ADR-0356](./decisions/0356-disk-registry-multi-process-flock.md) **Multi-process lockfile for the disk-backed session registry** — Unknown
- [ADR-0365](./decisions/0365-windows-flock-strategy.md) **Windows strategy for the disk-registry per-session lockfile** — Unknown
- [ADR-0369](./decisions/0369-session-registry-auto-sweep.md) **Auto-wire `sweepDiskRegistry` + `sweepSqliteRegistry` (on-startup + periodic)** — Unknown
- [ADR-0370](./decisions/0370-session-registry-inspector-slash.md) **`SessionResourceRegistry` inspector + `/session-registry stats` slash** — Unknown
- [ADR-0374](./decisions/0374-session-registry-evict-slash.md) **`/session-registry evict <id>` slash sub-command** — Unknown
- [ADR-0375](./decisions/0375-sqlite-wal-restart-checkpoint.md) **WAL-size-threshold RESTART checkpoint (Codex 14 GB WAL parity)** — Unknown
- [ADR-0376](./decisions/0376-session-registry-help-discovery.md) **`/session-registry help` sub-command discovery** — Unknown
- [ADR-0377](./decisions/0377-cross-platform-inspector-path-normalization.md) **Cross-platform inspector path normalization** — Unknown
- [ADR-0379](./decisions/0379-session-registry-cleanup-slash.md) **`/session-registry cleanup` slash** — Unknown
- [ADR-0383](./decisions/0383-unified-registry-api.md) **Unified `getOrCreateRegistry(opts)` API (additive, non-breaking)** — Unknown
- [ADR-0384](./decisions/0384-evict-hygiene-message.md) **`/session-registry evict` hygiene message** — Unknown
- [ADR-0387](./decisions/0387-cleanup-dry-run.md) **`/session-registry cleanup --dry-run` (preview without commit)** — Unknown
- [ADR-0388](./decisions/0388-registry-mint-deprecation-roadmap.md) **Registry-mint deprecation roadmap (ADR-0383 follow-up)** — Unknown
- [ADR-0390](./decisions/0390-auto-sweep-wal-knob-wire.md) **Auto-sweep WAL knob wire (close ADR-0375/0385 production-path gap)** — Unknown
- [ADR-0393](./decisions/0393-synchronous-delegate-tool.md) **Synchronous `delegate` tool (in-band mode-typed boomerang)** — Unknown
- [ADR-0394](./decisions/0394-objective-first-class.md) **Objective as a first-class per-thread object** — Unknown
- [ADR-0395](./decisions/0395-run-ledger.md) **Run Ledger: unified long-running-work state model** — Unknown
- [ADR-0396](./decisions/0396-shadow-verify.md) **Shadow Verify (apply-before-show in a scratch overlay)** — Unknown
- [ADR-0397](./decisions/0397-env-build-dynamic-context.md) **Env / build dynamic context block** — Unknown
- [ADR-0398](./decisions/0398-atomic-write-and-hash-precondition.md) **Atomic write + sha256 hash precondition for `edit` / `write`** — Unknown
- [ADR-0400](./decisions/0400-shadow-verify-adapters-and-tool.md) **Shadow Verify real adapters + `shadow_verify` LLM tool (Wave 2)** — Unknown
- [ADR-0402](./decisions/0402-objective-tools.md) **Objective LLM tools (`objective_set` / `objective_update` / `objective_get`)** — Unknown
- [ADR-0404](./decisions/0404-lsp-rename-rpc-and-apply.md) **`lsp_rename` — `textDocument/rename` RPC + atomic apply** — Unknown
- [ADR-0408](./decisions/0408-observability-ui-pane.md) **Observability UI pane (Running / Waiting / Completed + Objective + Approvals)** — Unknown
- [ADR-0409](./decisions/0409-compaction-visibility.md) **Compaction visibility (RecoveryReason + microcompact + post_compact)** — Unknown
- [ADR-0410](./decisions/0410-tool-describe-steering-and-prompt-fewshots.md) **bash/edit/write describe steering + prompt-body few-shot examples** — Unknown
- [ADR-0411](./decisions/0411-bash-output-cap-delegation.md) **Bash output truncation delegated to registry `capToolOutput`** — Unknown
- [ADR-0413](./decisions/0413-file-mention-kind-sync-additive.md) **`@file` mention kind (sync, additive extension of frozen ADR-0325)** — Unknown
- [ADR-0417](./decisions/0417-effort-classifier-and-fast-apply-fallback.md) **Effort classifier + apply-patch fast-apply fallback (ports only)** — Unknown
- [ADR-0418](./decisions/0418-async-mention-resolver-and-file-symbol.md) **Async mention resolver + `@file` / `@symbol` mention kinds** — Unknown
- [ADR-0421](./decisions/0421-fast-apply-wire.md) **Fast-apply fallback wired into `apply_patch` (closes ADR-0417 §A2 apply-wire)** — Unknown
- [ADR-0422](./decisions/0422-mention-wire-symbol-skill-cli.md) **Mention wire-up: `@symbol` adapters + DRY builder + CLI/host-runtime injector** — Unknown
- [ADR-0423](./decisions/0423-mention-symbol-production-wire.md) **Production `@symbol`: deterministic LSP anchor synthesis + semantic wire** — Unknown
- [ADR-0424](./decisions/0424-search-index-vector-store-cutover.md) **Search-index VectorStore consumer cutover + LanceDB wire** — Accepted _(2026-05-29)_
- [ADR-0425](./decisions/0425-observability-audit-findings-and-ratchets.md) **Observability stack audit (3-round, adversarial) findings + structural ratchets** — Unknown
- [ADR-0427](./decisions/0427-browser-automation.md) **Browser automation (interactive CDP driving)** — Unknown
- [ADR-0430](./decisions/0430-competitor-import-persistence.md) **Competitor-import persistence (real session import + MCP/hooks/rules + dedup)** — Unknown
- [ADR-0433](./decisions/0433-adversarial-multi-voter-verify.md) **Adversarial multi-voter verification layer** — Unknown
- [ADR-0434](./decisions/0434-permission-profile-list-select.md) **PermissionProfile List + Select + user-defined profiles from disk** — Unknown
- [ADR-0435](./decisions/0435-mcp-auto-restart.md) **MCP crash-detection + auto-restart (exponential backoff)** — Unknown
- [ADR-0439](./decisions/0439-at-mention-autocomplete.md) **CLI `@`-mention autocomplete dropdown (input-surface wire)** — Unknown
- [ADR-0440](./decisions/0440-canvas-web-components.md) **Canvas Web Components (render-side DiffView + UsageBar)** — Unknown
- [ADR-0442](./decisions/0442-realtime-voice.md) **Realtime bidirectional voice session (`RealtimeVoiceSession`)** — Unknown
- [ADR-0444](./decisions/0444-completion-notify-osc-bell.md) **turn-completion terminal notification (OSC title + BEL)** — Unknown
- [ADR-0445](./decisions/0445-pre-compaction-context-warning.md) **pre-compaction / context-window warning (read-only preamble)** — Unknown
- [ADR-0447](./decisions/0447-keybinding-config-layer.md) **user-customizable keybinding layer** — Unknown
- [ADR-0448](./decisions/0448-canvas-rich-diff-usage.md) **Canvas Rich Layer (split DiffView + collapsible hunks + labeled UsageBar legend)** — Unknown
- [ADR-0449](./decisions/0449-cli-unified-diff-hunk-headers-and-line-number-gutters.md) **CLI diff preview: unified-diff hunk headers + old/new line-number gutters** — Unknown
- [ADR-0450](./decisions/0450-live-tokens-per-sec-spinner-rate.md) **live tokens/sec throughput on the streaming spinner** — Unknown
- [ADR-0454](./decisions/0454-command-hooks.md) **Disk-configured command hooks (security-gated shell on HookBus events)** — Unknown
- [ADR-0456](./decisions/0456-edit-fuzzy-scored-candidate-recovery.md) **edit fuzzy ladder: scored-candidate recovery on the ambiguous path** — Unknown
- [ADR-0458](./decisions/0458-diff-derived-conventional-commit-scope-inference.md) **diff-derived Conventional Commits scope inference** — Unknown
- [ADR-0460](./decisions/0460-gh-pr-open-author-and-ship-seam.md) **`gh_pr_open`: author + open a PR in one step** — Unknown
- [ADR-0463](./decisions/0463-agent-jobs-batch.md) **CSV batch-job runner (`agent_jobs`): row-indexed fan-out over subagents** — Unknown
- [ADR-0464](./decisions/0464-apply-patch-structured-result.md) **Structured per-file apply result + messageForModel (self-correcting edits)** — Unknown
- [ADR-0466](./decisions/0466-env-probe.md) **Startup environment probe + graceful-degradation warnings** — Unknown
- [ADR-0467](./decisions/0467-prompt-suggestion.md) **Prompt-suggestion + quality reject-gate** — Unknown
- [ADR-0468](./decisions/0468-ndjson-introspection.md) **NDJSON live-event introspection sink** — Unknown
- [ADR-0469](./decisions/0469-structured-output-mode.md) **Structured output mode: `response_format` json_schema passthrough** — Unknown
- [ADR-0470](./decisions/0470-config-provenance-gate.md) **Config-provenance gate (repo-controllable config may only narrow)** — Unknown
- [ADR-0471](./decisions/0471-untrusted-source-envelope.md) **Untrusted-source result envelope** — Unknown
- [ADR-0473](./decisions/0473-background-compaction.md) **Background (speculative) compaction: cancellable summarize with 2-phase install** — Unknown
- [ADR-0474](./decisions/0474-stale-read-guard.md) **Stale-read guard: block clobbering edits + post-bash re-read reminder** — Unknown
- [ADR-0475](./decisions/0475-dxt-user-config.md) **DXT user_config — typed user configuration, template substitution, keychain secrets** — Unknown
- [ADR-0477](./decisions/0477-artifact-canvas-store.md) **Artifact canvas store — session-scoped registry for non-code generation outputs** — Accepted _(2026-06-06)_ — related: ADR-0280
- [ADR-0484](./decisions/0484-mcp-connector-discovery.md) **MCP connector discovery — catalog + `mcp_connector_list`/`mcp_connector_install` over a fail-closed `.mcp.json` writer** — Accepted _(2026-06-06)_ — related: ADR-0160
- [ADR-0487](./decisions/0487-force-background.md) **force_background — opt-in admission queue + promote-a-waiter for background subagents (C5)** — Accepted _(2026-06-06)_ — related: ADR-0130, ADR-0145
- [ADR-0492](./decisions/0492-microcompact-tool-result-evict.md) **microcompaction — tier-1 tool-result eviction (in-place content clearing)** — Accepted _(2026-06-07)_
- [ADR-0494](./decisions/0494-ask-user-elicitation.md) **ask_user — generalized structured elicitation** — Accepted _(2026-06-07)_
- [ADR-0495](./decisions/0495-lint-delta-line-tolerance.md) **line-shift-tolerant lint delta** — Accepted _(2026-06-07)_
- [ADR-0496](./decisions/0496-control-request-surface.md) **control-request runtime surface** — Accepted _(2026-06-07)_
- [ADR-0497](./decisions/0497-guardian-per-action-assessment.md) **guardian per-action TYPED assessment (binary verdict → discriminated assessment)** — Accepted _(2026-06-07)_
- [ADR-0500](./decisions/0500-model-based-fast-apply-merge.md) **model-based fast-apply MERGE rung (apply-model elision merge)** — Accepted _(2026-06-07)_
- [ADR-0501](./decisions/0501-mcp-protocol-version-negotiation.md) **MCP protocol-version SSOT + newest-first negotiation** — Accepted _(2026-06-07)_
- [ADR-0502](./decisions/0502-auto-mode-rule-overlay-circumvention.md) **auto-mode user-rule overlay + tool-switch circumvention detection** — Accepted _(2026-06-07)_
- [ADR-0503](./decisions/0503-knob-governance-and-capability-layer.md) **knob 거버넌스 (완전성 ratchet) + Capability 레이어 방향** — Accepted (P0 구현 시작; P1~P5 단계적) _(2026-06-07)_
- [ADR-0504](./decisions/0504-reflect-self-correction-tool.md) **`reflect` mid-turn self-correction tool** — Accepted _(2026-06-07)_
- [ADR-0505](./decisions/0505-context-1m-window.md) **1M-context window opt-in (Anthropic `context-1m` beta)** — Accepted _(2026-06-07)_
- [ADR-0506](./decisions/0506-anthropic-service-tier.md) **Anthropic `service_tier` request control** — Accepted _(2026-06-07)_
- [ADR-0508](./decisions/0508-item-lifecycle-stream.md) **item-lifecycle stream projector** — Accepted _(2026-06-07)_
- [ADR-0511](./decisions/0511-fork-turns.md) **fork_turns — parent-context inheritance for spawned subagents (GAP8a)** — Accepted _(2026-06-08)_
- [ADR-0513](./decisions/0513-gh-pr-code-tour-guided-diff-walkthrough.md) **`gh_pr_code_tour` — guided PR-diff walkthrough (Cursor code-tour / Codex review-stops 흡수)** — Proposed _(2026-06-09)_
- [ADR-0514](./decisions/0514-git-co-change-related-files.md) **git_co_change — co-change / related-files signal (§7.2 long-tail)** — Proposed _(2026-06-09)_
- [ADR-0515](./decisions/0515-ci-finding-structured-record.md) **ci_finding — structured CI-investigation finding store + tool (§7.3 long-tail)** — Proposed _(2026-06-09)_
- [ADR-0516](./decisions/0516-cli-attach-daemon-client.md) **`quanta attach` CLI → daemon session client** — Proposed (2026-06-09)
- [ADR-0517](./decisions/0517-cli-model-picker-effort-clamp.md) **`/model` interactive picker + model↔effort clamp (Codex `validateEffort` mirror)** — Proposed _(2026-06-09)_ — related: ADR-0462, ADR-0212
- [ADR-0518](./decisions/0518-background-turn-portal.md) **background-turn portal — Ctrl+B detach + `/background` (ticket-18 V1)** — Proposed _(2026-06-09)_
- [ADR-0520](./decisions/0520-reverse-mcp-server.md) **Reverse-MCP (TICKET-19) — expose quanta AS an MCP server over stdio with a read-only-by-default RCE fence** — Proposed _(2026-06-09)_ — related: ADR-0391
- [ADR-0521](./decisions/0521-proxy-outbound-header-rewrite.md) **Egress-proxy outbound header-rewrite rules (operator transform + forbidden-inject / forbidden-framing guards)** — Proposed _(2026-06-09)_
- [ADR-0528](./decisions/0528-crash-resume-live-wiring.md) **Crash-resume LIVE 배선 (§13.2 승급) — 턴-경계 마커 + 재시작 offer + 스트리밍 partial 신선도** — Proposed _(2026-06-09)_ — related: ADR-0525
- [ADR-0529](./decisions/0529-cross-platform-shell-execution.md) **크로스플랫폼 셸 실행 SOTA++ — POSIX-우선 발견 ladder + dialect-aware 보안 + darwin서 검증가능한 설계 (P16 승급)** — Proposed _(2026-06-09)_
- [ADR-0530](./decisions/0530-absorption-n1-w6-mcp-governance.md) **jun-09/10 흡수 트리오 — 언어 자동감지(N1) · notebook_edit(W6/P17) · MCP 거버넌스 LIVE(§12.4 해소)** — Accepted (구현·테스트 완료) _(2026-06-10)_ — related: ADR-0481, ADR-0497, ADR-0068, ADR-0474
- [ADR-0531](./decisions/0531-dap-debugger-tool.md) **W5 — DAP debugger tool (`debug_inspect`)** — Accepted (구현·테스트 완료) _(2026-06-10)_ — related: ADR-0530
- [ADR-0532](./decisions/0532-multilang-test-runner.md) **Epic-2 — multi-language structured test runner (`run_tests`) + toolchain detector** — Accepted (구현·실검증 완료) _(2026-06-10)_ — related: ADR-0531
- [ADR-0533](./decisions/0533-evidence-packet-builder.md) **Keystone — Evidence Packet Builder (`collect_evidence`)** — Accepted (core 구현·실융합 검증 완료; enrichment bridge는 명시적 follow-up) _(2026-06-10)_ — related: ADR-0531, ADR-0532
- [ADR-0535](./decisions/0535-localize-phase-knob.md) **localize-phase — bench knob for Agentless localize-first pre-pass** — Accepted (registry 등록, bench-surface 게이트, resolveBenchKnobs 경유 apply) _(2026-06-15)_
- [ADR-0536](./decisions/0536-bench-remote-and-unified-cli.md) **Unified `quanta-bench` CLI + remote grading (sb-cli / SSH / AWS) + analysis layer** — Unknown
- [ADR-0538](./decisions/0538-channelized-instruction-graph-compiler.md) **Channelized Instruction Graph Compiler (prompt-as-compiled-primitives)** — Unknown
- [ADR-0539](./decisions/0539-tracing-observability-architecture.md) **Bench tracing/observability architecture: layers, SSOT, correlation tuple** — Unknown
- [ADR-0541](./decisions/0541-parallel-lane-observability.md) **Parallel candidate-lane observability: ambient lane id + recording-lane LLMPort decorator + progress bus** — Unknown

## ADR Timeline

### 2026-07-16

- [ADR-0540](./decisions/0540-inline-resumable-approval-resolver.md) 인라인 resumable 승인 resolver — turn-loop이 승인을 in-line await하고, 재설계로 "SDK가 다 처리"를 진짜로 _(Proposed)_

### 2026-06-15

- [ADR-0534](./decisions/0534-session-config-tool.md) session_config — agent self-visibility tool (effort tier / identity mode / tool profile / model) _(Accepted (fully wired; CLI composition root, dispatch seam, BASE_TOOL_NAMES))_
- [ADR-0535](./decisions/0535-localize-phase-knob.md) localize-phase — bench knob for Agentless localize-first pre-pass _(Accepted (registry 등록, bench-surface 게이트, resolveBenchKnobs 경유 apply))_

### 2026-06-10

- [ADR-0530](./decisions/0530-absorption-n1-w6-mcp-governance.md) jun-09/10 흡수 트리오 — 언어 자동감지(N1) · notebook_edit(W6/P17) · MCP 거버넌스 LIVE(§12.4 해소) _(Accepted (구현·테스트 완료))_
- [ADR-0531](./decisions/0531-dap-debugger-tool.md) W5 — DAP debugger tool (`debug_inspect`) _(Accepted (구현·테스트 완료))_
- [ADR-0532](./decisions/0532-multilang-test-runner.md) Epic-2 — multi-language structured test runner (`run_tests`) + toolchain detector _(Accepted (구현·실검증 완료))_
- [ADR-0533](./decisions/0533-evidence-packet-builder.md) Keystone — Evidence Packet Builder (`collect_evidence`) _(Accepted (core 구현·실융합 검증 완료; enrichment bridge는 명시적 follow-up))_

### 2026-06-09

- [ADR-0512](./decisions/0512-skill-tool-scope-availability-permission.md) skill 도구 스코핑 — 가용성(visibility) ⟂ 권한(permission) 2축 분리 + escalation UX _(Accepted — P0~P2 LANDED + P3 코어 LANDED (3R 적대 어딧 통과). 잔여 surface 후속은 아래 §구현 현황.)_
- [ADR-0513](./decisions/0513-gh-pr-code-tour-guided-diff-walkthrough.md) `gh_pr_code_tour` — guided PR-diff walkthrough (Cursor code-tour / Codex review-stops 흡수) _(Proposed)_
- [ADR-0514](./decisions/0514-git-co-change-related-files.md) git_co_change — co-change / related-files signal (§7.2 long-tail) _(Proposed)_
- [ADR-0515](./decisions/0515-ci-finding-structured-record.md) ci_finding — structured CI-investigation finding store + tool (§7.3 long-tail) _(Proposed)_
- [ADR-0517](./decisions/0517-cli-model-picker-effort-clamp.md) `/model` interactive picker + model↔effort clamp (Codex `validateEffort` mirror) _(Proposed)_
- [ADR-0518](./decisions/0518-background-turn-portal.md) background-turn portal — Ctrl+B detach + `/background` (ticket-18 V1) _(Proposed)_
- [ADR-0520](./decisions/0520-reverse-mcp-server.md) Reverse-MCP (TICKET-19) — expose quanta AS an MCP server over stdio with a read-only-by-default RCE fence _(Proposed)_
- [ADR-0521](./decisions/0521-proxy-outbound-header-rewrite.md) Egress-proxy outbound header-rewrite rules (operator transform + forbidden-inject / forbidden-framing guards) _(Proposed)_
- [ADR-0522](./decisions/0522-side-agent-os-process-daemon.md) Side-agent OS-PROCESS daemon V1 — a forked, supervised child with exponential-backoff respawn _(Proposed)_
- [ADR-0523](./decisions/0523-worktree-agent-tool-slot-and-cwd-override.md) git-worktree agent tools — session-scoped slot + relative-cwd override (NOT a trust-boundary redefinition) _(Proposed)_
- [ADR-0524](./decisions/0524-subagent-typed-agent-kind.md) Typed subagent `agentType` — closed-set SSOT + boundary classifier (§4.4) _(Proposed)_
- [ADR-0525](./decisions/0525-session-crash-resume-and-store-health.md) Session resilience — persisted crash-resume marker (§13.2) + aggregate store-health diagnostic (§13.1) _(Proposed)_
- [ADR-0526](./decisions/0526-scriptable-statusline-runner.md) Scriptable statusLine runner (Claude Code stdin contract, args-based spawn, ANSI-aware truncated first line) _(Proposed)_
- [ADR-0527](./decisions/0527-cli-knob-readsite-domain-invariant.md) CLI-knob read-site-domain invariant (a wrong-homed knob is invisible on the web/daemon /knobs surface) _(Proposed)_
- [ADR-0528](./decisions/0528-crash-resume-live-wiring.md) Crash-resume LIVE 배선 (§13.2 승급) — 턴-경계 마커 + 재시작 offer + 스트리밍 partial 신선도 _(Proposed)_
- [ADR-0529](./decisions/0529-cross-platform-shell-execution.md) 크로스플랫폼 셸 실행 SOTA++ — POSIX-우선 발견 ladder + dialect-aware 보안 + darwin서 검증가능한 설계 (P16 승급) _(Proposed)_

### 2026-06-08

- [ADR-0510](./decisions/0510-batch-jobs-agent-toolification.md) batch-jobs agent tool-ification (GAP7) _(Accepted)_
- [ADR-0511](./decisions/0511-fork-turns.md) fork_turns — parent-context inheritance for spawned subagents (GAP8a) _(Accepted)_

### 2026-06-07

- [ADR-0488](./decisions/0488-code-mode-js-runtime.md) code_mode — JS-runtime tool-calling (QuickJS-WASM cell as a dispatch model) _(Accepted)_
- [ADR-0489](./decisions/0489-exfil-scouting-detector.md) exfil-scouting detector — deterministic probe-sequence signal over the egress deny-log _(Accepted)_
- [ADR-0490](./decisions/0490-secret-aware-egress.md) secret-aware egress — outbound body/header secret scan (plaintext-HTTP) _(Accepted)_
- [ADR-0491](./decisions/0491-tls-mitm-egress.md) TLS-MITM egress — HTTPS body/header secret scanning (ephemeral-CA decrypt → reuse scan → re-encrypt) _(Accepted)_
- [ADR-0492](./decisions/0492-microcompact-tool-result-evict.md) microcompaction — tier-1 tool-result eviction (in-place content clearing) _(Accepted)_
- [ADR-0493](./decisions/0493-thin-client-dispatch.md) thin-client dispatch routing _(Accepted)_
- [ADR-0494](./decisions/0494-ask-user-elicitation.md) ask_user — generalized structured elicitation _(Accepted)_
- [ADR-0495](./decisions/0495-lint-delta-line-tolerance.md) line-shift-tolerant lint delta _(Accepted)_
- [ADR-0496](./decisions/0496-control-request-surface.md) control-request runtime surface _(Accepted)_
- [ADR-0497](./decisions/0497-guardian-per-action-assessment.md) guardian per-action TYPED assessment (binary verdict → discriminated assessment) _(Accepted)_
- [ADR-0498](./decisions/0498-central-config-loader-project-trust.md) central on-disk config loader + per-project trust gate _(Accepted)_
- [ADR-0499](./decisions/0499-manifest-codex-compat-ingest.md) plugin/skill manifest codex-compat INGEST (strict schemas reject real codex artifacts) _(Accepted)_
- [ADR-0500](./decisions/0500-model-based-fast-apply-merge.md) model-based fast-apply MERGE rung (apply-model elision merge) _(Accepted)_
- [ADR-0501](./decisions/0501-mcp-protocol-version-negotiation.md) MCP protocol-version SSOT + newest-first negotiation _(Accepted)_
- [ADR-0502](./decisions/0502-auto-mode-rule-overlay-circumvention.md) auto-mode user-rule overlay + tool-switch circumvention detection _(Accepted)_
- [ADR-0503](./decisions/0503-knob-governance-and-capability-layer.md) knob 거버넌스 (완전성 ratchet) + Capability 레이어 방향 _(Accepted (P0 구현 시작; P1~P5 단계적))_
- [ADR-0504](./decisions/0504-reflect-self-correction-tool.md) `reflect` mid-turn self-correction tool _(Accepted)_
- [ADR-0505](./decisions/0505-context-1m-window.md) 1M-context window opt-in (Anthropic `context-1m` beta) _(Accepted)_
- [ADR-0506](./decisions/0506-anthropic-service-tier.md) Anthropic `service_tier` request control _(Accepted)_
- [ADR-0507](./decisions/0507-image-downsample.md) `read_image` downsample codec port _(Accepted)_
- [ADR-0508](./decisions/0508-item-lifecycle-stream.md) item-lifecycle stream projector _(Accepted)_
- [ADR-0509](./decisions/0509-agent-requested-rules.md) agent-requested rules (description-only, fetch-on-demand) _(Accepted)_

### 2026-06-06

- [ADR-0477](./decisions/0477-artifact-canvas-store.md) Artifact canvas store — session-scoped registry for non-code generation outputs _(Accepted)_
- [ADR-0478](./decisions/0478-communicate-update.md) `communicate_update` — structured mid-turn progress channel (Cursor `agent.v1.CommunicateUpdateArgs` absorption) _(Accepted)_
- [ADR-0479](./decisions/0479-team-dag-coordination.md) Team DAG coordination — task dependency DAG over the subagent batch fan-out _(Accepted)_
- [ADR-0480](./decisions/0480-team-broker-coordination.md) Team broker coordination — leader-mediated permission escalation for worker subagents _(Accepted)_
- [ADR-0481](./decisions/0481-heartbeat-automation.md) Heartbeat automation — thread-attached repeating agent (kind cron|heartbeat) _(Accepted)_
- [ADR-0482](./decisions/0482-team-idle-barrier-coordination.md) Team-idle barrier coordination — idle-beacon fan-in over the side-agent daemon team (Capability C) _(Accepted)_
- [ADR-0483](./decisions/0483-background-side-agent.md) Background side-agent daemon — a resident, self-waking monitor that pushes findings without blocking the main loop _(Accepted)_
- [ADR-0484](./decisions/0484-mcp-connector-discovery.md) MCP connector discovery — catalog + `mcp_connector_list`/`mcp_connector_install` over a fail-closed `.mcp.json` writer _(Accepted)_
- [ADR-0485](./decisions/0485-mcp-resource-tools.md) MCP resource/prompt tools (N3) — model-callable `resources/*` + `prompts/*` over a duck-typed port _(Accepted)_
- [ADR-0486](./decisions/0486-pty-attach.md) PTY / tmux session attach — a gated, port-inverted attach-to-existing-terminal slice (N6) _(Accepted)_
- [ADR-0487](./decisions/0487-force-background.md) force_background — opt-in admission queue + promote-a-waiter for background subagents (C5) _(Accepted)_

### 2026-06-02

- [ADR-0453](./decisions/0453-heartbeat-eligibility.md) Heartbeat autorun eligibility — per-thread approval gate for scheduler + reactor _(Accepted)_

### 2026-05-29

- [ADR-0424](./decisions/0424-search-index-vector-store-cutover.md) Search-index VectorStore consumer cutover + LanceDB wire _(Accepted)_

### 2026-05-27

- [ADR-0337](./decisions/0337-image-retry-wm-live-snapshot.md) image-retry wm-live snapshot on sanitize-and-retry _(Accepted (2026-05-27). Closes the ADR-0328 / ADR-0333 §Limitations entry)_
- [ADR-0338](./decisions/0338-llm-surface-transport-and-openai-checkpoint-seams.md) LLM surface/transport metadata, Anthropic codec SSOT, and OpenAI cache/checkpoint seams _(Accepted (2026-05-27).)_
- [ADR-0341](./decisions/0341-plugin-manifest-shape-unification.md) Plugin manifest shape unification (ADR-0039 ↔ ADR-0336) _(Accepted)_

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
- [ADR-0193](./decisions/0193-linux-sandbox-native-impl.md) Linux sandbox native impl (Phase 3.1 — Rust bodies + cargo build verify) _(Accepted (Phase 3.1 — Rust impl wired + workspace + cargo build success on darwin; Phase 3.2 = strict seccomp + GitHub Actions matrix + npm publish 별도 라운드))_
- [ADR-0194](./decisions/0194-darwin-vz-native-scaffold.md) Darwin VZ native scaffold (Skybridge Phase 3.3 — napi-rs binding to Virtualization.framework) _(Accepted (Phase 3.3 scaffold — typed surface + 20-case fake-binding hellgate + workspace member; Phase 3.4 = real `VZVirtualMachine` bring-up + DMG image management + vsock IPC + AVF entitlements))_
- [ADR-0199](./decisions/0199-macos-seatbelt-verbatim.md) macOS Seatbelt verbatim profile + strict knobs _(Accepted (Phase 1 — verbatim parity fixtures + 4 strict knobs default-OFF + injection-defended workspace escape; Phase 2 = sandbox-exec live integration battery extension))_
- [ADR-0202](./decisions/0202-voice-input-stt.md) Voice input (microphone capture + STT) _(Accepted)_
- [ADR-0203](./decisions/0203-user-authored-playbook-frontmatter.md) User-authored playbook frontmatter (procedure / success-criteria / forbidden-actions / macros / inline-trigger) _(Accepted)_
- [ADR-0205](./decisions/0205-multi-source-rules-vendor-detector.md) Multi-source rules vendor-detector (S2 — 5-vendor convergence) _(Accepted)_
- [ADR-0208](./decisions/0208-voice-input-stt-slice.md) Voice `/voice` slice — handle-based recorder + transcriber ports + CLI _(Accepted)_
- [ADR-0209](./decisions/0209-per-tool-checkpoint-granularity.md) Per-tool-call checkpoint granularity (Cline / Cursor / Codex absorption) _(Accepted (default-OFF; not yet wired into dispatch — opt-in for callers))_
- [ADR-0210](./decisions/0210-three-way-restore.md) 3-way restore — Files Only / Task Only / Both (Cline 패턴) _(Accepted (default-OFF; slash command `/rewind-tool` 등록, 조립 layer가 wiring opt-in))_
- [ADR-0214](./decisions/0214-typed-error-enum-16-codex-spec.md) Flat LLMErrorKind 11→16 + RecoveryRouter port (Codex-spec verbatim) _(Accepted)_
- [ADR-0217](./decisions/0217-typed-error-enum-16-routing.md) Typed error enum (16-variant) + retry routing port — Codex absorption extending ADR-0069 _(Accepted)_
- [ADR-0218](./decisions/0218-subagent-mode-typed-delegation.md) Mode-typed delegation (parent → child mode-typed handoff) _(Accepted)_
- [ADR-0219](./decisions/0219-focus-chain-auto-reinject.md) Focus Chain (automatic N-turn todo-list re-injection) _(Accepted)_
- [ADR-0220](./decisions/0220-git-directive-emit.md) Git directive emit protocol (`::git-*`) _(Accepted)_
- [ADR-0221](./decisions/0221-git-directive-emit-protocol.md) Git `::git-*` 5-directive emit protocol — phase-guarded behavioral layer _(Accepted)_
- [ADR-0222](./decisions/0222-otel-emit-new-slices.md) OTel emit unified across 5 new slices (fence-aware narrow ports) _(Accepted)_
- [ADR-0223](./decisions/0223-auto-background-stuck-detector.md) Auto-background after 2 s — stuck-detector + propose-handler _(Accepted)_
- [ADR-0224](./decisions/0224-cli-slash-web-paste.md) CLI `/web` + `/paste` (text-inbox absorption) _(Accepted)_
- [ADR-0225](./decisions/0225-cli-slash-mid-edit.md) CLI `/edit-plan` + `/edit-message` (mid-execution external editor) _(Accepted)_
- [ADR-0228](./decisions/0228-queued-followup-per-msg-mutators.md) Queued follow-up per-msg mutators (`retry` / `edit` / `delete` / `sendNow`) _(Accepted)_
- [ADR-0229](./decisions/0229-dispatch-guard-wiring.md) Dispatch Guard wiring — single port over 3 already-shipped detectors _(Accepted)_
- [ADR-0230](./decisions/0230-realtime-websocket-codex.md) Realtime WebSocket slice — 8 method surface (Codex absorption) _(Accepted)_
- [ADR-0231](./decisions/0231-radar-cards-proposal-queue.md) Radar cards — background proposal queue engine (MVP) _(Accepted)_
- [ADR-0232](./decisions/0232-git-directive-turn-collector-wire.md) Git directive turn-collector wire (phase-aware emit) _(Accepted)_
- [ADR-0233](./decisions/0233-stage1-phase2-consume-and-vendor-glob-wire.md) Stage1→Phase2 reuse-consume + vendor-detector ↔ glob-rules wire _(Partially superseded (2026-07-19))_
- [ADR-0235](./decisions/0235-shell-snapshot-runshell-wire.md) Per-turn shell-snapshot — runShell prefix wire (composition root) _(Accepted)_
- [ADR-0238](./decisions/0238-shell-snapshot-production-spawner-and-size-prune.md) Shell-snapshot — production Bun spawner, size-budget prune, CLI opt-in _(Accepted)_
- [ADR-0239](./decisions/0239-debug-tracer-decision-event.md) Debug tracer + `decision` event (developer mode for gate observability) _(Accepted)_
- [ADR-0240](./decisions/0240-loop-trio-integration-auto-bg-automation-identity.md) Loop trio integration — auto-background accept + automation engine tick + identity per-turn reminder _(Accepted)_
- [ADR-0241](./decisions/0241-playbook-auto-dispatch-and-git-directive-completion.md) Playbook auto-dispatch + Git directive completion (5 directive kinds wired) _(Accepted)_
- [ADR-0242](./decisions/0242-refusal-stop-reason-branching.md) Stop-reason 8-arm typed branching policy (Cursor 3.2.16) _(Accepted)_
- [ADR-0243](./decisions/0243-n-phase-hitl.md) N-phase HITL (plan-exit-flow 일반화, Cursor 흡수) _(Accepted)_
- [ADR-0246](./decisions/0246-bridge-attestation.md) Bridge Attestation — remote permission preflight + STS token _(Accepted)_
- [ADR-0247](./decisions/0247-agent-nickname-pool-role-enum.md) Codex agent nickname pool (39) + agent_role enum _(Accepted)_
- [ADR-0249](./decisions/0249-node-repl-persistent-kernel.md) Node REPL persistent kernel — Jupyter-style per-session node process _(Accepted)_
- [ADR-0250](./decisions/0250-inline-trigger-wiring.md) Inline-trigger wiring — Aider-style source-comment dispatch primitive _(Accepted)_
- [ADR-0251](./decisions/0251-streaming-boomerang.md) Streaming boomerang (parent ↔ child progressive consumption) _(Accepted)_
- [ADR-0252](./decisions/0252-template-literal-windsurf.md) Template-literal `{{ variable }}` expander — Windsurf workflow parity (sibling to ADR-0203 `!macro`) _(Accepted)_
- [ADR-0253](./decisions/0253-spec-to-test-gen-devin.md) Devin playbook spec → bun:test fixture auto-generation _(Accepted)_
- [ADR-0254](./decisions/0254-semantic-search-port.md) Semantic-search port — embedding-based retrieval seam (Cline-style) _(Accepted)_
- [ADR-0255](./decisions/0255-cross-subagent-todo-readback.md) Cross-subagent todo readback (Roo bidirectional extension) _(Accepted)_
- [ADR-0257](./decisions/0257-ai-attribution-tool.md) AI-attribution tool — training-data attribution search MVP _(Superseded (2026-06-04) — the `ai_attribution` tool was REMOVED.)_
- [ADR-0258](./decisions/0258-playbook-nesting.md) Playbook nesting — bounded recursive call chain with cycle detection _(Accepted)_
- [ADR-0259](./decisions/0259-plan-writeback-bidirectional.md) Plan-writeback — bidirectional skill ↔ plan sync _(Accepted)_
- [ADR-0260](./decisions/0260-lexical-search-bm25-ripgrep.md) LexicalSearch — BM25 + ripgrep pluggable retrieval engine _(Accepted)_
- [ADR-0261](./decisions/0261-pluggable-embedder-store-registry.md) Pluggable Embedder + VectorStore provider registry _(Accepted)_
- [ADR-0262](./decisions/0262-reranker-port.md) Reranker port — closed seam + Cohere/Voyage REST adapters + identity default _(Accepted)_
- [ADR-0263](./decisions/0263-embed-cache.md) EmbedCache — idempotent content-hash + model-tag embed cache _(Accepted)_
- [ADR-0264](./decisions/0264-embed-batcher.md) EmbedBatcher — 50ms window + single-flight dedupe + provider batch_size honoured _(Accepted)_
- [ADR-0265](./decisions/0265-search-pipeline-composer.md) SearchPipeline composer + 5 pre-built presets _(Accepted)_
- [ADR-0266](./decisions/0266-model-tag-versioning.md) ModelTag versioning — cache + index invalidation when the embedder model changes _(Accepted)_
- [ADR-0267](./decisions/0267-decision-emit-phase-2-wire.md) `decision` event emit — Phase 2 wire-up at the admissibility gate _(Accepted)_
- [ADR-0269](./decisions/0269-decision-emit-phase-3-wire.md) Decision emit Phase 3: cap / jail / budget gates _(Accepted (default-OFF))_
- [ADR-0272](./decisions/0272-pipeline-composition-root-wire.md) Pipeline composition-root wire — `assemblePipeline(env)` + `search_codebase` tool _(Accepted)_
- [ADR-0273](./decisions/0273-model-tag-auto-hook.md) ModelTag invalidator auto-hook — EmbedCache + VectorStore registrar seam _(Accepted)_
- [ADR-0274](./decisions/0274-budget-probe-ledger-wire.md) BudgetProbe — real wire from ADR-0138 budget-ledger to ADR-0265 budget-aware preset _(Accepted)_
- [ADR-0275](./decisions/0275-real-api-smoke-eval.md) Real-API smoke eval for retrieval — drift detection (eval tier, non-blocking) _(Accepted)_
- [ADR-0276](./decisions/0276-multimodal-embedding-mvp.md) Multi-modal embedding MVP — image + audio embedding port _(Accepted)_
- [ADR-0277](./decisions/0277-codebase-indexer.md) Codebase indexer slice _(Accepted)_
- [ADR-0278](./decisions/0278-search-codebase-auto-register.md) `search_codebase` tool + auto-register wire _(Accepted)_
- [ADR-0286](./decisions/0286-deferred-result-registry-production.md) Production `DeferredResultRegistry` — registry-managed deferred work _(Accepted)_
- [ADR-0287](./decisions/0287-async-tool-kind-poll-deferred.md) Async tool kind + `poll_deferred` — `defineToolAsync` + LLM probe _(Accepted)_
- [ADR-0299](./decisions/0299-cli-bootstrap-host-extraction.md) Host-bootstrap extraction — thin CLI / headless engine seam _(Accepted)_

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

- Total ADR files: 555
- Distinct ADR numbers: 524
- ADR collisions: 31
- Total slices: 43
- Hellgate test files referenced: 29

> Footer auto-emitted 2026-07-19. Re-run `bun tools/arch-gen/main.ts` to regenerate.
