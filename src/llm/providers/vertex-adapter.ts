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
  type UsageAccumulator,
} from "../adapters/anthropic"
import { resolveAdapterStreamTimeouts } from "../adapters/shared"
import type { CredentialSource } from "../credential-helper"
import { withStreamTimeout } from "../stream-timeout"
import type { CacheTtl, StreamEvent, StreamInput } from "../types"
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
  /** H7 — OPTIONAL pre-call credential refresh hook. When supplied, the adapter
   *  awaits `credentialSource.refreshCloudCreds("gcp")` BEFORE building/using the
   *  SDK client on each `stream()`, so ADC picks up freshly-rotated GCP creds
   *  (TTL-throttled inside the source). ABSENT ⇒ byte-identical to the pre-H7
   *  ADC path. */
  credentialSource?: CredentialSource
  /** jun-6 per-model region routing — OPTIONAL `modelSlug → region` map. When a
   *  supplied map has an EXACT entry for `config.model`, that region replaces
   *  the single `auth.gcpLocation` for this adapter; otherwise the mandatory
   *  `gcpLocation` fallback is used (and the construction guard requiring
   *  `gcpLocation` is NOT weakened — the map is an override, never a substitute
   *  for the fallback). Lookup is by exact key against the wire model slug; the
   *  composition root owns env derivation (`VERTEX_REGION_<MODEL>`) and any slug
   *  normalization, so the adapter never reads `process.env`. ABSENT / empty ⇒
   *  byte-identical single-region behavior. */
  vertexRegionByModel?: Readonly<Record<string, string>>
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
  private readonly cacheTtl: CacheTtl
  private readonly streamTimeoutMs: { firstChunkMs: number; idleMs: number }
  private readonly clientFactory: VertexClientFactory | undefined
  private readonly credentialSource: CredentialSource | undefined

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
    this.cacheTtl = config.cacheTtl ?? "5m"
    this.streamTimeoutMs = resolveAdapterStreamTimeouts({
      ...(config.streamFirstChunkMs !== undefined
        ? { streamFirstChunkMs: config.streamFirstChunkMs }
        : {}),
      ...(config.streamIdleMs !== undefined ? { streamIdleMs: config.streamIdleMs } : {}),
    })
    // jun-6 per-model region routing: an EXACT map entry for this model wins
    // over the single `gcpLocation`; absent/empty ⇒ `location` (byte-identical
    // to the single-region path). `location` is guaranteed non-empty by the
    // guard above, so the `??` fallback is always a valid region.
    const region = options.vertexRegionByModel?.[config.model] ?? location
    const opts: VertexClientOptions = { projectId, region }
    if (config.auth.gcpAccessToken !== undefined) opts.accessToken = config.auth.gcpAccessToken
    this.clientOptions = opts
    if (options.clientFactory !== undefined) this.clientFactory = options.clientFactory
    if (options.credentialSource !== undefined) this.credentialSource = options.credentialSource
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
        buildAnthropicMessagesRequest(
          this.model,
          this.maxTokens,
          input,
          this.cacheTtl,
        ) as unknown as Record<string, unknown>,
        input.signal ? { signal: input.signal } : undefined,
      )
    } catch (e) {
      if (e instanceof ProviderError) throw e
      throw LLMError.fromSdkError("anthropic", e)
    }
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    // H7 — pre-call credential refresh (gcp). Absent source ⇒ byte-identical to
    // the pre-H7 ADC path. TTL-throttled inside the source; a failing refresh
    // surfaces as a typed CredentialHelperError before the wire call.
    if (this.credentialSource !== undefined) {
      await this.credentialSource.refreshCloudCreds("gcp")
    }
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
    // ONE accumulator per stream (mirrors anthropic.ts): `message_start`
    // absorbs input/cache counts that the terminal `message_delta` reads back.
    const usage: UsageAccumulator = { model: this.model }
    try {
      for await (const ev of guarded) {
        yield* mapRawEvent(ev, open, usage)
      }
    } catch (e) {
      if (e instanceof ProviderError) throw e
      throw LLMError.fromSdkError("anthropic", e, "Vertex stream error")
    }
  }
}
