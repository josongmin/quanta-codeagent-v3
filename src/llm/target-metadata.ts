import type { LlmTransportId, PromptCacheRetention } from "@/shared/llm-route-types"

export type {
  LlmSurfaceId,
  LlmTransportId,
  PromptCacheRetention,
  ResponsesContinuationMode,
  ResponsesContinuationObservation,
  ResponsesContinuationPhase,
  ResponsesContinuationReason,
} from "@/shared/llm-route-types"

/** Surface-local continuation checkpoint emitted by the Responses wire when
 *  the server returns a response id. Core transcript correctness does NOT
 *  depend on this object; it is an optional optimization handle a caller may
 *  persist for a later opportunistic resume. */
export interface ResponsesCheckpoint {
  readonly type: "openai-responses"
  readonly model: string
  readonly surfaceId: "openai-responses"
  readonly transportId: LlmTransportId
  readonly responseId: string
  readonly promptCacheKey?: string
  readonly promptCacheRetention?: PromptCacheRetention
}

export type LlmCheckpoint = ResponsesCheckpoint
