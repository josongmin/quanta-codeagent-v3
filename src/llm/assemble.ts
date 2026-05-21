import type { ContentBlock, Message, StreamEvent } from "./types"

export interface AssembledTurn {
  message: Message
  stopReason: string
}

/** Reconstruct the assistant message from a stream of {@link StreamEvent}.
 *  Anthropic streams content blocks sequentially (one completes before the
 *  next starts), so we can append by position without interleave tracking. */
export const assembleFromEvents = (events: StreamEvent[]): AssembledTurn => {
  let content: ContentBlock[] = []
  let stopReason = "end_turn"

  for (const ev of events) {
    switch (ev.type) {
      case "stream_reset":
        // Tombstone: the events seen so far are a dead partial. Drop all
        // accumulated content/blocks and stop-reason so the assembled message
        // reflects ONLY the replacement stream that follows.
        content = []
        stopReason = "end_turn"
        break
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
      case "response_in_progress":
        // Heartbeat / "thinking…" indicator (ADR-0048). NOT content; assemblers
        // explicitly skip it so the reconstructed message is byte-identical to
        // a stream that never emitted any heartbeat.
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
