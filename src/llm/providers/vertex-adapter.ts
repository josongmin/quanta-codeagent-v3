/**
 * ADR-0139 — `vertex` transport adapter (Google Cloud Vertex AI). Phase 2: REAL.
 *
 * Anthropic ships `@anthropic-ai/vertex-sdk` exporting `AnthropicVertex`, the
 * Vertex-routed sibling of the public `Anthropic` client. Wire grammar is
 * identical; the difference is the URL path
 * (`projects/{gcpProjectId}/locations/{gcpLocation}/...`) and the auth source
 * (Google bearer token instead of `x-api-key`). ADR-0151 graduates this
 * adapter from typed-stub to real wire: on first `stream()` call we lazy-load
 * the SDK, construct an `AnthropicVertex` client, open
 * `client.messages.create({stream:true})`, and decode the raw stream through
 * the shared `mapRawEvent` (same SSE grammar — Vertex just substitutes the
 * transport).
 *
 * Vertex requires BOTH `gcpProjectId` AND `gcpLocation` to synthesize the URL;
 * either missing ⇒ `auth-failed` (`provider-misconfigured`) at construction
 * time so the typed-fail surfaces at factory wiring, not at first wire call.
 *
 * GCP auth precedence (lowest → highest):
 *   1. ADC — `GOOGLE_APPLICATION_CREDENTIALS` or workload identity (SDK
 *      resolves via `google-auth-library` when no token is supplied).
 *   2. Explicit `gcpAccessToken` in `ProviderAuth` (wins over ADC).
 *
 * Plane-clean: imports the port + `@/llm` siblings only. No `@/agent`.
 */

import { errMessage, LLMError } from "@/shared/errors"
import {
  buildAnthropicMessagesRequest,
  mapRawEvent,
  type OpenSlots,
  type RawEvent,
} from "../adapters/anthropic"
import { resolveAdapterStreamTimeouts } from "../adapters/shared"
import { withStreamTimeout } from "../stream-timeout"
import type { StreamEvent, StreamInput } from "../types"
import type { LlmProvider, ProviderConfig, ProviderId } from "./provider-port"
import { ProviderError } from "./provider-port"

interface VertexClientOptions {
  projectId: string
  region: string
  accessToken?: string
}

interface VertexClientLike {
  messages: {
    create(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<RawEvent>>
  }
}

interface VertexClientCtor {
  new (options: VertexClientOptions): VertexClientLike
}

interface VertexSdkModule {
  AnthropicVertex?: VertexClientCtor
  default?: VertexClientCtor
}

/** DI seam — tests inject a synthetic client. Same discipline as Bedrock. */
export type VertexClientFactory = (options: VertexClientOptions) => VertexClientLike

export interface VertexAdapterOptions {
  clientFactory?: VertexClientFactory
}

export class VertexProviderAdapter implements LlmProvider {
  readonly providerId: ProviderId = "vertex"
  readonly provider = "anthropic"
  readonly surfaceId = "anthropic-messages"
  readonly transportId = "vertex"
  readonly authMode = "GCP Vertex"
  readonly model: string
  private readonly clientOptions: VertexClientOptions
  private readonly maxTokens: number
  private readonly streamTimeoutMs: { firstChunkMs: number; idleMs: number }
  private readonly clientFactory: VertexClientFactory | undefined

