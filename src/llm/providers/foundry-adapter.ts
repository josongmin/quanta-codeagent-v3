/**
 * ADR-0172 — `foundry` transport adapter (Microsoft Azure AI Foundry). REAL stream.
 *
 * Supersedes the ADR-0163 typed-stub. Anthropic published
 * `@anthropic-ai/foundry-sdk@0.2.3` on 2025-11-18; the SDK re-exports an
 * `AnthropicFoundry` class that extends the public `Anthropic` client with two
 * Azure-specific concerns: (1) URL synthesis from a `resource` name into
 * `https://{resource}.services.ai.azure.com/anthropic/v1/messages`, and (2)
 * `azureADTokenProvider` — a caller-supplied async function the SDK invokes on
 * every request to mint a fresh Microsoft Entra (formerly AAD) bearer. Wire
 * grammar is identical to the public Anthropic API; the difference is the
 * transport + auth source.
 *
 * Default-OFF posture: the legacy `@/llm/factory` path keeps wrapping
 * `Anthropic` directly. This adapter is reached ONLY when the caller resolves
 * `providerId="foundry"` via the registry (env-driven by
 * `ANTHROPIC_FOUNDRY_BASE_URL` / `ANTHROPIC_FOUNDRY_RESOURCE` or the
 * Claude-CLI mirror `CLAUDE_CODE_USE_FOUNDRY=1` / `QUANTA_USE_FOUNDRY=1`).
 *
 * Auth precedence (the SDK enforces the same): explicit caller-supplied
 * `azureADTokenProvider` wins; absent that, `apiKey` is used; both absent ⇒
 * typed `provider-misconfigured` at construction. Resource vs baseURL is
 * mutually exclusive: BOTH set is typed `provider-misconfigured` (SDK
 * documents the constraint, we surface it ahead of the wire call).
 *
 * Plane-clean: imports the port + `@/llm` siblings only. No `@/agent`.
 *
 * Test exports — kept STABLE for {@link foundry-watch} + legacy hellgate:
 *   - `FOUNDRY_SDK_PACKAGE` / `FOUNDRY_SDK_NPM_URL` — canonical coordinates.
 *   - `tryImportFoundrySdk()` — lazy resolver that returns `null` on any
 *     failure (preserved so `foundry-watch` keeps a single source of truth
 *     for "is the SDK importable"). Today (SDK published) it returns the
 *     module on success; the resolver still collapses ALL failure modes
 *     into `null` so a corrupted install does not crash the status panel.
 *   - `isFoundryAdapterReady()` — boolean wrapper around the resolver.
 *   - `KNOWN_PUBLISHED_VERSION` — the SDK version we last validated against;
 *     `foundry-watch` cross-checks the live `dist-tags.latest` against this
 *     constant on first import to flag API-drift early.
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

/** Canonical npm package coordinates. Re-exported so {@link foundry-watch}
 *  and the registry surface one source of truth. */
export const FOUNDRY_SDK_PACKAGE = "@anthropic-ai/foundry-sdk"
export const FOUNDRY_SDK_NPM_URL = `https://registry.npmjs.org/${FOUNDRY_SDK_PACKAGE}`

/** SDK version we validated this adapter against. Used by
 *  {@link foundry-watch} to flag drift when the published `dist-tags.latest`
 *  drifts away — the helper does not BLOCK on a mismatch (graceful), it just
 *  surfaces "we have not validated against this version yet" for ops review. */
export const KNOWN_PUBLISHED_VERSION = "0.2.3"

/** Resolved SDK options handed to the SDK constructor. Narrowed to the slice
 *  we depend on — the SDK accepts the full Anthropic `ClientOptions`, but the
 *  adapter only sets the Azure-specific fields. */
interface FoundryClientOptions {
  resource?: string
  apiKey?: string
  baseURL?: string
  azureADTokenProvider?: () => Promise<string>
}

