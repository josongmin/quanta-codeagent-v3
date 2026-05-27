import type { LLMPort } from "../ports"
import { defaultResponsesContinuationStore, type ResponsesContinuationStore } from "../responses-continuation-store"
import { prepareResponsesContinuationRequest, streamResponsesSurface, type ResponsesFetchLike } from "../responses-stream"
import type { StreamEvent, StreamInput } from "../types"
import { resolveAdapterStreamTimeouts, type AdapterStreamTimeoutConfig } from "./shared"

interface OpenAIResponsesConfig extends AdapterStreamTimeoutConfig {
  apiKey: string
  model: string
  maxTokens?: number
  baseURL?: string
  fetchImpl?: ResponsesFetchLike
  continuationStore?: ResponsesContinuationStore
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

  constructor(config: OpenAIResponsesConfig) {
    this.apiKey = config.apiKey
    this.model = config.model
    this.baseURL = (config.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "")
    this.fetchImpl = config.fetchImpl ?? fetch
    this.maxTokens = config.maxTokens ?? 8192
    this.streamTimeoutMs = resolveAdapterStreamTimeouts(config)
    this.continuationStore =
      config.continuationStore ?? defaultResponsesContinuationStore()
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const continuationStore = input.responsesContinuation?.store ?? this.continuationStore
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
    })
  }
}
