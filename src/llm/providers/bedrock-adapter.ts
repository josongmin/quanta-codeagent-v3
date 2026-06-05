/**
 * ADR-0139 — `bedrock` transport adapter (AWS Bedrock).  Phase 2: REAL stream.
 *
 * Anthropic ships a separate npm package (`@anthropic-ai/bedrock-sdk`) that
 * re-exports an `AnthropicBedrock` class with the same Messages API surface
 * as the public `Anthropic` client, but routed through Bedrock's signed-V4
 * endpoint. ADR-0151 graduates this adapter from typed-stub to real wire: when
 * the optional SDK is present we open `client.messages.create({stream:true})`
 * and translate the raw stream verbatim through the existing `mapRawEvent`
 * decoder shared with `@/llm/adapters/anthropic.ts` (single source of truth
 * for the Messages SSE grammar — Bedrock just substitutes the transport).
 *
 * Default-OFF: the legacy `@/llm/factory` path still wraps `Anthropic`
 * directly. Callers must explicitly choose `providerId="bedrock"` (env var
 * `ANTHROPIC_BEDROCK_BASE_URL` triggers the registry, or pass the id at the
 * resolver). The SDK is treated as OPTIONAL: a missing install still throws a
 * typed `provider-missing-dependency` instead of `MODULE_NOT_FOUND`.
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
import type { CredentialSource } from "../credential-helper"
import { withStreamTimeout } from "../stream-timeout"
import type { CacheTtl, StreamEvent, StreamInput } from "../types"
import type { LlmProvider, ProviderConfig, ProviderId } from "./provider-port"
import { ProviderError } from "./provider-port"

interface BedrockClientOptions {
  awsAccessKey?: string
  awsSecretKey?: string
  awsSessionToken?: string
  awsRegion?: string
}

/** Minimal structural view of `AnthropicBedrock` we depend on. Narrowed to the
 *  single method we call so the adapter survives SDK churn — same discipline
 *  as {@link RawEvent} in the public-API adapter. */
interface BedrockClientLike {
  messages: {
    create(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<RawEvent>>
  }
}

interface BedrockClientCtor {
  new (options: BedrockClientOptions): BedrockClientLike
}

interface BedrockSdkModule {
  AnthropicBedrock?: BedrockClientCtor
  default?: BedrockClientCtor
}

/** DI seam — tests inject a synthetic client (no network, no AWS creds).
 *  Production code leaves it absent so the lazy SDK import is the live path. */
export type BedrockClientFactory = (options: BedrockClientOptions) => BedrockClientLike

export interface BedrockAdapterOptions {
  /** Test-only DI seam. When supplied, the lazy SDK import is bypassed and the
   *  given factory is invoked instead. Production callers omit this. */
  clientFactory?: BedrockClientFactory
  /** H7 — OPTIONAL pre-call credential refresh hook. When supplied, the adapter
   *  awaits `credentialSource.refreshCloudCreds("aws")` BEFORE building/using
   *  the SDK client on each `stream()`, so the AWS default credential chain
   *  picks up freshly-rotated SSO/STS creds (the refresh is TTL-throttled inside
   *  the source — a hot loop does not re-shell every call). ABSENT ⇒ the adapter
   *  path is byte-identical to the pre-H7 SDK-default-chain behavior. */
  credentialSource?: CredentialSource
}

export class BedrockProviderAdapter implements LlmProvider {
  readonly providerId: ProviderId = "bedrock"
  readonly provider = "anthropic"
  readonly surfaceId = "anthropic-messages"
  readonly transportId = "bedrock"
  readonly authMode = "AWS Bedrock"
  readonly model: string
  private readonly clientOptions: BedrockClientOptions
  private readonly maxTokens: number
  private readonly cacheTtl: CacheTtl
  private readonly streamTimeoutMs: { firstChunkMs: number; idleMs: number }
  private readonly clientFactory: BedrockClientFactory | undefined
  private readonly credentialSource: CredentialSource | undefined

