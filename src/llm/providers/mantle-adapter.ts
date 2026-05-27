/**
 * ADR-0163 Phase B — `mantle` transport adapter (Anthropic Mantle enterprise endpoint). STUB.
 *
 * Phase 1 posture: Anthropic Mantle has no publicly-documented SDK or wire
 * spec as of 2026-05-24 — the name surfaces via the Claude CLI env switch
 * `CLAUDE_CODE_USE_MANTLE` and via internal docs only. Rather than fake the
 * grammar (which would silently lock us into a wire shape that may shift
 * before the official surface lands), we ship a typed stub identical in shape
 * to `FoundryProviderAdapter`: constructs cleanly, exposes the right
 * `providerId` for telemetry, and `stream()` immediately throws
 * {@link ProviderError} with code `provider-unsupported`.
 *
 * Constructor is intentionally permissive — accept the config so callers can
 * wire the slot in advance (Phase 2 fork drops in a real implementation with
 * zero call-site churn). Auth fields are NOT yet typed in {@link ProviderAuth}
 * (Mantle's credential model is internal); Phase 2 extends `ProviderAuth` with
 * `mantleToken?: string` and a `mantleEndpoint?: string` when the spec is
 * public.
 *
 * Plane-clean: imports the port + `@/llm` types only. No `@/agent`.
 *
 * Why a separate adapter rather than reusing FoundryProviderAdapter?
 * Telemetry parity. The router emits `providerId="mantle"` so dashboards can
 * distinguish Mantle traffic from Foundry traffic (different billing units,
 * different residency boundaries). A shared "throw-only stub" base class
 * would couple Phase 2 graduations — Mantle and Foundry will land on
 * different release schedules.
 */

import type { StreamEvent, StreamInput } from "../types"
import type { LlmProvider, ProviderConfig, ProviderId } from "./provider-port"
import { ProviderError } from "./provider-port"

export class MantleProviderAdapter implements LlmProvider {
  readonly providerId: ProviderId = "mantle"
  readonly provider = "anthropic"
  readonly surfaceId = "anthropic-messages"
  readonly transportId = "mantle"
  readonly authMode = "Anthropic Mantle"
  readonly model: string

  constructor(config: ProviderConfig) {
    if (config.providerId !== "mantle") {
      throw new ProviderError(
        "provider-misconfigured",
        `MantleProviderAdapter requires providerId="mantle", got "${config.providerId}"`,
        { providerId: config.providerId },
      )
    }
    this.model = config.model
  }

  // Phase 1 STUB always throws. The async-generator signature must remain to
  // satisfy LlmProvider; Phase 2 lands real yields when the Mantle spec is
  // public.
  // biome-ignore lint/correctness/useYield: Phase-1 throw-only stub; see file header.
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new ProviderError(
      "provider-unsupported",
      "Mantle adapter is Phase 2 — Anthropic Mantle has no public SDK as of 2026-05-24",
      { providerId: "mantle" },
    )
  }
}
