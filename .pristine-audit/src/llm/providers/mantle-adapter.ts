/**
 * ADR-0172 (Mantle graduation seam) — `mantle` transport adapter (Anthropic
 * Mantle enterprise endpoint). REAL stream skeleton, SDK-absent.
 *
 * Supersedes the ADR-0163 typed-stub. Anthropic Mantle still has NO publicly
 * published SDK as of 2026-05-24 — the name surfaces only via the Claude-CLI
 * env switch `CLAUDE_CODE_USE_MANTLE` and internal docs. Rather than fake the
 * wire grammar (which would lock us into a shape that may shift before GA),
 * this adapter graduates to the SAME four-part structure the shipped
 * Foundry / Vertex / Bedrock adapters use — lazy SDK import, `clientFactory`
 * DI, real `messages.create`, `mapRawEvent` decode — but the lazy import
 * targets `@anthropic-ai/mantle-sdk`, which is not yet on npm. Selecting
 * `mantle` without the SDK installed therefore throws a typed
 * `provider-missing-dependency` (handled by the fallback chain) — strictly
 * better UX than the old `provider-unsupported`, and identical to what
 * Foundry already gives when its SDK is absent.
 *
 * The wire grammar is IDENTICAL Anthropic Messages; only the transport + auth
 * source differ. The request builder (`buildAnthropicMessagesRequest`), the
 * decoder (`mapRawEvent`), the timeout wrapper, and the abort short-circuit
 * are all shared — exactly as the sibling adapters share them.
 *
 * Default-OFF posture: the legacy `@/llm/factory` path keeps wrapping
 * `Anthropic` directly. This adapter is reached ONLY when the caller resolves
 * `providerId="mantle"` via the registry; the legacy path stays
 * byte-identical.
 *
 * Auth: Mantle issues a gateway-minted bearer (`auth.mantleToken`) and a
 * gateway-specific base URL (`auth.mantleEndpoint`). `mantleToken` is REQUIRED
 * (typed `provider-misconfigured` at construction when absent); `mantleEndpoint`
 * is optional (SDK may default it from env when the surface lands).
 *
 * Plane-clean: imports the port + `@/llm` siblings only. No `@/agent`.
 *
 * Why a separate Mantle adapter rather than reusing FoundryProviderAdapter?
 * Telemetry parity. The router emits `providerId="mantle"` so dashboards can
 * distinguish Mantle traffic from Foundry (different billing units, different
 * residency boundaries). Mantle and Foundry graduate on different release
 * schedules, so a shared base would couple them.
 *
 * Test exports — kept STABLE for {@link mantle-watch} + the hellgate battery:
 *   - `MANTLE_SDK_PACKAGE` / `MANTLE_SDK_NPM_URL` — canonical coordinates.
 *   - `tryImportMantleSdk()` — lazy resolver that returns `null` on any
 *     failure (so a future install — or its absence today — never crashes a
 *     status panel; ALL failure modes collapse to `null`).
 *   - `isMantleAdapterReady()` — boolean wrapper around the resolver.
 */

import { errMessage, LLMError } from "@/shared/errors"
import {
  buildAnthropicMessagesRequest,
  mapRawEvent,
  type OpenSlots,
  type RawEvent,
} from "../adapters/anthropic"
import {
  classifyAnthropicTransportStreamError,
  resolveAdapterStreamTimeouts,
} from "../adapters/shared"
import { withStreamTimeout } from "../stream-timeout"
import type { CacheTtl, StreamEvent, StreamInput } from "../types"
import type { LlmProvider, ProviderConfig, ProviderId } from "./provider-port"
import { ProviderError } from "./provider-port"

/** Canonical npm package coordinates. Re-exported so {@link mantle-watch} and
 *  the registry surface one source of truth. The package does NOT exist
 *  publicly yet — the lazy import collapses its absence to a typed
 *  `provider-missing-dependency`. */
export const MANTLE_SDK_PACKAGE = "@anthropic-ai/mantle-sdk"
export const MANTLE_SDK_NPM_URL = `https://registry.npmjs.org/${MANTLE_SDK_PACKAGE}`

/** Resolved SDK options handed to the SDK constructor. Narrowed to the slice
 *  we depend on — the (future) SDK accepts the full Anthropic `ClientOptions`,
 *  but the adapter only sets the Mantle-specific fields. */
interface MantleClientOptions {
  authToken?: string
  baseURL?: string
}

/** Minimal structural view of the (future) `AnthropicMantle` client. Narrowed
 *  to `messages.create` the same way the Bedrock / Vertex / Foundry adapters
 *  narrow their SDK clients — keeps us shape-stable across SDK churn. */
