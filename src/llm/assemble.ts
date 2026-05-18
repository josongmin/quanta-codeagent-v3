import type { ContentBlock, Message, StreamEvent } from "./types"

export interface AssembledTurn {
  message: Message
  stopReason: string
}

/** Reconstruct the assistant message from a stream of {@link StreamEvent}.
 *  Anthropic streams content blocks sequentially (one completes before the
 *  next starts), so we can append by position without interleave tracking. */
export const assembleFromEvents = (events: StreamEvent[]): AssembledTurn => {
  const content: ContentBlock[] = []
  let stopReason = "end_turn"

  for (const ev of events) {
    switch (ev.type) {
      case "text_delta": {
        const last = content.at(-1)
        if (last?.type === "text") last.text += ev.delta
        else content.push({ type: "text", text: ev.delta })
        break
      }
      case "tool_use_start":
        content.push({ type: "tool_use", id: ev.id, name: ev.name, input: {} })
        break
      case "tool_use_end": {
        const block = content.find((b) => b.type === "tool_use" && b.id === ev.id)
        if (block?.type === "tool_use") block.input = ev.input
        break
      }
      case "tool_use_delta":
        break
      case "message_stop":
        stopReason = ev.stop_reason
        break
    }
  }

  return { message: { role: "assistant", content }, stopReason }
}

/** True when the assembled turn contains at least one tool call. */
export const hasToolUse = (m: Message): boolean => m.content.some((b) => b.type === "tool_use")
