export interface Message {
  role: "user" | "assistant"
  content: ContentBlock[]
  /**
   * Optional stable id for message-granularity rewind UX (Claude Desktop
   * 1.7196.3 parity). Absent on legacy sessions and on freshly-built
   * Messages — `assignMessageIds` mints ids for new sessions; old sessions
   * remain id-less to preserve the byte-identical default-OFF posture.
   * Never sent to the LLM adapters: producers MUST strip / ignore it when
   * shaping `StreamInput`.
   */
  id?: string
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock

export interface TextBlock {
  type: "text"
  text: string
}

export interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: unknown
}

export interface ToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string
  is_error?: boolean
}

export interface ThinkingBlock {
  type: "thinking"
  thinking: string
  /** Anthropic extended-thinking cryptographic signature (ADR-0076 Gap-2).
   *  The Messages API REQUIRES this back verbatim on the input side when a
   *  prior-turn thinking block is re-sent in a multi-turn conversation — a
   *  missing signature causes a 400 and breaks the thinking carry-over chain.
   *  Accumulated from `signature_delta` StreamEvents during assembly and
   *  serialized straight back by the adapter. Absent for OpenAI reasoning
   *  (opaque, no client-visible signature) and absent when extended-thinking
   *  was never enabled (byte-identical to pre-feature ThinkingBlocks). */
  signature?: string
  /** TRUE when the provider returned an encrypted / redacted reasoning block
   *  (Anthropic `redacted_thinking`). The `thinking` field then holds the
   *  opaque ciphertext rather than human-readable reasoning; we preserve it
   *  verbatim so it can be carried back to the provider unmodified. Absent
   *  ⇒ ordinary plaintext thinking. */
  redacted?: true
}

/** JSON-schema description of a tool, as sent to the model. */
export interface ToolSchema {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** One static span of the system prompt. `cache: true` marks the prefix
 *  breakpoint: everything up to and including this block is byte-stable
 *  across turns and is the provider cache boundary. */
export interface SystemBlock {
  type: "text"
  text: string
  cache?: boolean
}

/** System prompt as either a plain string (legacy, still accepted) or an
 *  ordered list of static blocks. Adapters must treat the block order as
 *  significant and stable so the cached prefix never shifts. */
export type SystemPromptInput = string | SystemBlock[]

export type StreamEvent =
  /** Tombstone: every event yielded so far in this turn belongs to a now-dead
   *  partial (e.g. a provider died mid-stream and {@link FallbackLLM} switched
   *  to a backup). A consumer assembling a message MUST discard everything it
   *  has accumulated and start fresh from the next event. Emitted as the first
   *  event of the replacement stream; never emitted before any other event. */
  | { type: "stream_reset" }
  | { type: "text_delta"; delta: string }
  /** Extended-thinking / reasoning content delta (ADR-0076 Gap-2). Emitted
   *  ONLY when a thinking budget is active (Anthropic `thinking:{enabled}`) or
   *  a reasoning model streams a summary (OpenAI). Consecutive deltas for the
   *  same logical thinking block accumulate, in stream order, into the leading
   *  {@link ThinkingBlock} of the assembled assistant message. `redacted:true`
   *  marks an opaque encrypted reasoning block whose `text` is ciphertext to be
   *  preserved verbatim, not human-readable. With NO thinking budget set, zero
   *  of these are emitted, so the assembled message is byte-identical to the
   *  pre-feature path. */
  | { type: "thinking_delta"; text: string; redacted?: true }
  /** Anthropic extended-thinking signature delta (ADR-0076 Gap-2). The provider
   *  streams the cryptographic signature for the just-completed thinking block;
   *  deltas accumulate into {@link ThinkingBlock.signature}. The signature is
   *  REQUIRED back on the input side for multi-turn carry-over. OpenAI reasoning
   *  has no client-visible signature and emits none of these. */
  | { type: "signature_delta"; signature: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; delta: string }
  | { type: "tool_use_end"; id: string; input: unknown }
  | {
      type: "usage"
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      model: string
    }
  /** Heartbeat: provider is still "thinking" — no new content yet. Surfaced
   *  ONLY by adapters that decode an OpenAI Responses API `response.in_progress`
   *  event (see ADR-0048). Carries an optional human-readable `message`,
   *  an optional `progress` ratio (0..1), and the provider-side `createdAt`
   *  timestamp when present, so a UI can render a "thinking…" indicator
   *  without losing any other in-flight state. Assemblers must IGNORE this
   *  event when reconstructing the final message: it is non-cumulative
   *  signal, not content. */
  | {
      type: "response_in_progress"
      message?: string
      progress?: number
      createdAt?: number
    }
  | { type: "message_stop"; stop_reason: string }

/**
 * ADR-0079 — pre-call tool_choice control (orthogonal to admissibility, which
 * gates the post-call result). Closed discriminated union; adapters map 1:1 to
 * provider-specific shapes. The default-OFF posture is `{kind:"auto"}` (or
 * field absent) — adapters MUST emit a byte-identical wire payload to the
 * pre-feature path in that case. Defined here (not imported from `@/agent`)
 * because `llm/` is a lower layer and must not depend on `agent/`. The
 * `agent/tool-choice.ts` ToolChoice type is structurally identical and the
 * call sites cast freely between them.
 */
export type ToolChoice =
  | { readonly kind: "auto" }
  | { readonly kind: "any" }
  | { readonly kind: "none" }
  | { readonly kind: "tool"; readonly name: string }

export interface StreamInput {
  messages: Message[]
  system?: SystemPromptInput
  tools: ToolSchema[]
  thinking?: { type: "enabled"; budget_tokens: number }
  /** ADR-0079 — optional pre-call gate. Absent (or `{kind:"auto"}`) ⇒ adapters
   *  emit the byte-identical pre-feature wire payload. `{kind:"tool",name}` with
   *  a name that doesn't match any entry in `tools` throws at the adapter (NOT
   *  a silent fallback). */
  toolChoice?: ToolChoice
}
