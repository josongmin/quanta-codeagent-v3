/**
 * ADR-0139 — `default` transport adapter. Wraps the public
 * `api.anthropic.com` path via the SDK's `Anthropic` class.
 *
 * Implementation is delegation to the battle-tested {@link AnthropicAdapter}
 * (which already handles thinking carry-over, prompt-prefix caching, image /
 * document blocks, tool_choice mapping, stream-hang guards, and SDK-shape-
 * drift exhaustiveness pins). The port wrap exists ONLY to satisfy the
 * {@link LlmProvider} surface — every adapter in this slice must answer
 * `providerId`, and the legacy `AnthropicAdapter` does not (it predates
 * ADR-0139). Re-implementing the streaming logic here would duplicate ~500
 * lines and is forbidden by the absorption rule "do not modify
 * src/llm/adapters/*".
 *
 * Plane-clean: imports `@anthropic-ai/sdk` (allowed for adapters) and the
 * sibling adapter (sideways within `@/llm`). No `@/agent`, no `@/permission`,
 * no `@/tool`.
 */

import { AnthropicAdapter } from "../adapters/anthropic"
import type { StreamEvent, StreamInput } from "../types"
import type { LlmProvider, ProviderConfig, ProviderId } from "./provider-port"
import { ProviderError } from "./provider-port"

export class DefaultProviderAdapter implements LlmProvider {
  readonly providerId: ProviderId = "default"
  readonly provider = "anthropic"
  readonly authMode = "Anthropic BYOK"
  readonly model: string
  private readonly inner: AnthropicAdapter

  constructor(config: ProviderConfig) {
    if (config.providerId !== "default") {
      // Defense in depth — the registry routes by `providerId`, so a mismatch
      // is a programmer bug, not a user error. Throw a typed
      // `provider-misconfigured` so the loop's classifier never has to guess.
      throw new ProviderError(
        "provider-misconfigured",
        `DefaultProviderAdapter requires providerId="default", got "${config.providerId}"`,
        { providerId: config.providerId },
      )
    }
    if (config.auth.apiKey === undefined || config.auth.apiKey.length === 0) {
      throw new ProviderError(
        "provider-misconfigured",
        "default transport requires auth.apiKey (ANTHROPIC_API_KEY)",
        { providerId: "default" },
      )
    }
    this.model = config.model
    this.inner = new AnthropicAdapter({
      apiKey: config.auth.apiKey,
      model: config.model,
      ...(config.betaHeaders !== undefined ? { betaHeaders: config.betaHeaders } : {}),
      ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
      ...(config.streamFirstChunkMs !== undefined
        ? { streamFirstChunkMs: config.streamFirstChunkMs }
        : {}),
      ...(config.streamIdleMs !== undefined ? { streamIdleMs: config.streamIdleMs } : {}),
    })
  }

  stream(input: StreamInput): AsyncIterable<StreamEvent> {
    return this.inner.stream(input)
  }
}
