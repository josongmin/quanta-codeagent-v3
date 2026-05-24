/**
 * ADR-0139 — `vertex` transport adapter (Google Cloud Vertex AI).
 *
 * Anthropic ships `@anthropic-ai/vertex-sdk` exporting `AnthropicVertex`, the
 * Vertex-routed sibling of the public `Anthropic` client. Wire grammar is
 * identical; the difference is the URL path
 * (`projects/{gcpProjectId}/locations/{gcpLocation}/...`) and the auth source
 * (Google bearer token instead of `x-api-key`).
 *
 * Phase 1 posture (same as `bedrock-adapter.ts`): the adapter constructs FINE
 * without the Vertex SDK present, but `stream()` throws {@link ProviderError}
 * with code `provider-missing-dependency` so the caller gets a clear
 * "install @anthropic-ai/vertex-sdk" message rather than a cryptic
 * `MODULE_NOT_FOUND`. When the SDK is installed (Phase 2 or downstream-fork)
 * the dynamic import resolves and the adapter delegates verbatim.
 *
 * Vertex requires BOTH `gcpProjectId` AND `gcpLocation` to synthesize the URL;
 * either missing ⇒ `auth-failed` (`provider-misconfigured`) at construction
 * time so the typed-fail surfaces at factory wiring, not at first wire call.
 *
 * Plane-clean: imports the port + `@/llm` types only. No `@/agent`.
 */

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
    create(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>
  }
}

interface VertexClientCtor {
  new (options: VertexClientOptions): VertexClientLike
}

interface VertexSdkModule {
  AnthropicVertex?: VertexClientCtor
  default?: VertexClientCtor
}

export class VertexProviderAdapter implements LlmProvider {
  readonly providerId: ProviderId = "vertex"
  readonly provider = "anthropic"
  readonly authMode = "GCP Vertex"
  readonly model: string
  private readonly clientOptions: VertexClientOptions

  constructor(config: ProviderConfig) {
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
    const opts: VertexClientOptions = { projectId, region: location }
    // `gcpAccessToken` is optional — when absent, the SDK resolves via
    // `google-auth-library` (Application Default Credentials).
    if (config.auth.gcpAccessToken !== undefined) opts.accessToken = config.auth.gcpAccessToken
    this.clientOptions = opts
  }

  /** Lazy SDK resolve — same discipline as `BedrockProviderAdapter`. */
  private async resolveClient(): Promise<VertexClientLike> {
    let mod: VertexSdkModule
    try {
      // @ts-expect-error — optional peer dep, intentionally NOT in package.json.
      // Resolution succeeds only when the host install adds the SDK explicitly;
      // absence is caught and translated to ProviderError("provider-missing-dependency").
      mod = (await import("@anthropic-ai/vertex-sdk")) as VertexSdkModule
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
    return new Ctor(this.clientOptions)
  }

  // Phase 1 always throws ProviderError before the first yield. The async-generator
  // signature must remain to satisfy LlmProvider. Phase 2 wiring (Vertex
  // messages.create + mapRawEvent) lands the real yields.
  // biome-ignore lint/correctness/useYield: Phase-1 throw-only stub; see comment above.
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    // Resolve the client lazily; throws ProviderError if the SDK is missing.
    // Phase 2 work: wire `input` → Vertex messages.create and re-decode the
    // raw events through the existing `mapRawEvent`. For Phase 1 we surface
    // the dependency error eagerly so callers get a clear actionable message.
    await this.resolveClient()
    throw new ProviderError(
      "provider-unsupported",
      "Vertex stream() wiring is Phase 2 — adapter constructed but not yet wired",
      { providerId: "vertex" },
    )
  }
}
