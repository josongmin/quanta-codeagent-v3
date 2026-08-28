import { LLMError } from "@/shared"
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
  responsesStatusToKind,
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

/** The model-catalog path on the same base URL the Responses wire uses. The
 *  `/v1/models` shape is shared by OpenAI and every OpenAI-compatible endpoint,
 *  so ONE constant covers the public vendor and a `QUANTA_LLM_ENDPOINT` base. */
const MODELS_PATH = "/models"

/** The shape we read off a `GET /v1/models` body. Everything else on the payload
 *  (`object`, `created`, `owned_by`, provider extensions) is ignored — the port
 *  contract is "the ids only". Declared as the MINIMUM we depend on so an
 *  endpoint that returns extra fields is not a parse failure. */
interface ModelsListBody {
  readonly data?: readonly { readonly id?: unknown }[]
}

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

  /**
   * `LLMPort.listModels` — the model ids THIS key may run, from `GET /v1/models`
   * on the SAME base URL and through the SAME (possibly guarded) `fetchImpl` the
   * Responses stream uses. This surface — not chat-completions — is what a plain
   * `OPENAI_API_KEY` session actually boots (`factory#resolveOpenAISurface`
   * returns `responses` for the default/absent base URL), so WITHOUT a probe here
   * `/model` on a BYOK-OpenAI session could only ever offer the boot model plus
   * `QUANTA_RETRY_MODELS`.
   *
   * Reuses the adapter's own transport deliberately: an operator-configured
   * endpoint's baseURL, its SSRF-guarded fetch and its endpoint-scoped key all
   * govern the probe exactly as they govern the turn wire. A second fetch path
   * here would have egressed the probe to the public vendor endpoint.
   *
   * Throws a typed {@link LLMError} per the port contract — a transport fault
   * (classified by {@link responsesStatusToKind} for a non-OK status, so a 401
   * reads as `auth` and a 429 as `rate_limit`) and an unreadable/mis-shaped body
   * both REJECT rather than resolve to `[]`: "we could not ask" and "this account
   * has no models" are different facts, and the caller
   * (`model-catalog.ts#probeCatalog`) already degrades a rejection to "no catalog"
   * while logging it. Non-string / missing ids inside a well-formed array are
   * skipped (one junk entry must not lose the whole catalog).
   */
  async listModels(): Promise<readonly string[]> {
    const url = `${this.baseURL}${MODELS_PATH}`
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${this.apiKey}` },
      })
    } catch (e) {
      // Network/DNS/abort/guard-refusal — same classification the turn wire uses.
      throw LLMError.fromSdkError("openai", e)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      throw new LLMError(
        `openai models probe failed: ${res.status} ${res.statusText}` +
          (detail !== "" ? ` — ${detail.slice(0, 200)}` : ""),
        {
          kind: responsesStatusToKind(res.status),
          statusCode: res.status,
          provider: "openai",
        },
      )
    }
    let body: ModelsListBody
    try {
      body = (await res.json()) as ModelsListBody
    } catch (e) {
      throw LLMError.fromSdkError("openai", e)
    }
    if (!Array.isArray(body.data)) {
      throw new LLMError("openai models probe returned no `data` array", {
        kind: "bad_request",
        provider: "openai",
      })
    }
    return body.data
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === "string" && id !== "")
  }
}
