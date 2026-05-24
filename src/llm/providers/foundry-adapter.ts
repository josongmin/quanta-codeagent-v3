/**
 * ADR-0139 — `foundry` transport adapter (Microsoft Azure AI Foundry). STUB.
 *
 * Phase 1 posture: Azure AI Foundry has no first-party
 * `@anthropic-ai/foundry-sdk` shipping today. Rather than fake it with raw
 * `fetch` (which would silently lock us into a wire shape that may shift
 * before the official SDK lands), we ship a typed stub: the adapter
 * constructs cleanly, exposes the right `providerId` for telemetry, and
 * `stream()` immediately throws {@link ProviderError} with code
 * `provider-unsupported`.
 *
 * Constructor is intentionally permissive — accept the config so callers can
 * wire the slot in advance (Phase 2 fork drops in a real implementation
 * with zero call-site churn). The auth fields (`azureEndpoint`, `azureApiKey`)
 * are already typed in {@link ProviderAuth} so Phase 2 is a pure adapter swap.
 *
 * Plane-clean: imports the port + `@/llm` types only. No `@/agent`.
 */

import type { StreamEvent, StreamInput } from "../types"
import type { LlmProvider, ProviderConfig, ProviderId } from "./provider-port"
import { ProviderError } from "./provider-port"

export class FoundryProviderAdapter implements LlmProvider {
  readonly providerId: ProviderId = "foundry"
  readonly provider = "anthropic"
  readonly authMode = "Azure AI Foundry"
  readonly model: string

  constructor(config: ProviderConfig) {
    if (config.providerId !== "foundry") {
      throw new ProviderError(
        "provider-misconfigured",
        `FoundryProviderAdapter requires providerId="foundry", got "${config.providerId}"`,
        { providerId: config.providerId },
      )
    }
    this.model = config.model
  }

  // Phase 1 STUB always throws. The async-generator signature must remain to
  // satisfy LlmProvider; Phase 2 lands real yields when official SDK ships.
  // biome-ignore lint/correctness/useYield: Phase-1 throw-only stub; see comment above.
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new ProviderError("provider-unsupported", "Foundry adapter is Phase 2", {
      providerId: "foundry",
    })
  }
}
