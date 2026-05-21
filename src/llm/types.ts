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

export interface StreamInput {
  messages: Message[]
  system?: SystemPromptInput
  tools: ToolSchema[]
  thinking?: { type: "enabled"; budget_tokens: number }
}
