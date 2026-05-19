import Anthropic from "@anthropic-ai/sdk"
import { LLMError } from "@/shared/errors"
import type { LLMPort } from "../ports"
import type { ContentBlock, Message, StreamEvent, StreamInput, SystemPromptInput } from "../types"

interface AnthropicConfig {
  apiKey: string
  model: string
  maxTokens?: number
}

/** Minimal structural views of the raw SSE events we consume. The SDK's own
 *  union types churn between versions; narrowing on `type` is stable. */
export type RawEvent =
  | { type: "content_block_start"; index: number; content_block: RawBlock }
  | { type: "content_block_delta"; index: number; delta: RawDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: string | null }; usage?: RawDeltaUsage }
  | { type: "message_stop" }
  | { type: "message_start"; message?: RawMessageStart }
  | { type: "ping" }

/** `message_start` carries the prompt-side token counts and the resolved model.
 *  `cache_read_input_tokens` is present only when prompt caching hit. */
export interface RawStartUsage {
  input_tokens: number
  cache_read_input_tokens?: number
}

export interface RawMessageStart {
  model?: string
  usage?: RawStartUsage
}

/** `message_delta` carries the (cumulative) completion-side token count. */
export interface RawDeltaUsage {
  output_tokens: number
}

/** Token usage accumulated across the Messages stream. Threaded through
 *  `mapRawEvent` like the open-slots map so a single `usage` StreamEvent can be
 *  emitted at the terminal `message_stop`. */
export interface UsageAccumulator {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  model?: string
}

export type RawBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string }
  | { type: "thinking" }

export type RawDelta =
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

/** Map our system input to Anthropic's `system` param. A plain string passes
 *  through verbatim (legacy behavior). Block form becomes structured text
 *  params; the block flagged `cache:true` gets an ephemeral `cache_control`
 *  breakpoint so the static prefix is cached across turns. */
const toAnthropicSystem = (system: SystemPromptInput): string | Anthropic.TextBlockParam[] => {
  if (typeof system === "string") return system
  return system.map((b) => ({
    type: "text",
    text: b.text,
    ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
  }))
}

/** Mark the final content block of the last message with an ephemeral
 *  `cache_control` breakpoint, caching the whole conversation prefix (static
 *  system + prior turns) up to the per-turn tail. Mutates a shallow copy. */
const cacheConversationPrefix = (messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] => {
  if (messages.length === 0) return messages
  const lastIdx = messages.length - 1
  const last = messages[lastIdx] as Anthropic.MessageParam
  if (typeof last.content === "string" || last.content.length === 0) return messages
  const blocks = [...last.content]
  const tailIdx = blocks.length - 1
  blocks[tailIdx] = {
    ...(blocks[tailIdx] as Anthropic.ContentBlockParam),
    cache_control: { type: "ephemeral" },
  } as Anthropic.ContentBlockParam
  const out = [...messages]
  out[lastIdx] = { ...last, content: blocks }
  return out
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
        ...(input.system ? { system: toAnthropicSystem(input.system) } : {}),
        ...(input.thinking ? { thinking: input.thinking } : {}),
        messages: cacheConversationPrefix(toAnthropicMessages(input.messages)),
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

    const usage: UsageAccumulator = { model: this.model }

    const raw = await this.openRawStream(input)

    try {
      for await (const ev of raw) {
        yield* mapRawEvent(ev, open, usage)
      }
    } catch (e) {
      if (e instanceof LLMError) throw e
      throw new LLMError(`Anthropic stream error: ${(e as Error).message}`, { cause: e })
    }
  }
}

export type OpenSlots = Map<
  number,
  { kind: "tool_use" | "text" | "thinking"; id: string; json: string }
>

/** Build the additive usage StreamEvent from the accumulated counts. Returns
 *  `null` when neither side reported tokens (absent usage is valid — never
 *  emit zeros). `cacheReadTokens` is included only when the provider reported
 *  a cache hit (exactOptionalPropertyTypes: conditional spread, not undefined). */
const buildUsageEvent = (usage: UsageAccumulator): StreamEvent | null => {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return null
  return {
    type: "usage",
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    model: usage.model ?? "",
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
  }
}

/** Fold the prompt-side counts and resolved model from `message_start` into
 *  the accumulator (pure mutation, emits nothing). */
const absorbMessageStart = (m: RawMessageStart | undefined, usage: UsageAccumulator): void => {
  if (m?.model) usage.model = m.model
  if (!m?.usage) return
  usage.inputTokens = m.usage.input_tokens
  if (m.usage.cache_read_input_tokens !== undefined) {
    usage.cacheReadTokens = m.usage.cache_read_input_tokens
  }
}

/** Terminal `message_delta`: fold the completion count, then emit the usage
 *  event (if any tokens were seen) immediately before `message_stop`. */
function* finishOnMessageDelta(
  ev: Extract<RawEvent, { type: "message_delta" }>,
  usage: UsageAccumulator,
): Generator<StreamEvent> {
  if (ev.usage) usage.outputTokens = ev.usage.output_tokens
  if (!ev.delta.stop_reason) return
  const usageEvent = buildUsageEvent(usage)
  if (usageEvent) yield usageEvent
  yield { type: "message_stop", stop_reason: ev.delta.stop_reason }
}

export function* mapRawEvent(
  ev: RawEvent,
  open: OpenSlots,
  usage: UsageAccumulator = {},
): Generator<StreamEvent> {
  switch (ev.type) {
    case "message_start":
      absorbMessageStart(ev.message, usage)
      break
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
      yield* finishOnMessageDelta(ev, usage)
      break
  }
}

export const finalizeToolInput = (json: string, id: string): unknown => {
  if (!json.trim()) return {}
  try {
    return JSON.parse(json)
  } catch {
    throw new LLMError(`Malformed tool input JSON for ${id}`)
  }
}