interface MantleClientLike {
  messages: {
    create(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<RawEvent>>
  }
}

interface MantleClientCtor {
  new (options: MantleClientOptions): MantleClientLike
}

interface MantleSdkModule {
  AnthropicMantle?: MantleClientCtor
  default?: MantleClientCtor
}

/** DI seam — tests inject a synthetic client (no network, no Mantle creds).
 *  Production code leaves it absent so the lazy SDK import is the live path.
 *  Same shape as `FoundryClientFactory` / `BedrockClientFactory` /
 *  `VertexClientFactory` so the hellgate suites share patterns. */
export type MantleClientFactory = (options: MantleClientOptions) => MantleClientLike

export interface MantleAdapterOptions {
  /** Test-only DI seam. When supplied, the lazy SDK import is bypassed and
   *  the given factory is invoked instead. Production callers omit this. */
  clientFactory?: MantleClientFactory
}

/**
 * Lazy SDK resolver. Collapses EVERY failure mode (package missing — the live
 * state today — filesystem corruption, ESM resolver error) into `null` so
 * callers never have to wrap their own try/catch. The two test-suite
 * invariants (`tryImportMantleSdk` and `isMantleAdapterReady`) MUST share this
 * single helper — divergence here is a wiring bug.
 */
export const tryImportMantleSdk = async (): Promise<MantleSdkModule | null> => {
  try {
    // Two-step cast (`as unknown as`) — the SDK exports a richer
    // `messages.create` signature than our narrowed `MantleClientLike`
    // view; going via `unknown` documents the intentional surface
    // narrowing. Same discipline as `foundry-adapter`.
    //
    // The specifier is held in a variable so the bundler does not try to
    // statically resolve a package that is not installed (which would fail
    // the build); the dynamic form keeps the import inert until the dep
    // exists. ALL failure modes collapse to `null` below.
    const specifier = MANTLE_SDK_PACKAGE
    const mod = (await import(specifier)) as unknown as MantleSdkModule
    return mod
  } catch {
    // Every failure mode (ERR_MODULE_NOT_FOUND — the live state today —
    // malformed package, …) collapses to `null`. The watch helper would
    // distinguish "not installed" from "installed but broken" via a separate
    // npm-registry probe.
    return null
  }
}

/** Cheap predicate — true when the SDK is importable AND exports the expected
 *  `AnthropicMantle` (or `default`) constructor. Today (SDK unpublished) this
 *  returns `false`; used by {@link mantle-watch} so the watcher and the
 *  adapter agree on the readiness rule. */
export const isMantleAdapterReady = async (): Promise<boolean> => {
  const mod = await tryImportMantleSdk()
  if (mod === null) return false
  return mod.AnthropicMantle !== undefined || mod.default !== undefined
}

/** Validate the auth bundle. Pulled out so a future function-style entrypoint
 *  and the class wrapper share the same enforcement — divergence on misconfig
 *  rules is the kind of thing that lands in production as a silent route.
 *  Mirrors Vertex's "missing required field ⇒ typed misconfig at
 *  construction". */
const validateConfig = (config: ProviderConfig): void => {
  if (config.providerId !== "mantle") {
    throw new ProviderError(
      "provider-misconfigured",
      `MantleProviderAdapter requires providerId="mantle", got "${config.providerId}"`,
      { providerId: config.providerId },
    )
  }
  const hasToken = config.auth.mantleToken !== undefined && config.auth.mantleToken.length > 0
  if (!hasToken) {
    throw new ProviderError(
      "provider-misconfigured",
      "mantle transport requires auth.mantleToken (auth-failed)",
      { providerId: "mantle" },
    )
  }
}

/** Build the SDK constructor options from the typed `ProviderConfig`. Only
 *  supplied fields are forwarded — exactOptional honest, the same discipline
 *  as the Foundry adapter. */
const buildClientOptions = (config: ProviderConfig): MantleClientOptions => {
  const opts: MantleClientOptions = {}
  if (config.auth.mantleToken !== undefined && config.auth.mantleToken.length > 0) {
    opts.authToken = config.auth.mantleToken
  }
  if (config.auth.mantleEndpoint !== undefined && config.auth.mantleEndpoint.length > 0) {
    opts.baseURL = config.auth.mantleEndpoint
  }
  return opts
}

/** Endpoint string for telemetry — the explicit baseURL when present, else
 *  empty ("we do not know — SDK resolves from env"). Never throws — pure
 *  formatter for the `meta` surface. */
const formatEndpoint = (opts: MantleClientOptions): string => {
  if (opts.baseURL !== undefined && opts.baseURL.length > 0) return opts.baseURL
  return ""
}

/**
 * Class-style adapter — mirrors the {@link FoundryProviderAdapter} shape so
 * `@/llm/providers/index` re-exports a uniform surface.
 */
export class MantleProviderAdapter implements LlmProvider {
  readonly providerId: ProviderId = "mantle"
  readonly provider = "anthropic"
  readonly surfaceId = "anthropic-messages"
  readonly transportId = "mantle"
  readonly authMode = "Anthropic Mantle"
  readonly model: string
  readonly endpoint: string
  private readonly clientOptions: MantleClientOptions
  private readonly maxTokens: number
  private readonly cacheTtl: CacheTtl
  private readonly streamTimeoutMs: { firstChunkMs: number; idleMs: number }
  private readonly clientFactory: MantleClientFactory | undefined

