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
  createLLM,
  createMulticloudLLM,
  DEFAULT_MODEL,
  MINTABLE_PROVIDERS,
  MissingApiKeyError,
  MULTICLOUD_AUTH_ENV_KEYS,
  MULTICLOUD_DEFAULT_MODEL,
  pickProvider,
  resolveVendorApiKey,
  tryCreateLLM,
} from "./factory"
export type { FallbackLLMOptions, FallbackMetricSink } from "./fallback"
export { FALLBACK_METRIC_NAMES, FallbackLLM, isFallbackTrigger } from "./fallback"
export type { LiveUsageKnobs } from "./live-usage"
export { estimateTokensFromChars, withLiveUsage } from "./live-usage"
export type { ModelCandidate, ModelSwapRetryOptions } from "./model-swap"
export {
  NoAlternateModelError,
  pickNextModel,
  resolveRetryModel,
  streamWithModel,
} from "./model-swap"
export type { LLMPort } from "./ports"
export {
  hasPrewarm,
  type LlmPrewarmPort,
  type PrewarmOutcome,
  prewarmLlm,
} from "./prewarm"
export type { ProviderEnv, ProviderId, ResolvedProvider } from "./providers"
export { PROVIDER_ENV_KEYS, resolveProvider } from "./providers"
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
  ToolChoice,
  ToolResultBlock,
  ToolSchema,
  ToolUseBlock,
} from "./types"