/** Minimal structural view of `AnthropicFoundry`. Narrowed to `messages.create`
 *  the same way the Bedrock / Vertex adapters narrow their SDK clients — keeps
 *  us shape-stable across minor SDK churn. */
interface FoundryClientLike {
  messages: {
    create(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<RawEvent>>
  }
}

interface FoundryClientCtor {
  new (options: FoundryClientOptions): FoundryClientLike
}

interface FoundrySdkModule {
  AnthropicFoundry?: FoundryClientCtor
  default?: FoundryClientCtor
}

/** DI seam — tests inject a synthetic client (no network, no Azure creds).
 *  Production code leaves it absent so the lazy SDK import is the live path.
 *  Same shape as `BedrockClientFactory` / `VertexClientFactory` so the
 *  hellgate suites share patterns. */
export type FoundryClientFactory = (options: FoundryClientOptions) => FoundryClientLike

export interface FoundryAdapterOptions {
  /** Test-only DI seam. When supplied, the lazy SDK import is bypassed and
   *  the given factory is invoked instead. Production callers omit this. */
  clientFactory?: FoundryClientFactory
}

/**
 * Lazy SDK resolver. Collapses EVERY failure mode (package missing,
 * filesystem corruption, ESM resolver error) into `null` so callers never
 * have to wrap their own try/catch. The two test-suite invariants
 * (`tryImportFoundrySdk` and `isFoundryAdapterReady`) MUST share this single
 * helper — divergence here is a wiring bug.
 */
export const tryImportFoundrySdk = async (): Promise<FoundrySdkModule | null> => {
  try {
    // Two-step cast (`as unknown as`) — the SDK exports a richer
    // `messages.create` signature than our narrowed `FoundryClientLike`
    // view; going via `unknown` documents the intentional surface
    // narrowing. Same discipline as `bedrock-adapter`.
    const mod = (await import("@anthropic-ai/foundry-sdk")) as unknown as FoundrySdkModule
    return mod
  } catch {
    // Every failure mode (ERR_MODULE_NOT_FOUND, malformed package, …)
    // collapses to `null`. The watch helper distinguishes "not installed"
    // from "installed but broken" via a separate npm-registry probe.
    return null
  }
}

/** Cheap predicate — true when the SDK is importable AND exports the
 *  expected `AnthropicFoundry` (or `default`) constructor. Used by
 *  {@link foundry-watch} so the watcher and the adapter agree on the
 *  readiness rule. */
export const isFoundryAdapterReady = async (): Promise<boolean> => {
  const mod = await tryImportFoundrySdk()
  if (mod === null) return false
  return mod.AnthropicFoundry !== undefined || mod.default !== undefined
}

/** Validate the auth bundle. Pulled out so the function-style entrypoint and
 *  the class wrapper share the same enforcement — divergence on misconfig
 *  rules is the kind of thing that lands in production as a silent route. */
const validateConfig = (config: ProviderConfig): void => {
  if (config.providerId !== "foundry") {
    throw new ProviderError(
      "provider-misconfigured",
      `FoundryProviderAdapter requires providerId="foundry", got "${config.providerId}"`,
      { providerId: config.providerId },
    )
  }
  const hasResource =
    config.auth.azureResource !== undefined && config.auth.azureResource.length > 0
  const hasBaseUrl = config.auth.azureEndpoint !== undefined && config.auth.azureEndpoint.length > 0
  if (hasResource && hasBaseUrl) {
    throw new ProviderError(
      "provider-misconfigured",
      "foundry transport accepts EITHER auth.azureResource OR auth.azureEndpoint, not both " +
        "(SDK treats them as mutually exclusive)",
      { providerId: "foundry" },
    )
  }
  const hasApiKey = config.auth.azureApiKey !== undefined && config.auth.azureApiKey.length > 0
  const hasTokenProvider = config.auth.azureADTokenProvider !== undefined
  if (!hasApiKey && !hasTokenProvider) {
    throw new ProviderError(
      "provider-misconfigured",
      "foundry transport requires auth.azureApiKey OR auth.azureADTokenProvider (auth-failed)",
      { providerId: "foundry" },
    )
  }
}

/** Build the SDK constructor options from the typed `ProviderConfig`. Only
 *  supplied fields are forwarded — exactOptional honest, the same discipline
 *  as the Bedrock adapter. */
const buildClientOptions = (config: ProviderConfig): FoundryClientOptions => {
  const opts: FoundryClientOptions = {}
  if (config.auth.azureResource !== undefined && config.auth.azureResource.length > 0) {
    opts.resource = config.auth.azureResource
  }
  if (config.auth.azureEndpoint !== undefined && config.auth.azureEndpoint.length > 0) {
    opts.baseURL = config.auth.azureEndpoint
  }
  if (config.auth.azureApiKey !== undefined && config.auth.azureApiKey.length > 0) {
    opts.apiKey = config.auth.azureApiKey
  }
  if (config.auth.azureADTokenProvider !== undefined) {
    opts.azureADTokenProvider = config.auth.azureADTokenProvider
  }
  return opts
}

/** Endpoint string for telemetry — `resource` synthesised into the canonical
 *  Azure URL when present, otherwise the explicit baseURL, otherwise empty
 *  ("we do not know"). Never throws — pure formatter for the `meta` surface. */
const formatEndpoint = (opts: FoundryClientOptions): string => {
  if (opts.baseURL !== undefined && opts.baseURL.length > 0) return opts.baseURL
  if (opts.resource !== undefined && opts.resource.length > 0) {
    return `https://${opts.resource}.services.ai.azure.com/anthropic/v1/messages`
  }
  return ""
}

/**
 * Class-style adapter — mirrors the {@link BedrockProviderAdapter} shape so
 * `@/llm/providers/index` re-exports a uniform surface. The function-style
 * {@link foundryProviderAdapter} below is a thin sugar wrapper for callers
 * who prefer factory composition.
 */
export class FoundryProviderAdapter implements LlmProvider {
  readonly providerId: ProviderId = "foundry"
  readonly provider = "anthropic"
  readonly surfaceId = "anthropic-messages"
  readonly transportId = "foundry"
  readonly authMode = "Azure AI Foundry"
  readonly model: string
  readonly endpoint: string
  private readonly clientOptions: FoundryClientOptions
  private readonly maxTokens: number
  private readonly streamTimeoutMs: { firstChunkMs: number; idleMs: number }
  private readonly clientFactory: FoundryClientFactory | undefined

