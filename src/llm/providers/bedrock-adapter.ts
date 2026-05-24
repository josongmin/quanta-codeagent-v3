/**
 * ADR-0139 — `bedrock` transport adapter (AWS Bedrock).
 *
 * Anthropic ships a separate npm package (`@anthropic-ai/bedrock-sdk`) that
 * re-exports an `AnthropicBedrock` class with the same Messages API surface
 * as the public `Anthropic` client, but routed through Bedrock's signed-V4
 * endpoint. The package is NOT a transitive dep of `@anthropic-ai/sdk` —
 * enterprise installs add it explicitly.
 *
 * Phase 1 posture (this file): the adapter constructs FINE without the
 * Bedrock SDK present, but `stream()` throws {@link ProviderError} with code
 * `provider-missing-dependency` so the caller gets a clear "install
 * @anthropic-ai/bedrock-sdk" message rather than a cryptic `MODULE_NOT_FOUND`.
 * When the SDK is installed (Phase 2 work or downstream-fork) the dynamic
 * import resolves and the adapter delegates verbatim — wire shape identical
 * to the `default` adapter (same JSON, different transport).
 *
 * Plane-clean: imports the port + `@/llm` types only. No `@/agent`.
 */

import type { StreamEvent, StreamInput } from "../types"
import type { LlmProvider, ProviderConfig, ProviderId } from "./provider-port"
import { ProviderError } from "./provider-port"

interface BedrockClientOptions {
  awsAccessKey?: string
  awsSecretKey?: string
  awsSessionToken?: string
  awsRegion?: string
}

interface BedrockClientLike {
  messages: {
    create(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>
  }
}

interface BedrockClientCtor {
  new (options: BedrockClientOptions): BedrockClientLike
}

interface BedrockSdkModule {
  AnthropicBedrock?: BedrockClientCtor
  default?: BedrockClientCtor
}

export class BedrockProviderAdapter implements LlmProvider {
  readonly providerId: ProviderId = "bedrock"
  readonly provider = "anthropic"
  readonly authMode = "AWS Bedrock"
  readonly model: string
  private readonly clientOptions: BedrockClientOptions

  constructor(config: ProviderConfig) {
    if (config.providerId !== "bedrock") {
      throw new ProviderError(
        "provider-misconfigured",
        `BedrockProviderAdapter requires providerId="bedrock", got "${config.providerId}"`,
        { providerId: config.providerId },
      )
    }
    this.model = config.model
    // Static AWS credentials are OPTIONAL — when all four fields are absent
    // the underlying SDK falls back to the default credential chain (env
    // vars, EC2 IMDS, ECS IRSA, SSO profile, …). Forwarding `undefined`
    // explicitly is fine because the SDK treats it as "use the default".
    const opts: BedrockClientOptions = {}
    if (config.auth.awsAccessKeyId !== undefined) opts.awsAccessKey = config.auth.awsAccessKeyId
    if (config.auth.awsSecretAccessKey !== undefined)
      opts.awsSecretKey = config.auth.awsSecretAccessKey
    if (config.auth.awsSessionToken !== undefined)
      opts.awsSessionToken = config.auth.awsSessionToken
    if (config.auth.awsRegion !== undefined) opts.awsRegion = config.auth.awsRegion
    this.clientOptions = opts
  }

  /** Lazy SDK resolve. Dynamic import keeps the package OPTIONAL — the main
   *  install ships only `@anthropic-ai/sdk`, and this adapter degrades to a
   *  typed `provider-missing-dependency` when the Bedrock sub-SDK is absent.
   *  Awaited inside `stream()` so the cost is paid on first use, not at
   *  module load. */
  private async resolveClient(): Promise<BedrockClientLike> {
    let mod: BedrockSdkModule
    try {
      mod = (await import("@anthropic-ai/bedrock-sdk")) as BedrockSdkModule
    } catch (cause) {
      throw new ProviderError(
        "provider-missing-dependency",
        "AWS Bedrock transport requires @anthropic-ai/bedrock-sdk — install it to enable",
        { cause, providerId: "bedrock" },
      )
    }
    const Ctor = mod.AnthropicBedrock ?? mod.default
    if (Ctor === undefined) {
      throw new ProviderError(
        "provider-missing-dependency",
        "@anthropic-ai/bedrock-sdk did not export AnthropicBedrock",
        { providerId: "bedrock" },
      )
    }
    return new Ctor(this.clientOptions)
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    // Resolve the client lazily; throws ProviderError if the SDK is missing.
    // Phase 2 work: wire `input` → Bedrock messages.create and re-decode the
    // raw events through the existing `mapRawEvent` (same SSE shape as the
    // public Anthropic transport). For Phase 1 we surface the dependency
    // error eagerly so callers get a clear actionable message rather than a
    // half-streamed silence.
    await this.resolveClient()
    // Reachable only when the SDK is present — Phase 2 wiring lives here.
    throw new ProviderError(
      "provider-unsupported",
      "Bedrock stream() wiring is Phase 2 — adapter constructed but not yet wired",
      { providerId: "bedrock" },
    )
    // biome-ignore lint/correctness/useYield: ProviderError is thrown above; the
    // async-generator signature must remain to satisfy LlmProvider — the
    // yield is unreachable but the function-shape requirement is satisfied
    // by the throw, not by an actual yield. (Removing the empty body would
    // make this a regular async function and break the AsyncIterable
    // contract.)
    if (input) return
  }
}
