import type { StreamEvent, StreamInput } from "./types"

export interface LLMPort {
  /** The configured model id (e.g. `claude-sonnet-4-6`, `gpt-4o`). Real
   *  adapters expose it so the loop can emit a faithful pre-stream
   *  `llm_request` (RFC-0002 §5.2/§9) without probing private fields.
   *  Optional: lightweight test doubles may omit it (loop falls back to
   *  `"unknown"`), so adding this never breaks an existing `LLMPort`. */
  readonly model?: string
  /** Streams a single assistant turn. The caller reconstructs the assistant
   *  message from the emitted events (see {@link assembleMessage}). */
  stream(input: StreamInput): AsyncIterable<StreamEvent>
}
