import type { StreamEvent, StreamInput } from "./types"

export interface LLMPort {
  /** The configured model id (e.g. `claude-sonnet-4-6`, `gpt-4o`). Real
   *  adapters expose it so the loop can emit a faithful pre-stream
   *  `llm_request` (RFC-0002 §5.2/§9) without probing private fields.
   *  Optional: lightweight test doubles may omit it (loop falls back to
   *  `"unknown"`), so adding this never breaks an existing `LLMPort`. */
  readonly model?: string
  /** Optional provider id (`anthropic` / `openai` / `chatgpt-oauth`).
   *  Real adapters expose it so the loop's pre-stream `llm_request` marker
   *  can carry it through to the renderer, which paints an unambiguous
   *  auth-mode badge alongside the model. Lightweight test doubles may
   *  omit it; the renderer just paints the model when absent. */
  readonly provider?: string
  /** Optional human-readable auth-mode label
   *  (`"ChatGPT subscription"` / `"OpenAI BYOK"` / `"Anthropic BYOK"`).
   *  Same emission rules as {@link provider}. */
  readonly authMode?: string
  /** Streams a single assistant turn. The caller reconstructs the assistant
   *  message from the emitted events (see {@link assembleMessage}). */
  stream(input: StreamInput): AsyncIterable<StreamEvent>
}