  constructor(config: ProviderConfig, options: MantleAdapterOptions = {}) {
    validateConfig(config)
    this.model = config.model
    this.maxTokens = config.maxTokens ?? 8192
    this.cacheTtl = config.cacheTtl ?? "5m"
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

  /** Lazy SDK resolve. Production path goes through {@link tryImportMantleSdk}
   *  so the suite predicate and the adapter share the same loader. */
  private async resolveClient(): Promise<MantleClientLike> {
    if (this.clientFactory !== undefined) {
      // DI factory wins. Wrap in the same try/catch as the SDK Ctor below so
      // a DI-thrown `Error("AccessDenied")` lands in the same typed bucket as
      // an SDK ctor failure — keeps the DI auth-fail arm and the live path
      // symmetric. `ProviderError` from the factory passes through untouched
      // (test-only escape hatch for shape-change arms).
      try {
        return this.clientFactory(this.clientOptions)
      } catch (e) {
        if (e instanceof ProviderError) throw e
        throw new ProviderError(
          "provider-misconfigured",
          `Mantle client construction failed (auth-failed): ${errMessage(e)}`,
          { cause: e, providerId: "mantle" },
        )
      }
    }
    const mod = await tryImportMantleSdk()
    if (mod === null) {
      throw new ProviderError(
        "provider-missing-dependency",
        `Anthropic Mantle transport requires ${MANTLE_SDK_PACKAGE} — install it to enable ` +
          `(see ${MANTLE_SDK_NPM_URL})`,
        { providerId: "mantle" },
      )
    }
    const Ctor = mod.AnthropicMantle ?? mod.default
    if (Ctor === undefined) {
      throw new ProviderError(
        "provider-missing-dependency",
        `${MANTLE_SDK_PACKAGE} did not export AnthropicMantle (SDK shape changed?)`,
        { providerId: "mantle" },
      )
    }
    try {
      return new Ctor(this.clientOptions)
    } catch (e) {
      // Construction itself can throw on bad credentials shape — surface as
      // typed misconfigured rather than leak the SDK-internal error.
      throw new ProviderError(
        "provider-misconfigured",
        `Mantle client construction failed (auth-failed): ${errMessage(e)}`,
        { cause: e, providerId: "mantle" },
      )
    }
  }

  /** Open the SDK messages stream. Mirrors `foundry-adapter.openRawStream` —
   *  same request shape, same LLMError translation — except the transport is
   *  Mantle-routed. */
  private async openRawStream(
    client: MantleClientLike,
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
      // Shared triage (see `classifyAnthropicTransportStreamError`): ProviderError
      // passes through untouched so the loop classifier can branch on `.code`; a
      // Mantle auth-shaped wire error (AccessDenied / Unauthorized / …) maps to
      // typed `provider-misconfigured`; everything else is an Anthropic wire error.
      throw classifyAnthropicTransportStreamError(e, "Mantle", "mantle")
    }
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    // Pre-aborted signal short-circuit. Mirrors the Foundry adapter — pinning
    // it here keeps the diagnostic unambiguous: a status panel reads "aborted
    // before stream open" rather than "stream-failed with AbortError".
    if (input.signal?.aborted) {
      // A caller-driven abort is a typed `aborted` outcome, not a
      // provider-capability failure.
      throw new LLMError("Mantle stream aborted before stream open", { kind: "aborted" })
    }
    const client = await this.resolveClient()
    const raw = await this.openRawStream(client, input)
    const guarded = withStreamTimeout(raw, {
      firstChunkMs: this.streamTimeoutMs.firstChunkMs,
      idleMs: this.streamTimeoutMs.idleMs,
      provider: "anthropic",
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onChunk ? { onChunk: input.onChunk } : {}),
    })
    const open: OpenSlots = new Map()
    try {
      for await (const ev of guarded) {
        yield* mapRawEvent(ev, open, { model: this.model })
      }
    } catch (e) {
      if (e instanceof ProviderError) throw e
      throw LLMError.fromSdkError("anthropic", e, "Mantle stream error")
    }
  }
}

/**
 * Function-style factory — sugar around the class constructor. Returns a fresh
 * `LlmProvider` per call (no shared state to leak between adapter instances).
 * Mirrors `foundryProviderAdapter` and lets callers wire DI factories
 * (testing) without going through `new`.
 */
export const mantleProviderAdapter = (
  cfg: ProviderConfig,
  opts?: MantleAdapterOptions,
): MantleProviderAdapter => {
  return new MantleProviderAdapter(cfg, opts ?? {})
}
