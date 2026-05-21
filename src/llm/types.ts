export interface Message {
  role: "user" | "assistant"
  content: ContentBlock[]
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
  | { type: "message_stop"; stop_reason: string }
  /** ADR-0048 forward-compat: OpenAI Responses API emits a `response.in_progress`
   *  SSE/WebSocket frame while the model is still generating but has no new
   *  output to surface yet. Codex silently drops this event (their dispatcher
   *  has no branch for it); v3 surfaces it as a first-class StreamEvent so the
   *  UI can render "thinking..." indicators without polling.
   *  The `data` payload is intentionally opaque — schema-on-wire is provider-
   *  controlled and varies across model rollouts. Consumers pick the fields
   *  they care about (e.g. `progress`, `message`). */
  | { type: "response_in_progress"; data: Record<string, unknown> }

export interface StreamInput {
  messages: Message[]
  system?: SystemPromptInput
  tools: ToolSchema[]
  thinking?: { type: "enabled"; budget_tokens: number }
}
