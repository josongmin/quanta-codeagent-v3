import type { LLMPort } from "../ports"
import { resolveDeliverableReasoningEffort } from "../reasoning-effort"
import {
  defaultResponsesContinuationStore,
  type ResponsesContinuationStore,
} from "../responses-continuation-store"
import {
  defaultResponsesReasoningCarryoverStore,
  prepareResponsesContinuationRequest,
  type ResponsesFetchLike,
  type ResponsesReasoningCarryoverStore,
  streamResponsesSurface,
} from "../responses-stream"
import type { StreamEvent, StreamInput } from "../types"
import { type AdapterStreamTimeoutConfig, resolveAdapterStreamTimeouts } from "./shared"

interface OpenAIResponsesConfig extends AdapterStreamTimeoutConfig {
  apiKey: string
  model: string
  maxTokens?: number
  baseURL?: string
  fetchImpl?: ResponsesFetchLike
  continuationStore?: ResponsesContinuationStore
  /** OpenAI `service_tier` — env-derived at the composition root and passed
   *  in as plain config (this adapter never reads process.env). */
  serviceTier?: string
  /** Reasoning effort — env-derived at the composition root and passed in. */
  reasoningEffort?: string
  /** Reasoning summary request (`QUANTA_REASONING_SUMMARY`) — env-derived at the
   *  composition root. When true ⇒ `reasoning.summary:"auto"` on the body. */
  reasoningSummary?: boolean
  /** Reasoning summary detail level (`QUANTA_REASONING_SUMMARY_DETAIL`) —
   *  env-derived at the composition root. `"detailed"` ⇒ max CoT visibility.
   *  Omitted ⇒ `"auto"` (wire default). */
  reasoningSummaryDetail?: "auto" | "concise" | "detailed"
  /** Reasoning output verbosity (`QUANTA_REASONING_VERBOSITY`) — env-derived at
   *  the composition root. Threaded onto the body as `text.verbosity`. */
  reasoningVerbosity?: string
  /** H15 — when true, capture each turn's reasoning `encrypted_content` and
   *  re-emit it on the next turn's input (ZDR-compatible o-series carry-over).
   *  Env-derived at the composition root (`QUANTA_REASONING_CARRYOVER`); absent/
   *  false ⇒ byte-identical (thinking dropped, no `include`, no re-emit). */
  reasoningCarryover?: boolean
}

const RESPONSES_PATH = "/responses"

export class OpenAIResponsesAdapter implements LLMPort {
  readonly model: string
  readonly provider = "openai"
  readonly surfaceId = "openai-responses"
  readonly transportId = "public"
  readonly authMode = "OpenAI BYOK"

  private readonly apiKey: string
  private readonly baseURL: string
  private readonly fetchImpl: ResponsesFetchLike
  private readonly maxTokens: number
  private readonly streamTimeoutMs: { firstChunkMs: number; idleMs: number }
  private readonly continuationStore: ResponsesContinuationStore
  private readonly serviceTier: string | undefined
  private readonly reasoningEffort: string | undefined
  private readonly reasoningSummary: boolean
  private readonly reasoningSummaryDetail: "auto" | "concise" | "detailed" | undefined
  private readonly reasoningVerbosity: string | undefined
  /** H15 — per-session carry-over: the flag + ONE store held for the adapter's
   *  lifetime so reasoning captured on turn N is available as turn N+1's input.
   *  Only allocated/consulted when the gate is on (off ⇒ byte-identical). */
  private readonly reasoningCarryover: boolean
  private readonly reasoningCarryoverStore: ResponsesReasoningCarryoverStore | undefined

  constructor(config: OpenAIResponsesConfig) {
    this.apiKey = config.apiKey
    this.model = config.model
    this.baseURL = (config.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "")
    this.fetchImpl = config.fetchImpl ?? fetch
    this.maxTokens = config.maxTokens ?? 8192
    this.streamTimeoutMs = resolveAdapterStreamTimeouts(config)
    this.continuationStore = config.continuationStore ?? defaultResponsesContinuationStore()
    this.serviceTier = config.serviceTier
    // Fail BEFORE the first model invocation, not on the first request: a
    // misconfigured effort must stop the run from starting rather than ship the
    // provider default under a receipt claiming the requested value. `stream()`
    // is still guarded at the wire (`buildResponsesBody`) — this is the early,
    // composition-time half of the same SSOT decision.
    this.reasoningEffort = resolveDeliverableReasoningEffort(
      config.reasoningEffort,
      "openai-responses",
    )
    this.reasoningSummary = config.reasoningSummary === true
    this.reasoningSummaryDetail = config.reasoningSummaryDetail
    this.reasoningVerbosity = config.reasoningVerbosity
    this.reasoningCarryover = config.reasoningCarryover === true
    this.reasoningCarryoverStore = this.reasoningCarryover
      ? defaultResponsesReasoningCarryoverStore()
      : undefined
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const continuationStore = input.responsesContinuation?.store ?? this.continuationStore
    // H15 — pass the carry-over flag+store ONLY when the gate is on, so an unset
    // deployment emits no `include`/reasoning items and is byte-identical.
    const carryover =
      this.reasoningCarryover && this.reasoningCarryoverStore !== undefined
        ? {
            reasoningCarryover: true as const,
            reasoningCarryoverStore: this.reasoningCarryoverStore,
          }
        : {}
    yield* streamResponsesSurface({
      provider: "openai",
      transportId: "public",
      model: this.model,
      input,
      request: prepareResponsesContinuationRequest({
        input,
        model: this.model,
        transportId: "public",
        maxOutputTokens: this.maxTokens,
        continuationStore,
        ...(this.serviceTier !== undefined ? { serviceTier: this.serviceTier } : {}),
        ...(this.reasoningEffort !== undefined ? { reasoningEffort: this.reasoningEffort } : {}),
        ...(this.reasoningSummary ? { reasoningSummary: true } : {}),
        ...(this.reasoningSummaryDetail !== undefined
          ? { reasoningSummaryDetail: this.reasoningSummaryDetail }
          : {}),
        ...(this.reasoningVerbosity !== undefined
          ? { reasoningVerbosity: this.reasoningVerbosity }
          : {}),
        ...carryover,
      }),
      fetchImpl: this.fetchImpl,
      url: `${this.baseURL}${RESPONSES_PATH}`,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${this.apiKey}`,
      },
      timeoutMs: this.streamTimeoutMs,
      continuationStore,
      ...carryover,
    })
  }
}
