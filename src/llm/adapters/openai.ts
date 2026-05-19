import OpenAI from "openai"
import { LLMError } from "@/shared"
import type { LLMPort } from "../ports"
import type { ContentBlock, Message, StreamEvent, StreamInput, SystemPromptInput } from "../types"

interface OpenAIConfig {
  apiKey: string
  model: string
  maxTokens?: number
  baseURL?: string
}

// OpenAI separates tool results into their own `role:"tool"` messages, so the
// mapping is less direct than Anthropic's. These params mirror only what we send.
export type ChatParam =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "tool"; tool_call_id: string; content: string }
  | {
      role: "assistant"
      content: string | null
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
    }

/** Token usage on the final chunk, present only when the request set
 *  `stream_options:{include_usage:true}`. `cached_tokens` is reported only by
 *  models/endpoints that support prompt caching. */
export interface RawUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
}

export type RawChunk = {
  choices: {
    delta: {
      content?: string | null
      tool_calls?: {
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason: string | null
  }[]
  model?: string
  usage?: RawUsage | null
}

export const STOP_REASON: Record<string, string> = {
  tool_calls: "tool_use",
  stop: "end_turn",
  length: "max_tokens",
}

export const assistantParam = (blocks: ContentBlock[]): ChatParam => {
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
  const toolCalls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) =>
      b.type === "tool_use"
        ? {
            id: b.id,
            type: "function" as const,
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          }
        : null,
    )
    .filter((c): c is NonNullable<typeof c> => c !== null)
  return {
    role: "assistant",
    content: text === "" ? null : text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

export const userParams = (blocks: ContentBlock[]): ChatParam[] => {
  const params: ChatParam[] = []
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
  if (text !== "") params.push({ role: "user", content: text })
  for (const b of blocks) {
    if (b.type === "tool_result") {
      params.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content })
    }
  }
  return params
}

/** Flatten the system input to a single string. OpenAI does automatic prefix
 *  caching with no `cache_control` knob, so the only requirement is that the
 *  rendered prefix be byte-stable across turns: preserve block order and join
 *  deterministically. The `cache` flag is irrelevant here and ignored. */
const flattenSystem = (system: SystemPromptInput): string =>
  typeof system === "string" ? system : system.map((b) => b.text).join("\n\n")

export const toChatMessages = (
  system: SystemPromptInput | undefined,
  messages: Message[],
): ChatParam[] => {
  const out: ChatParam[] = []
  if (system !== undefined) {
    const content = flattenSystem(system)
    if (content !== "") out.push({ role: "system", content })
  }
  for (const m of messages) {
    if (m.role === "assistant") out.push(assistantParam(m.content))
    else out.push(...userParams(m.content))
  }
  return out
}

export interface PendingCall {
  id: string
  name: string
  args: string
  started: boolean
}

/** Map one streamed chunk's tool_call deltas, emitting start/delta events and
 *  accumulating into `pending` (keyed by OpenAI's stable `index`). */
type RawToolCall = NonNullable<RawChunk["choices"][number]["delta"]["tool_calls"]>[number]

function* mapOneToolCall(
  c: RawToolCall,
  pending: Map<number, PendingCall>,
): Generator<StreamEvent> {
  let slot = pending.get(c.index)
  if (!slot) {
    slot = { id: c.id ?? "", name: c.function?.name ?? "", args: "", started: false }
    pending.set(c.index, slot)
  }
  if (c.id) slot.id = c.id
  if (c.function?.name) slot.name = c.function.name
  if (!slot.started && slot.id && slot.name) {
    slot.started = true
    yield { type: "tool_use_start", id: slot.id, name: slot.name }
  }
  const frag = c.function?.arguments
  if (frag) {
    slot.args += frag
    if (slot.started) yield { type: "tool_use_delta", id: slot.id, delta: frag }
  }
}

export function* mapToolCallDeltas(
  chunk: RawChunk,
  pending: Map<number, PendingCall>,
): Generator<StreamEvent> {
  const calls = chunk.choices[0]?.delta.tool_calls
  if (!calls) return
  for (const c of calls) yield* mapOneToolCall(c, pending)
}

export function* finalizeCalls(pending: Map<number, PendingCall>): Generator<StreamEvent> {
  for (const slot of [...pending.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) {
    let input: unknown = {}
    if (slot.args.trim()) {
      try {
        input = JSON.parse(slot.args)
      } catch {
        throw new LLMError(`Malformed tool input JSON for ${slot.id}`)
      }
    }
    yield { type: "tool_use_end", id: slot.id, input }
  }
}

export class OpenAIAdapter implements LLMPort {
  private readonly client: OpenAI
  private readonly model: string
  private readonly maxTokens: number

  constructor(config: OpenAIConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    })
    this.model = config.model
    this.maxTokens = config.maxTokens ?? 8192
  }

  private async openRawStream(input: StreamInput): Promise<AsyncIterable<RawChunk>> {
    try {
      return (await this.client.chat.completions.create({
        model: this.model,
        max_tokens: this.maxTokens,
        stream: true,
        // Opt into the trailing usage chunk (RFC-0002 §5.3). Older models that
        // don't support it simply omit the chunk — we then emit no usage.
        stream_options: { include_usage: true },
        messages: toChatMessages(input.system, input.messages),
        tools: input.tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        })),
      })) as unknown as AsyncIterable<RawChunk>
    } catch (e) {
      throw new LLMError(`OpenAI request failed: ${(e as Error).message}`, { cause: e })
    }
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const raw = await this.openRawStream(input)
    const pending = new Map<number, PendingCall>()
    let finish: string | null = null

    try {
      for await (const chunk of raw) {
        const choice = chunk.choices[0]
        if (!choice) continue
        const content = choice.delta.content
        if (content) yield { type: "text_delta", delta: content }
        yield* mapToolCallDeltas(chunk, pending)
        if (choice.finish_reason) finish = choice.finish_reason
      }
    } catch (e) {
      if (e instanceof LLMError) throw e
      throw new LLMError(`OpenAI stream error: ${(e as Error).message}`, { cause: e })
    }

    yield* finalizeCalls(pending)
    yield {
      type: "message_stop",
      stop_reason: finish ? (STOP_REASON[finish] ?? finish) : "end_turn",
    }
  }
}
