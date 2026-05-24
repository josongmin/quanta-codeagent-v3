/**
 * ADR-0139 — `@/llm/providers` barrel. Re-exports the port surface + four
 * adapters + the registry. Default-OFF posture: nothing here is wired into
 * the legacy `@/llm/factory` path — opt-in callers import `resolveProvider`
 * and pass the resulting `factory(config)` themselves.
 */

export { BedrockProviderAdapter } from "./bedrock-adapter"
export { DefaultProviderAdapter } from "./default-adapter"
export { FoundryProviderAdapter } from "./foundry-adapter"
export type {
  LlmProvider,
  ProviderAuth,
  ProviderConfig,
  ProviderErrorCode,
  ProviderFactory,
  ProviderId,
  StreamEvent,
  StreamInput,
} from "./provider-port"
export { ProviderError } from "./provider-port"
export type { ProviderEnv, ResolvedProvider } from "./registry"
export { PROVIDER_ENV_KEYS, resolveProvider } from "./registry"
export { VertexProviderAdapter } from "./vertex-adapter"
