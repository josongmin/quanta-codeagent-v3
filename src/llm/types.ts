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
  | { type: "text_delta"; delta: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; delta: string }
  | { type: "tool_use_end"; id: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; model: string }
  | { type: "message_stop"; stop_reason: string }

export interface StreamInput {
  messages: Message[]
  system?: SystemPromptInput
  tools: ToolSchema[]
  thinking?: { type: "enabled"; budget_tokens: number }
}
