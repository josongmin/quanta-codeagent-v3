import type { StreamEvent, StreamInput } from "./types"

export interface LLMPort {
  /** Streams a single assistant turn. The caller reconstructs the assistant
   *  message from the emitted events (see {@link assembleMessage}). */
  stream(input: StreamInput): AsyncIterable<StreamEvent>
}