  constructor(config: ProviderConfig, options: VertexAdapterOptions = {}) {
    if (config.providerId !== "vertex") {
      throw new ProviderError(
        "provider-misconfigured",
        `VertexProviderAdapter requires providerId="vertex", got "${config.providerId}"`,
        { providerId: config.providerId },
      )
    }
    // Vertex URL synthesis needs BOTH fields. Missing either is a typed
    // `auth-failed` (modeled here as `provider-misconfigured` — the closed
    // ProviderErrorCode union does not have a separate `auth-failed` arm,
    // and "config field absent" is exactly what misconfigured means).
    const projectId = config.auth.gcpProjectId
    const location = config.auth.gcpLocation
    if (projectId === undefined || projectId.length === 0) {
      throw new ProviderError(
        "provider-misconfigured",
        "vertex transport requires auth.gcpProjectId (auth-failed)",
        { providerId: "vertex" },
      )
    }
    if (location === undefined || location.length === 0) {
      throw new ProviderError(
        "provider-misconfigured",
        "vertex transport requires auth.gcpLocation (auth-failed)",
        { providerId: "vertex" },
      )
    }
    this.model = config.model
    this.maxTokens = config.maxTokens ?? 8192
    this.streamTimeoutMs = resolveAdapterStreamTimeouts({
      ...(config.streamFirstChunkMs !== undefined
        ? { streamFirstChunkMs: config.streamFirstChunkMs }
        : {}),
      ...(config.streamIdleMs !== undefined ? { streamIdleMs: config.streamIdleMs } : {}),
    })
    const opts: VertexClientOptions = { projectId, region: location }
    if (config.auth.gcpAccessToken !== undefined) opts.accessToken = config.auth.gcpAccessToken
    this.clientOptions = opts
    if (options.clientFactory !== undefined) this.clientFactory = options.clientFactory
  }

  /** Lazy SDK resolve — same discipline as `BedrockProviderAdapter`. */
  private async resolveClient(): Promise<VertexClientLike> {
    if (this.clientFactory !== undefined) return this.clientFactory(this.clientOptions)
    let mod: VertexSdkModule
    try {
      // Two-step cast — same rationale as the Bedrock adapter.
      mod = (await import("@anthropic-ai/vertex-sdk")) as unknown as VertexSdkModule
    } catch (cause) {
      throw new ProviderError(
        "provider-missing-dependency",
        "GCP Vertex transport requires @anthropic-ai/vertex-sdk — install it to enable",
        { cause, providerId: "vertex" },
      )
    }
    const Ctor = mod.AnthropicVertex ?? mod.default
    if (Ctor === undefined) {
      throw new ProviderError(
        "provider-missing-dependency",
        "@anthropic-ai/vertex-sdk did not export AnthropicVertex",
        { providerId: "vertex" },
      )
    }
    try {
      return new Ctor(this.clientOptions)
    } catch (e) {
      throw new ProviderError(
        "provider-misconfigured",
        `Vertex client construction failed (auth-failed): ${errMessage(e)}`,
        { cause: e, providerId: "vertex" },
      )
    }
  }

  private async openRawStream(
    client: VertexClientLike,
    input: StreamInput,
  ): Promise<AsyncIterable<RawEvent>> {
    try {
      return await client.messages.create(
        buildAnthropicMessagesRequest(this.model, this.maxTokens, input) as unknown as Record<
          string,
          unknown
        >,
        input.signal ? { signal: input.signal } : undefined,
      )
    } catch (e) {
      if (e instanceof ProviderError) throw e
      throw LLMError.fromSdkError("anthropic", e)
    }
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const client = await this.resolveClient()
    const raw = await this.openRawStream(client, input)
    const guarded = withStreamTimeout(raw, {
      firstChunkMs: this.streamTimeoutMs.firstChunkMs,
      idleMs: this.streamTimeoutMs.idleMs,
      provider: "anthropic",
      ...(input.signal ? { signal: input.signal } : {}),
      // ADR-0234: spinner-stall tick hook (best-effort, exactOptional honest).
      // Absent ⇒ omitted on the wrapper opts (byte-identical to pre-feature).
      ...(input.onChunk ? { onChunk: input.onChunk } : {}),
    })
    const open: OpenSlots = new Map()
    try {
      for await (const ev of guarded) {
        yield* mapRawEvent(ev, open, { model: this.model })
      }
    } catch (e) {
      if (e instanceof ProviderError) throw e
      throw LLMError.fromSdkError("anthropic", e, "Vertex stream error")
    }
  }
}
