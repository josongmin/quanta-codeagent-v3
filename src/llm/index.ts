export { AnthropicAdapter } from "./adapters/anthropic"
export { OpenAIAdapter } from "./adapters/openai"
export { OpenAIResponsesAdapter } from "./adapters/openai-responses"
export type { AssembledTurn } from "./assemble"
export { assembleFromEvents, determinePhases, hasToolUse } from "./assemble"
export type { CreateLLMOptions, EnvLike, Provider } from "./factory"
export {
  createLLM,
  DEFAULT_MODEL,
  MissingApiKeyError,
  pickProvider,
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