  constructor(config: ProviderConfig, options: FoundryAdapterOptions = {}) {
    validateConfig(config)
    this.model = config.model
    this.maxTokens = config.maxTokens ?? 8192
    this.streamTimeoutMs = resolveAdapterStreamTimeouts({
      ...(config.streamFirstChunkMs !== undefined
        ? { streamFirstChunkMs: config.streamFirstChunkMs }
        : {}),
      ...(config.streamIdleMs !== undefined ? { streamIdleMs: config.streamIdleMs } : {}),
    })
    this.clientOptions = buildClientOptions(config)
    this.endpoint = formatEndpoint(this.clientOptions)
    if (options.clientFactory !== undefined) this.clientFactory = options.clientFactory
  }

  /** Lazy SDK resolve. Production path goes through {@link tryImportFoundrySdk}
   *  so the suite predicate and the adapter share the same loader. */
  private async resolveClient(): Promise<FoundryClientLike> {
    if (this.clientFactory !== undefined) {
      // DI factory wins. Wrap in the same try/catch as the SDK Ctor below
      // so a DI-thrown `Error("AccessDenied")` lands in the same typed
      // bucket as an SDK ctor failure — keeps HELL-B2 (DI auth-fail) and
      // the live path symmetric. `ProviderError` from the factory passes
      // through untouched (test-only escape hatch for shape-change arms).
      try {
        return this.clientFactory(this.clientOptions)
      } catch (e) {
        if (e instanceof ProviderError) throw e
        throw new ProviderError(
          "provider-misconfigured",
          `Foundry client construction failed (auth-failed): ${errMessage(e)}`,
          { cause: e, providerId: "foundry" },
        )
      }
    }
    const mod = await tryImportFoundrySdk()
    if (mod === null) {
      throw new ProviderError(
        "provider-missing-dependency",
        `Azure Foundry transport requires ${FOUNDRY_SDK_PACKAGE} — install it to enable ` +
          `(see ${FOUNDRY_SDK_NPM_URL})`,
        { providerId: "foundry" },
      )
    }
    const Ctor = mod.AnthropicFoundry ?? mod.default
    if (Ctor === undefined) {
      throw new ProviderError(
        "provider-missing-dependency",
        `${FOUNDRY_SDK_PACKAGE} did not export AnthropicFoundry (SDK shape changed?)`,
        { providerId: "foundry" },
      )
    }
    try {
      return new Ctor(this.clientOptions)
    } catch (e) {
      // Construction itself can throw on bad credentials shape — surface as
      // typed misconfigured rather than leak the SDK-internal error.
      throw new ProviderError(
        "provider-misconfigured",
        `Foundry client construction failed (auth-failed): ${errMessage(e)}`,
        { cause: e, providerId: "foundry" },
      )
    }
  }

