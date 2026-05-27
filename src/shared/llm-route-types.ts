/** Canonical LLM wire surface ids. Orthogonal to vendor/auth transport:
 *  Anthropic can arrive via public API / Bedrock / Vertex / Foundry / Mantle
 *  while still speaking the same Messages grammar; OpenAI can speak either
 *  Chat Completions or Responses. */
export type LlmSurfaceId =
  | "anthropic-messages"
  | "openai-chat-completions"
  | "openai-responses"

/** Canonical transport ids. Pair with `LLMPort.provider` (legacy vendor/auth
 *  badge) and `surfaceId` to recover the full route without overloading one
 *  field with three meanings. */
export type LlmTransportId =
  | "public"
  | "chatgpt-oauth"
  | "bedrock"
  | "vertex"
  | "foundry"
  | "mantle"

/** OpenAI prompt-cache retention policy. Keep the type closed so future wire
 *  widening is explicit at compile time. */
export type PromptCacheRetention = "in-memory" | "24h"

/** OpenAI Responses continuation-routing taxonomy. Shared across the wire,
 *  observer stream, and external protocol surfaces so fallback reasons do not
 *  silently drift across layers. */
export type ResponsesContinuationPhase = "prepare" | "retry"
export type ResponsesContinuationMode = "full" | "resume" | "full_retry"
export type ResponsesContinuationReason =
  | "no_prompt_cache_key"
  | "no_state_store"
  | "resume_disabled"
  | "no_entry"
  | "request_fingerprint_mismatch"
  | "non_resumable"
  | "strict_extension_miss"
  | "prepared_resume"
  | "stale_previous_response"
  | "resume_rejected"

export interface ResponsesContinuationObservation {
  readonly surfaceId: "openai-responses"
  readonly transportId: LlmTransportId
  readonly phase: ResponsesContinuationPhase
  readonly mode: ResponsesContinuationMode
  readonly reason: ResponsesContinuationReason
  readonly statusCode?: number
}
