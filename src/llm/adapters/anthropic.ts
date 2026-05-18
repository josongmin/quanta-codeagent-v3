import Anthropic from "@anthropic-ai/sdk"
import { LLMError } from "@/shared/errors"
import type { LLMPort } from "../ports"
import type { ContentBlock, Message, StreamEvent, StreamInput } from "../types"

interface AnthropicConfig {
  apiKey: string
  model: string
  maxTokens?: number
}

/** Minimal structural views of the raw SSE events we consume. The SDK's own
 *  union types churn between versions; narrowing on `type` is stable. */
type RawEvent =
  | { type: "content_block_start"; index: number; content_block: RawBlock }
  | { type: "content_block_delta"; index: number; delta: RawDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: string | null } }
  | { type: "message_stop" }
  | { type: "message_start" }
  | { type: "ping" }

type RawBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string }
  | { type: "thinking" }

type RawDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string }

const toAnthropicContent = (block: ContentBlock): Anthropic.ContentBlockParam | null => {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text }
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input }
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error ? { is_error: true } : {}),
      }
    case "thinking":
      // Phase 1 runs with thinking disabled; drop any stale thinking blocks
      // rather than fail on the missing signature the API requires on input.
      return null
  }
}

const toAnthropicMessages = (messages: Message[]): Anthropic.MessageParam[] =>
  messages.map((m) => ({
    role: m.role,
    content: m.content
      .map(toAnthropicContent)
      .filter((b): b is Anthropic.ContentBlockParam => b !== null),
  }))

export class AnthropicAdapter implements LLMPort {
  private readonly client: Anthropic
  private readonly model: string
  private readonly maxTokens: number

  constructor(config: AnthropicConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey })
    this.model = config.model
    this.maxTokens = config.maxTokens ?? 8192
  }

  private async openRawStream(input: StreamInput): Promise<AsyncIterable<RawEvent>> {
    try {
      return (await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        stream: true,
        ...(input.system ? { system: input.system } : {}),
        ...(input.thinking ? { thinking: input.thinking } : {}),
        messages: toAnthropicMessages(input.messages),
        tools: input.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool.InputSchema,
        })),
      })) as unknown as AsyncIterable<RawEvent>
    } catch (e) {
      throw new LLMError(`Anthropic request failed: ${(e as Error).message}`, { cause: e })
    }
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    // index -> block kind, so we know whether content_block_stop closes a tool.
    const open = new Map<
      number,
      { kind: "tool_use" | "text" | "thinking"; id: string; json: string }
    >()

    const raw = await this.openRawStream(input)

    try {
      for await (const ev of raw) {
        yield* mapRawEvent(ev, open)
      }
    } catch (e) {
      if (e instanceof LLMError) throw e
      throw new LLMError(`Anthropic stream error: ${(e as Error).message}`, { cause: e })
    }
  }
}

type OpenSlots = Map<number, { kind: "tool_use" | "text" | "thinking"; id: string; json: string }>

function* mapRawEvent(ev: RawEvent, open: OpenSlots): Generator<StreamEvent> {
  switch (ev.type) {
    case "content_block_start": {
      const b = ev.content_block
      if (b.type === "tool_use") {
        open.set(ev.index, { kind: "tool_use", id: b.id, json: "" })
        yield { type: "tool_use_start", id: b.id, name: b.name }
      } else {
        open.set(ev.index, { kind: b.type, id: "", json: "" })
      }
      break
    }
    case "content_block_delta": {
      const d = ev.delta
      if (d.type === "text_delta") {
        yield { type: "text_delta", delta: d.text }
      } else if (d.type === "input_json_delta") {
        const slot = open.get(ev.index)
        if (slot) {
          slot.json += d.partial_json
          yield { type: "tool_use_delta", id: slot.id, delta: d.partial_json }
        }
      }
      break
    }
    case "content_block_stop": {
      const slot = open.get(ev.index)
      if (slot?.kind === "tool_use") {
        yield { type: "tool_use_end", id: slot.id, input: finalizeToolInput(slot.json, slot.id) }
      }
      open.delete(ev.index)
      break
    }
    case "message_delta":
      if (ev.delta.stop_reason) {
        yield { type: "message_stop", stop_reason: ev.delta.stop_reason }
      }
      break
  }
}

const finalizeToolInput = (json: string, id: string): unknown => {
  if (!json.trim()) return {}
  try {
    return JSON.parse(json)
  } catch {
    throw new LLMError(`Malformed tool input JSON for ${id}`)
  }
}