  constructor(config: ProviderConfig, options: BedrockAdapterOptions = {}) {
    if (config.providerId !== "bedrock") {
      throw new ProviderError(
        "provider-misconfigured",
        `BedrockProviderAdapter requires providerId="bedrock", got "${config.providerId}"`,
        { providerId: config.providerId },
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
    // Static AWS credentials are OPTIONAL — when all four fields are absent
    // the underlying SDK falls back to the default credential chain (env
    // vars, EC2 IMDS, ECS IRSA, SSO profile, …). Forwarding a field only
    // when explicitly supplied keeps exactOptional honest.
    const opts: BedrockClientOptions = {}
    if (config.auth.awsAccessKeyId !== undefined) opts.awsAccessKey = config.auth.awsAccessKeyId
    if (config.auth.awsSecretAccessKey !== undefined)
      opts.awsSecretKey = config.auth.awsSecretAccessKey
    if (config.auth.awsSessionToken !== undefined)
      opts.awsSessionToken = config.auth.awsSessionToken
    if (config.auth.awsRegion !== undefined) opts.awsRegion = config.auth.awsRegion
    this.clientOptions = opts
    if (options.clientFactory !== undefined) this.clientFactory = options.clientFactory
    if (options.credentialSource !== undefined) this.credentialSource = options.credentialSource
  }

  /** Lazy SDK resolve. Dynamic import keeps the package OPTIONAL — the main
   *  install ships only `@anthropic-ai/sdk`, and this adapter degrades to a
   *  typed `provider-missing-dependency` when the Bedrock sub-SDK is absent.
   *  Awaited inside `stream()` so the cost is paid on first use, not at
   *  module load. */
  private async resolveClient(): Promise<BedrockClientLike> {
    if (this.clientFactory !== undefined) return this.clientFactory(this.clientOptions)
    let mod: BedrockSdkModule
    try {
      // Two-step cast (`as unknown as`) — the SDK's exported `messages.create`
      // signature is far richer than our narrowed `BedrockClientLike` view, so
      // TS rejects the direct narrow as "neither type sufficiently overlaps".
      // Going via `unknown` documents the intentional surface narrowing.
      mod = (await import("@anthropic-ai/bedrock-sdk")) as unknown as BedrockSdkModule
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
    try {
      return new Ctor(this.clientOptions)
    } catch (e) {
      // Construction itself can throw on bad credentials shape — surface as
      // typed misconfigured rather than leak the SDK-internal error.
      throw new ProviderError(
        "provider-misconfigured",
        `Bedrock client construction failed (auth-failed): ${errMessage(e)}`,
        { cause: e, providerId: "bedrock" },
      )
    }
  }

  /** Open the underlying Bedrock messages stream. Mirrors `anthropic.ts`'s
   *  `openRawStream` — same request shape, same toolChoice resolution, same
   *  LLMError translation — except the transport is Bedrock-signed. */
  private async openRawStream(
    client: BedrockClientLike,
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
      // ProviderError (e.g. from a DI factory that wants to surface "missing
      // dependency" eagerly) MUST pass through untouched so the loop's
      // classifier can branch on `.code`. Everything else is a wire error.
      if (e instanceof ProviderError) throw e
      throw LLMError.fromSdkError("anthropic", e)
    }
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    // H7 — pre-call credential refresh. Absent source ⇒ this awaits nothing and
    // the client-resolve path is byte-identical to the pre-H7 default chain.
    // The refresh is TTL-throttled inside the source; a failing (trust-gated /
    // helper-failed) refresh surfaces as a typed CredentialHelperError before
    // any wire call, which the loop classifier treats like any pre-stream error.
    if (this.credentialSource !== undefined) {
      await this.credentialSource.refreshCloudCreds("aws")
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
    try {
      for await (const ev of guarded) {
        yield* mapRawEvent(ev, open, { model: this.model })
      }
    } catch (e) {
      if (e instanceof ProviderError) throw e
      throw LLMError.fromSdkError("anthropic", e, "Bedrock stream error")
    }
  }
}
