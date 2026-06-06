import type { LLMProvider } from "@/shared/errors"
import { errMessage, LLMError } from "@/shared/errors"
import { runtimeConfig } from "@/shared/runtime-config"
import { ProviderError, type ProviderId } from "../providers/provider-port"
import { resolveStreamTimeoutMs } from "../stream-timeout"
import type { StreamEvent } from "../types"

/** Shared adapter boilerplate. The Anthropic and OpenAI adapters duplicated
 *  ~90% of (a) constructor stream-timeout resolution, (b) the malformed
 *  tool-input throw, and (c) the conditional `cacheReadTokens` usage-event
 *  spread. Those frames are factored here as plain functions (composition over
 *  inheritance — there is no shared SDK base to subclass). The
 *  provider-specific wire mapping (`mapRawEvent` vs `processChunk`)
 *  legitimately differs and stays in each adapter. */

/** Caller-supplied stream-hang overrides shared by every adapter config. */
export interface AdapterStreamTimeoutConfig {
  streamFirstChunkMs?: number
  streamIdleMs?: number
}

/** Resolve the per-adapter stream-hang deadlines ONCE at construction.
 *  Caller-supplied overrides win over env knobs
 *  (`QUANTA_LLM_STREAM_FIRST_CHUNK_MS` / `QUANTA_LLM_STREAM_IDLE_MS`); env wins
 *  over the defaults baked into `src/llm/stream-timeout.ts`. Reads
 *  `runtimeConfig()` exactly once — no per-call re-read. Behavior is
 *  byte-identical to the inline logic each adapter used to carry. */
export const resolveAdapterStreamTimeouts = (
  config: AdapterStreamTimeoutConfig,
): { firstChunkMs: number; idleMs: number } => {
  const env = runtimeConfig()
  const override: { firstChunkMs?: number; idleMs?: number } = {}
  if (config.streamFirstChunkMs !== undefined) override.firstChunkMs = config.streamFirstChunkMs
  if (config.streamIdleMs !== undefined) override.idleMs = config.streamIdleMs
  return resolveStreamTimeoutMs(env.llmStreamFirstChunkMs, env.llmStreamIdleMs, override)
}

/** How the structured throw attaches the underlying parse error. The two
 *  adapters diverged here and the conformance tests pin it: OpenAI threads
 *  `cause: e`, Anthropic omits `cause` entirely. Selecting per-call keeps both
 *  byte-identical. */
export type ToolInputCausePolicy = "with-cause" | "no-cause"

/** Parse accumulated tool-call argument JSON, or throw the structured
 *  `stream_corrupt` LLMError both adapters raised verbatim. Empty / whitespace
 *  ⇒ `{}` (a tool with no arguments). `causePolicy` selects whether the parse
 *  error is threaded as `cause` (OpenAI) or omitted (Anthropic), preserving
 *  each adapter's exact prior throw. */
export const parseToolInputOrThrow = (
  json: string,
  id: string,
  provider: LLMProvider,
  causePolicy: ToolInputCausePolicy = "no-cause",
): unknown => {
  if (!json.trim()) return {}
  try {
    return JSON.parse(json)
  } catch (e) {
    throw new LLMError(`Malformed tool input JSON for ${id}`, {
      kind: "stream_corrupt",
      provider,
      ...(causePolicy === "with-cause" ? { cause: e } : {}),
    })
  }
}

/** Anthropic-transport SDK auth-failure signatures. The Foundry / Mantle SDKs
 *  re-export their error classes WITHOUT a stable nominal name, so an auth
 *  failure is recognised by message prefix. Shared so the two Azure/Mantle
 *  adapters classify identically — a regex that drifts in one and not the other
 *  is exactly the divergence this single owner prevents. */
const ANTHROPIC_TRANSPORT_AUTH_RE = /AccessDenied|Unauthorized|InvalidAuthentication/i

/**
 * Classify a stream-open throw from an Anthropic-grammar enterprise transport
 * (Foundry / Mantle). Returns the typed error the adapter should THROW — both
 * adapters wrap `client.messages.create` and need the SAME triage:
 *   - a `ProviderError` (a DI factory surfacing missing-dependency eagerly, or
 *     the SDK throwing an enterprise AccessDenied) passes through UNTOUCHED so
 *     the loop's classifier can branch on `.code`;
 *   - an auth-shaped wire error (AccessDenied / Unauthorized /
 *     InvalidAuthentication) maps to a typed `provider-misconfigured`
 *     `ProviderError` tagged `${label} stream auth failed: <msg>`;
 *   - everything else maps to `LLMError.fromSdkError("anthropic", e)`.
 *
 * Returns (does not throw) so the call site keeps an explicit `throw`, which TS
 * control-flow recognises as terminal inside the `catch`. `label` is the human
 * transport name ("Foundry" / "Mantle") so the message + telemetry stay
 * distinguishable; `providerId` is the typed provider tag carried on the
 * `ProviderError`. Behaviour is byte-identical to the inline ladders each adapter
 * previously carried.
 */
export const classifyAnthropicTransportStreamError = (
  e: unknown,
  label: string,
  providerId: ProviderId,
): ProviderError | LLMError => {
  if (e instanceof ProviderError) return e
  const msg = errMessage(e)
  if (ANTHROPIC_TRANSPORT_AUTH_RE.test(msg)) {
    return new ProviderError("provider-misconfigured", `${label} stream auth failed: ${msg}`, {
      cause: e,
      providerId,
    })
  }
  return LLMError.fromSdkError("anthropic", e)
}

/** Token counts gathered from a stream, provider-agnostic. Adapters fold their
 *  raw payloads into this shape, then call {@link buildUsageEvent}. */
export interface UsageCounts {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  model?: string
}

/** Build the additive `usage` StreamEvent from accumulated counts. Returns
 *  `null` when neither side reported tokens (absent usage is valid — never emit
 *  zeros). `cacheReadTokens` / `cacheCreationTokens` are included only when the
 *  provider reported that bucket (exactOptionalPropertyTypes: conditional
 *  spread, not undefined). Shared by both adapters; the per-provider raw→counts
 *  fold stays provider-side. */
export const buildUsageEvent = (counts: UsageCounts): StreamEvent | null => {
  if (counts.inputTokens === undefined && counts.outputTokens === undefined) return null
  return {
    type: "usage",
    inputTokens: counts.inputTokens ?? 0,
    outputTokens: counts.outputTokens ?? 0,
    model: counts.model ?? "",
    ...(counts.cacheReadTokens !== undefined ? { cacheReadTokens: counts.cacheReadTokens } : {}),
    ...(counts.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: counts.cacheCreationTokens }
      : {}),
  }
}
