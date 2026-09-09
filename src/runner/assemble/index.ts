/**
 * `@/runner/assemble` — surface-agnostic factories that turn plain typed
 * config into built collaborators (LLM, Store, Memory, …) for the agent loop.
 *
 * SLICE INVARIANT: NONE of these read `process.env` / `process.argv`. The
 * surface entry (CLI/Web/Tauri) maps its own input source (ENV / HTTP / IPC)
 * to the typed input first, then calls the factory. This is what lets the
 * same builders back a future Web/Tauri front end without a fork.
 *
 * See also the biome rule on `src/runner/**` — `apps/**` imports are forbidden,
 * and so are `@/rules` / `@/patch` / `@/migration` (they reach this slice via
 * `@/agent`).
 */

export type { ResolvedEndpoint } from "@/llm/endpoint-transport"
export {
  buildCompactionBreakerConfigCore,
  buildSummarizerLlmCore,
  type CompactionBreakerAssembleInput,
  type SummarizerLlmAssembleInput,
} from "./compaction"
export { compactionDep } from "./config"
export { parseEnvFlag } from "./env-flag"
export { wireInteractiveKnobs } from "./interactive-knobs"
export {
  buildCredentialSource,
  buildLLMCore,
  buildLLMWithByokCore,
  buildMainLLMCore,
  buildMulticloudLLMCore,
  type ComposeLlmInput,
  type CredentialSourceInput,
  composeLLMCore,
  DEFAULT_MODEL,
  decorateSwappableModelPort,
  type EnvLike,
  type LlmAssembleInput,
  type LlmTransportSelection,
  type MainLlmAssembleInput,
  type MulticloudAssembleInput,
  type PickProviderInput,
  type Provider,
  parseFallbackModels,
  pickProviderCore,
  type ResolveConfiguredEndpointInput,
  resolveConfiguredEndpoint,
  type SelectTransportInput,
  selectLlmTransport,
} from "./llm"
export {
  formatLlmTransportProjection,
  type LlmTransportProjection,
  type LlmTransportReason,
  type ProjectLlmTransportInput,
  projectLlmTransport,
} from "./llm/transport-projection"
export {
  buildMemoryConfigCore,
  type MemoryConfigAssembleInput,
  parseRecallTiers,
} from "./memory"
export {
  buildMemoryForSession,
  type MemorySessionOverride,
  type MemorySessionSlot,
  resolveMemoryConfigFromEnv,
} from "./memory-factory"
export {
  assemblePipeline,
  type PipelinePreset,
  type PipelineWireOverrides,
} from "./pipeline"
export {
  buildSemanticBackend,
  type ChunkUpsertPort,
  hashEmbed,
  type IndexEmbed,
  isPersistOn,
  type SemanticBackend,
  type SemanticBackendState,
  selectIndexEmbedder,
} from "./search-index-backend"
export {
  buildSearchPipelineFromEnv,
  clearSearchPipelineWireForTests,
  type WiredSearchPipeline,
} from "./search-pipeline"
export {
  type CreateSystemPromptRebuilderArgs,
  createIdentityModeSessionState,
  createSystemPromptRebuilder,
  createSystemSource,
  createToolProfileSessionState,
  type IdentityModeSessionState,
  // RFC-05 E3 — the mode STATE-CELL factory is retired; this is now the
  // delegating-adapter contract (re-exported from `session-state`, which
  // re-exports it from the E3 posture builder).
  type PermissionModeSessionState,
  SYSTEM_PROMPT_REBUILD_FALLBACK_PREFIX,
  type SystemPromptRebuilderPort,
  type SystemSource,
  type ToolProfileSessionState,
} from "./session-state"
export {
  buildSkillsConfigCore,
  type SkillsConfigAssembleInput,
} from "./skill"
export {
  buildEmbedderCore,
  buildStoreCore,
  type EmbedderAssembleInput,
  type StoreAssembleInput,
} from "./store"
export {
  buildStreamingCore,
  type StreamingAssembleInput,
  type StreamingResult,
} from "./streaming"
export {
  buildSubagentConfigCore,
  type SubagentConfigAssembleInput,
} from "./subagent"
export {
  buildToolingCore,
  type Tooling,
  type ToolingAssembleInput,
} from "./tooling"
export {
  buildVerifyGuardConfigCore,
  type VerifyGuardConfigAssembleInput,
} from "./verify"