  /** Open the SDK messages stream. Mirrors `bedrock-adapter.openRawStream` —
   *  same request shape, same toolChoice resolution, same LLMError
   *  translation — except the transport is Foundry-routed. */
  private async openRawStream(
    client: FoundryClientLike,
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
      // ProviderError (from a DI factory that wants to surface
      // missing-dependency eagerly, or from the SDK throwing an Azure
      // AccessDenied) MUST pass through untouched so the loop's classifier
      // can branch on `.code`. Everything else is a wire error.
      if (e instanceof ProviderError) throw e
      // Detect Azure auth failures — the SDK throws an
      // `Anthropic.APIError`-like with name/code that we map to typed
      // `auth-failed`. We pin on the message prefix because the SDK
      // re-exports its error classes without a stable nominal name.
      const msg = errMessage(e)
      if (/AccessDenied|Unauthorized|InvalidAuthentication/i.test(msg)) {
        throw new ProviderError("provider-misconfigured", `Foundry stream auth failed: ${msg}`, {
          cause: e,
          providerId: "foundry",
        })
      }
      throw LLMError.fromSdkError("anthropic", e)
    }
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    // Pre-aborted signal short-circuit. Mirrors the Bedrock adapter's
    // implicit behaviour (the SDK would throw an AbortError on first
    // network touch anyway) but pinning it here keeps the diagnostic
    // unambiguous — a status panel reads "aborted before stream open"
    // rather than "stream-failed with AbortError".
    if (input.signal?.aborted) {
      // L6 M10a: a caller-driven abort is a typed `aborted` outcome, not a
      // provider-capability failure. Classifying it as provider-unsupported
      // made a status panel read "Foundry can't do this" for a plain cancel.
      throw new LLMError("Foundry stream aborted before stream open", { kind: "aborted" })
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
      throw LLMError.fromSdkError("anthropic", e, "Foundry stream error")
    }
  }
}

/**
 * Function-style factory — sugar around the class constructor. Returns a
 * fresh `LlmProvider` per call (no shared state to leak between adapter
 * instances). Matches the legacy hellgate's preferred surface
 * (`foundryProviderAdapter(cfg)`) and lets callers wire DI factories
 * (testing) without going through `new`.
 */
export const foundryProviderAdapter = (
  cfg: ProviderConfig,
  opts?: FoundryAdapterOptions,
): FoundryProviderAdapter => {
  return new FoundryProviderAdapter(cfg, opts ?? {})
}
