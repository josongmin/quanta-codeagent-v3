export { AnthropicAdapter } from "./adapters/anthropic"
export { OpenAIAdapter } from "./adapters/openai"
export { OpenAIResponsesAdapter } from "./adapters/openai-responses"
export type { AssembledTurn } from "./assemble"
export { assembleFromEvents, determinePhases, hasToolUse } from "./assemble"
export type {
  CloudKind,
  CredentialHelperErrorCode,
  CredentialSource,
  CredentialSourceOptions,
  ShellExecFn,
  ShellExecResult,
} from "./credential-helper"
// H7 — rotating cloud credentials. The executable CredentialSource port +
// its closed failure taxonomy are surfaced on the barrel so the composition
// root (`@/runner/assemble/llm.ts`) can build a trust-gated source from the
// H7 runtime-config knobs and inject it into `createMulticloudLLM`. The slice
// itself never imports `@/runtime` / `@/permission` — those (shell + trust)
// are dependency-injected by the composition root.
export {
  CredentialHelperError,
  createCredentialSource,
  DEFAULT_HELPER_TTL_MS,
} from "./credential-helper"
export type {
  CreateLLMOptions,
  CreateMulticloudOptions,
  EnvLike,
  MulticloudProviderId,
  Provider,
} from "./factory"
export {
  ADAPTIVE_THINKING_FAMILIES,
  createLLM,
  createMulticloudLLM,
  DEFAULT_MODEL,
  MINTABLE_PROVIDERS,
  MissingApiKeyError,
  MULTICLOUD_AUTH_ENV_KEYS,
  MULTICLOUD_DEFAULT_MODEL,
  normalizeModelFamily,
  pickProvider,
  resolveVendorApiKey,
  supportsAdaptiveThinking,
  tryCreateLLM,
} from "./factory"
export type { FallbackLLMOptions, FallbackMetricSink } from "./fallback"
export {
  DEFAULT_EMPTY_STREAM_BREAKER_K,
  EMPTY_STREAM_BREAKER_ERROR_MARKER,
  type EmptyStreamBreakerOpts,
  isStreamEventContentful,
  withEmptyStreamCircuitBreaker,
} from "./empty-stream-breaker"
export { FALLBACK_METRIC_NAMES, FallbackLLM, isFallbackTrigger } from "./fallback"
export {
  DEFAULT_STREAM_TRACE_INTERVAL_MS,
  type StreamProgressTraceOpts,
  type TraceTimer,
  withStreamProgressTrace,
} from "./stream-progress-trace"
export type { LiveUsageKnobs } from "./live-usage"
export { estimateTokensFromChars, withLiveUsage } from "./live-usage"
// §9.6 — Anthropic Message Batches API client core (default-OFF). Surfaced on
// the barrel so a composition root can build a client without a deep import;
// inert until a method is called (no request at import).
export type {
  BatchError,
  BatchProcessingStatus,
  BatchRequest,
  BatchRequestCounts,
  BatchResult,
  BatchResultEntry,
  CreateBatchInput,
  MessageBatch,
  MessageBatchesClient,
  MessageBatchesClientOpts,
} from "./message-batches"
export { createMessageBatchesClient } from "./message-batches"
// §9.6 — opusplan-style sticky model preset (default-OFF). Pure registry +
// resolver; importing changes no behaviour until a preset is selected by name.
export type { ModelPreset, SelectPresetResult, StickyPresetResolver } from "./model-preset"
export {
  BUILTIN_MODEL_PRESETS,
  createStickyPresetResolver,
  listModelPresets,
  PresetError,
  resolveModelForRole,
  resolveModelPreset,
} from "./model-preset"
export type { ModelCandidate, ModelSwapRetryOptions } from "./model-swap"
export {
  buildModelPinnedPort,
  NoAlternateModelError,
  pickNextModel,
  resolveRetryModel,
  streamWithModel,
} from "./model-swap"
export type { LLMPort } from "./ports"
// Repair-breadth fanout sampling — pure leaf (per-candidate temperature
// schedule, Agentless `repair.py` parity) + SOLID decorator that injects a
// per-port temperature into `StreamInput`. Inert until a seam wires them.
export {
  GREEDY,
  sampleTemperatureForCandidate,
  TEMPERATURE_SAMPLE,
} from "./sample-temperature"
export { laneLabeledPort } from "./with-recording-lane"
export { withTemperature } from "./with-temperature"
export {
  hasPrewarm,
  type LlmPrewarmPort,
  type PrewarmOutcome,
  prewarmLlm,
} from "./prewarm"
// D4 (jun-7 naive-impl hardening) — model→context-window SSOT. Pure leaf
// (imports only `provider-types`), so re-exporting through the barrel drags no
// SDK dependency; the compaction slice + the loop's usage-snapshot consume it.
export type { ModelWindow } from "./provider-metadata"
export {
  MODEL_CONTEXT_WINDOWS,
  modelSupportsSamplingTemperature,
  resolveModelWindow,
} from "./provider-metadata"
export type { ProviderEnv, ProviderId, ResolvedProvider } from "./providers"
export { isRefusalStopReason, PROVIDER_ENV_KEYS, resolveProvider } from "./providers"
export type {
  ResponsesContinuationEntry,
  ResponsesContinuationStore,
} from "./responses-continuation-store"
export { defaultResponsesContinuationStore } from "./responses-continuation-store"
export { responsesContinuationLlmPort } from "./responses-continuation-wrapping"
export type { RecoveryAction, RecoveryRouter } from "./retry"
export {
  CodexSpecRouter,
  codexSpecRoute,
  codexSpecRouterEmittedActions,
  createDefaultRecoveryRouter,
} from "./retry"
export type { DecodedProviderEvent, ParsedSseFrame } from "./streaming-events"
export {
  __resetUnknownEventRateLimitForTests,
  decodeSseEvent,
  decodeWsEvent,
  KNOWN_EVENT_KINDS,
  logUnknownEventRateLimited,
  parseSseFrame,
  splitSseFrames,
} from "./streaming-events"
export type {
  JsonSchema,
  JsonSchemaType,
  OpenAIResponseFormatParam,
  ResponseFormat,
  ResponseFormatError,
} from "./structured-output"
// ADR-0469 — structured output (response_format json_schema) passthrough.
// Surfaced on the @/llm barrel (mirrors @/patch surfacing applyPatchStructured)
// so the OpenAI-adapter passthrough + caller-side validation are reachable
// without a deep subpath import. Inert until a request carries `responseFormat`.
export {
  RESPONSE_FORMAT_ANTHROPIC_NOTE,
  toAnthropicForcedTool,
  toOpenAIResponseFormat,
  validateAgainstResponseSchema,
  validateResponseFormat,
} from "./structured-output"
export type {
  LlmCheckpoint,
  LlmSurfaceId,
  LlmTransportId,
  PromptCacheRetention,
  ResponsesCheckpoint,
  ResponsesContinuationMode,
  ResponsesContinuationObservation,
  ResponsesContinuationPhase,
  ResponsesContinuationReason,
} from "./target-metadata"
export type {
  ContentBlock,
  DocumentBlock,
  ImageBlock,
  Message,
  StreamEvent,
  StreamInput,
  SystemBlock,
  SystemPromptInput,
  TextBlock,
  ThinkingBlock,
  ThinkingConfig,
  ToolChoice,
  ToolResultBlock,
  ToolSchema,
  ToolUseBlock,
} from "./types"
