/**
 * ADR-0139 — LLM provider fork (hexagonal port).
 *
 * Enterprise data-governance distinguishes the *vendor* (Anthropic) from the
 * *transport* (api.anthropic.com vs AWS Bedrock vs GCP Vertex vs Azure
 * Foundry). The model weights and the wire grammar are identical; the billing
 * account, residency boundary, and IAM surface are not. This port carves
 * "which transport" away from {@link LLMPort} (which models "which vendor
 * grammar") so callers select transport without touching the vendor adapter.
 *
 * Plane-clean: this file imports ONLY `@/llm` (StreamEvent types). No SDK,
 * no `@/agent`, no `@/permission`, no `@/tool` — exactly the same discipline
 * `provider-port` enforces in every other slice (the adapter implementations
 * may pull in `@anthropic-ai/sdk`; this file may not).
 *
 * Default-OFF posture: the existing `@/llm/factory` path keeps wrapping
 * `Anthropic` directly. {@link resolveProvider} is consulted ONLY by callers
 * that opt in to transport routing; the legacy path stays byte-identical.
 */

import type { LLMPort } from "../ports"
import type { StreamEvent, StreamInput } from "../types"

// Re-export StreamEvent / StreamInput so adapter files in this slice can
// import the wire types from `@/llm/providers/provider-port` without reaching
// back into the parent. The actual types still live in `../types` — single
// source of truth.
export type { StreamEvent, StreamInput }

/** Canonical transport id. Closed union — adding a transport is a typed
 *  change (one entry here, one factory in the registry, one ADR follow-up).
 *  `default` is the public `api.anthropic.com` path; the other three are the
 *  enterprise data-governance forks. */
export type ProviderId = "default" | "bedrock" | "vertex" | "foundry"

/**
 * Provider authentication bundle. Every field is OPTIONAL — each transport
 * picks the subset it needs and ignores the rest. We deliberately keep ONE
 * struct (rather than a discriminated union per transport) so callers wiring
 * a multi-transport fallback chain can hand down ONE credential bundle.
 *
 * - `apiKey`              `default` transport — `ANTHROPIC_API_KEY`.
 * - `awsAccessKeyId` / `awsSecretAccessKey` / `awsSessionToken` / `awsRegion`
 *                         `bedrock` transport — explicit static creds. Omit
 *                         all four to let the SDK default chain (env vars,
 *                         IMDS, IRSA, SSO, …) resolve.
 * - `gcpProjectId` / `gcpLocation`
 *                         `vertex` transport — REQUIRED. The Vertex endpoint
 *                         path is `projects/{id}/locations/{loc}/...`; with
 *                         either field missing the adapter cannot synthesize
 *                         the URL, so we typed-fail at resolution time rather
 *                         than at first wire call.
 * - `gcpAccessToken`      `vertex` transport — optional explicit bearer. Omit
 *                         to let `google-auth-library` resolve from ADC
 *                         (Application Default Credentials).
 * - `azureEndpoint` / `azureApiKey`
 *                         `foundry` transport — Phase 1 stub only; recorded
 *                         here so the Phase 2 wiring is a pure adapter
 *                         change with no port-shape churn.
 */
export interface ProviderAuth {
  readonly apiKey?: string
  readonly awsAccessKeyId?: string
  readonly awsSecretAccessKey?: string
  readonly awsSessionToken?: string
  readonly awsRegion?: string
  readonly gcpProjectId?: string
  readonly gcpLocation?: string
  readonly gcpAccessToken?: string
  readonly azureEndpoint?: string
  readonly azureApiKey?: string
}

/**
 * Provider configuration — passed verbatim to the {@link ProviderFactory}.
 * The split between {@link ProviderAuth} (credentials) and {@link ProviderConfig}
 * (everything else) mirrors the cloud-SDK convention: credentials rotate on
 * one schedule (IAM), model / region / timeouts on another (release).
 *
 * `model` is REQUIRED — the registry never assumes a default at the port
 * layer; that policy lives one level up in `@/llm/factory` (`DEFAULT_MODEL`).
 * Forwarding undefined here would let an adapter ship with `model:"undefined"`
 * baked into a wire payload, which a 400-bad-request would surface only at
 * runtime.
 */
export interface ProviderConfig {
  readonly providerId: ProviderId
  readonly model: string
  readonly auth: ProviderAuth
  /** Anthropic beta channels — forwarded to the `default` adapter only.
   *  Bedrock / Vertex do not expose the `anthropic-beta` header surface. */
  readonly betaHeaders?: readonly string[]
  /** Adapter completion-token cap; defaults to 8192 inside the adapter when
   *  omitted (matches the legacy `AnthropicAdapter` default). */
  readonly maxTokens?: number
  /** T1 stream-hang guard overrides (caller wins over env wins over default). */
  readonly streamFirstChunkMs?: number
  readonly streamIdleMs?: number
}

/**
 * The transport-level provider interface. Identical streaming contract as
 * {@link LLMPort} — every callable surface in the loop already speaks
 * `StreamEvent` so a `LlmProvider` instance is plug-compatible wherever an
 * `LLMPort` is expected. The structural extension makes the type system check
 * that fact at compile time.
 *
 * Adapters MAY surface `providerId` so the loop's pre-stream `llm_request`
 * marker carries an unambiguous transport badge alongside the model and
 * vendor (`provider`).
 */
export interface LlmProvider extends LLMPort {
  readonly providerId: ProviderId
  stream(input: StreamInput): AsyncIterable<StreamEvent>
}

/**
 * Closed error code union. Adapters MUST construct via the {@link ProviderError}
 * class so downstream policy branches on `.code` (never on `.message`). The
 * codes split cleanly from {@link LLMErrorKind} (which models *what happened
 * during a wire call*) — these model *what went wrong selecting / building*
 * the provider in the first place.
 */
export type ProviderErrorCode =
  /** Caller asked for a transport that is not implemented in this build (e.g.
   *  `foundry` in Phase 1). Distinct from `auth` — we did not try to
   *  authenticate; we refused at the factory. */
  | "provider-unsupported"
  /** Required config field is missing (Vertex without `gcpProjectId`, etc.).
   *  Caller bug — never retry. */
  | "provider-misconfigured"
  /** Required runtime dependency (separate SDK package) is not installed.
   *  Triggered when an enterprise transport (`bedrock` / `vertex`) is selected
   *  but the corresponding `@anthropic-ai/{bedrock,vertex}-sdk` is absent from
   *  the install. Distinct from `provider-unsupported` (we know the transport
   *  but cannot satisfy it) and `provider-misconfigured` (config is wrong). */
  | "provider-missing-dependency"

/** Thrown from {@link ProviderFactory} construction or from the `stub` arms
 *  of adapters whose dependency is absent. Carries a stable `code` so the
 *  loop's error classifier can route without parsing the message. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly providerId?: ProviderId

  constructor(
    code: ProviderErrorCode,
    message: string,
    options?: { cause?: unknown; providerId?: ProviderId },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = "ProviderError"
    this.code = code
    if (options?.providerId !== undefined) this.providerId = options.providerId
  }
}

/**
 * Factory signature. Synchronous so the registry can typed-fail at resolution
 * time (caller hands us `ProviderConfig`, we either return a usable provider
 * or throw a {@link ProviderError}). No I/O at construction — that lives
 * inside `stream()` where it belongs.
 */
export type ProviderFactory = (config: ProviderConfig) => LlmProvider
