import { isDeepStrictEqual } from "node:util"
import { dispatchNoThrow, LLMError } from "@/shared"
import type { LLMProvider } from "@/shared/errors"
import { parseToolInputOrThrow } from "./adapters/shared"
import type { LlmCheckpoint, PromptCacheRetention, ResponsesCheckpoint } from "./target-metadata"
import type { Message, StreamEvent, StreamInput, SystemPromptInput, ToolChoice, ToolSchema } from "./types"

export interface ResponsesInputItem {
  readonly type: string
  readonly [k: string]: unknown
}

interface SSEEvent {
  readonly event?: string
  readonly data: string
}

interface ResponsesEvent {
  readonly type?: string
  readonly delta?: string
  readonly item?: {
    type?: string
    id?: string
    role?: string
    status?: string
    call_id?: string
    name?: string
    arguments?: string | Record<string, unknown>
    content?: unknown
  }
  readonly response?: {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cached_input_tokens?: number
      input_tokens_details?: { cached_tokens?: number }
      output_tokens_details?: { reasoning_tokens?: number }
    }
    // `response.failed` carries a provider error payload; `response.incomplete`
    // carries a structured `incomplete_details.reason` (e.g. "max_output_tokens"
    // / "content_filter"). Both are read at the failure/incomplete arms so a
    // provider failure surfaces (throw) and an incomplete maps onto the
    // canonical stop-reason vocabulary instead of a flat "incomplete".
    error?: unknown
    incomplete_details?: { reason?: string }
  }
  readonly item_id?: string
}

export interface ResponsesCompletionMeta {
  readonly responseId?: string
  readonly model?: string
  readonly usage?: {
    readonly input: number
    readonly output: number
    readonly cached?: number
    readonly reasoning?: number
  }
}

export interface ResponsesOutputItemDone {
  readonly rawType: string
  readonly normalized: ResponsesInputItem | null
}

export interface ParseResponsesEventsOptions {
  readonly provider: LLMProvider
  readonly fallbackModel: string
  readonly onChunk?: () => void
  readonly onCompleted?: (meta: ResponsesCompletionMeta) => void
  readonly onOutputItemDone?: (item: ResponsesOutputItemDone) => void
  readonly onReasoning?: () => void
}

export interface BuildResponsesBodyOptions {
  readonly inputItems?: readonly ResponsesInputItem[]
  readonly previousResponseId?: string
  readonly maxOutputTokens?: number
  readonly store?: boolean
  /** OpenAI `service_tier` (e.g. `"priority"`, `"flex"`). Env-derived
   *  (`QUANTA_SERVICE_TIER` / `QUANTA_FAST`) but resolved at the composition
   *  root and threaded in as plain config — this wire never reads process.env
   *  (slice-boundary invariant). Omitted ⇒ no `service_tier` field (default). */
  readonly serviceTier?: string
  /** Reasoning effort (`"minimal" | "low" | "medium" | "high"`). Env-derived
   *  (`QUANTA_REASONING_EFFORT`) but resolved at the composition root and passed
   *  in. Omitted ⇒ no `reasoning` field (default). */
  readonly reasoningEffort?: string
}

const DEFAULT_INSTRUCTIONS = "You are a helpful assistant."

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object"

// L6 H1 / cross-cutting theme 2: every best-effort host callback in this wire
// (`onChunk` / `onReasoning` / `onOutputItemDone` / `onCompleted`) routes
// through the shared no-throw dispatcher. Previously only `onChunk` was
// wrapped; a throwing checkpoint/observability sink on any of the others
// propagated out of `parseResponsesEvents`, corrupting the toolCalls map and
// leaving the continuation store stale. The dispatcher is the ONE owner so a
// newly-added host callback can't silently forget the guard.
const notifyChunkArrival = (onChunk: (() => void) | undefined): void => {
  dispatchNoThrow(onChunk)
}

export const flattenResponsesSystem = (system: SystemPromptInput | undefined): string => {
  if (system === undefined) return ""
  if (typeof system === "string") return system
  return system.map((block) => block.text).join("\n\n")
}

const pushPendingMessage = (
  items: ResponsesInputItem[],
  role: Message["role"],
  pendingContent: ResponsesInputItem[],
): void => {
  if (pendingContent.length === 0) return
  items.push({
    type: "message",
    role,
    content: pendingContent.splice(0),
  })
}

export const messageToResponsesItems = (message: Message): ResponsesInputItem[] => {
  const items: ResponsesInputItem[] = []
  const pendingContent: ResponsesInputItem[] = []

  for (const block of message.content) {
    if (block.type === "text") {
      pendingContent.push({
        type: message.role === "assistant" ? "output_text" : "input_text",
        text: block.text,
      })
      continue
    }
    if (block.type === "image" && message.role === "user") {
      pendingContent.push({
        type: "input_image",
        image_url: `data:${block.mediaType};base64,${block.data}`,
      })
      continue
    }
    if (block.type === "tool_use") {
      pushPendingMessage(items, message.role, pendingContent)
      items.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      })
      continue
    }
    if (block.type === "tool_result") {
      pushPendingMessage(items, message.role, pendingContent)
      items.push({
        type: "function_call_output",
        call_id: block.tool_use_id,
        output: block.content,
      })
    }
    // `thinking` blocks are intentionally not serialized onto the Responses
    // input shape. They make the lane non-resumable when observed on output.
  }

  pushPendingMessage(items, message.role, pendingContent)
  return items
}

export const buildResponsesInputItems = (messages: readonly Message[]): ResponsesInputItem[] => {
  const items: ResponsesInputItem[] = []
  for (const message of messages) {
    for (const item of messageToResponsesItems(message)) items.push(item)
  }
  return items
}

const toolsToResponsesShape = (tools: readonly ToolSchema[]): readonly ResponsesInputItem[] =>
  tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  }))

export const toResponsesToolChoice = (
  choice: ToolChoice | undefined,
  toolNames: readonly string[],
): string | { readonly type: "function"; readonly name: string } | undefined => {
  if (choice === undefined) return undefined
  switch (choice.kind) {
    case "auto":
      return undefined
    case "any":
      return "required"
    case "none":
      return "none"
    case "tool":
      if (!toolNames.includes(choice.name)) {
        throw new LLMError(
          `tool_choice references unregistered tool name "${choice.name}" ` +
            `(registered: ${toolNames.length === 0 ? "<none>" : toolNames.join(", ")})`,
        )
      }
      return { type: "function", name: choice.name }
    default: {
      const _exhaustive: never = choice
      return _exhaustive
    }
  }
}

/** Normalize a caller-supplied `service_tier` value. Empty / undefined ⇒
 *  omitted (no `service_tier` field). The composition root is responsible for
 *  deriving this from `QUANTA_SERVICE_TIER` / `QUANTA_FAST` — this wire only
 *  validates the plain value it is handed (no process.env read). */
const normalizeResponsesServiceTier = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined

/** Normalize a caller-supplied reasoning-effort value to the closed
 *  `minimal | low | medium | high` set (case-insensitive). Anything else ⇒
 *  omitted. Env derivation (`QUANTA_REASONING_EFFORT`) happens at the
 *  composition root; this wire never reads process.env. */
const normalizeResponsesReasoningEffort = (value: string | undefined): string | undefined => {
  const effort = value?.toLowerCase()
  return effort === "minimal" || effort === "low" || effort === "medium" || effort === "high"
    ? effort
    : undefined
}

export const buildResponsesBody = (
  input: StreamInput,
  model: string,
  options: BuildResponsesBodyOptions = {},
): Record<string, unknown> => {
  const items = [...(options.inputItems ?? buildResponsesInputItems(input.messages))]
  const instructions = (() => {
    const flattened = flattenResponsesSystem(input.system)
    return flattened !== "" ? flattened : DEFAULT_INSTRUCTIONS
  })()
  const serviceTier = normalizeResponsesServiceTier(options.serviceTier)
  const reasoningEffort = normalizeResponsesReasoningEffort(options.reasoningEffort)
  const toolChoice = toResponsesToolChoice(
    input.toolChoice,
    input.tools.map((tool) => tool.name),
  )

  return {
    model,
    instructions,
    input: items,
    stream: true,
    tools: toolsToResponsesShape(input.tools),
    parallel_tool_calls: false,
    store: options.store ?? false,
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(options.previousResponseId !== undefined
      ? { previous_response_id: options.previousResponseId }
      : {}),
    ...(options.maxOutputTokens !== undefined
      ? { max_output_tokens: options.maxOutputTokens }
      : {}),
    ...(input.promptCacheKey !== undefined ? { prompt_cache_key: input.promptCacheKey } : {}),
    ...(input.promptCacheRetention !== undefined
      ? { prompt_cache_retention: input.promptCacheRetention }
      : {}),
    ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
    ...(reasoningEffort !== undefined ? { reasoning: { effort: reasoningEffort } } : {}),
  }
}

export const fingerprintResponsesBody = (body: Record<string, unknown>): string => {
  const {
    input: _input,
    previous_response_id: _previousResponseId,
    ...rest
  } = body as Record<string, unknown>
  return JSON.stringify(rest)
}

export const strictExtensionTail = (
  inputItems: readonly ResponsesInputItem[],
  baseline: readonly ResponsesInputItem[],
): ResponsesInputItem[] | null => {
  if (baseline.length >= inputItems.length) return null
  for (let i = 0; i < baseline.length; i += 1) {
    if (!isDeepStrictEqual(inputItems[i], baseline[i])) return null
  }
  return inputItems.slice(baseline.length)
}

const normalizeMessageOutputItem = (item: Record<string, unknown>): ResponsesInputItem | null => {
  if (item.role !== "assistant" || !Array.isArray(item.content)) return null
  const content: ResponsesInputItem[] = []
  for (const part of item.content) {
    if (!isObject(part) || part.type !== "output_text" || typeof part.text !== "string") return null
    content.push({ type: "output_text", text: part.text })
  }
  return { type: "message", role: "assistant", content }
}

const normalizeFunctionCallArguments = (value: unknown): string | null => {
  if (typeof value === "string") return value
  if (value === undefined) return "{}"
  try {
    const json = JSON.stringify(value)
    return typeof json === "string" ? json : null
  } catch {
    return null
  }
}

const normalizeFunctionCallOutputItem = (
  item: Record<string, unknown>,
): ResponsesInputItem | null => {
  if (typeof item.call_id !== "string" || typeof item.name !== "string") return null
  const argumentsJson = normalizeFunctionCallArguments(item.arguments)
  if (argumentsJson === null) return null
  return {
    type: "function_call",
    call_id: item.call_id,
    name: item.name,
    arguments: argumentsJson,
  }
}

export const normalizeResponsesOutputItem = (item: unknown): ResponsesInputItem | null => {
  if (!isObject(item) || typeof item.type !== "string") return null
  switch (item.type) {
    case "message":
      return normalizeMessageOutputItem(item)
    case "function_call":
      return normalizeFunctionCallOutputItem(item)
    default:
      return null
  }
}

export const parseResponsesSSEEvent = (raw: string): SSEEvent | null => {
  let event: string | undefined
  const dataParts: string[] = []
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) dataParts.push(line.slice(5).replace(/^ /, ""))
  }
  if (dataParts.length === 0) return null
  return event !== undefined ? { event, data: dataParts.join("\n") } : { data: dataParts.join("\n") }
}

export async function* parseResponsesSSEFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf("\n\n")
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = parseResponsesSSEEvent(raw)
        if (event !== null) yield event
        boundary = buffer.indexOf("\n\n")
      }
    }
    if (buffer.trim() !== "") {
      const event = parseResponsesSSEEvent(buffer)
      if (event !== null) yield event
    }
  } finally {
    reader.releaseLock()
  }
}

export async function* parseResponsesEvents(
  frames: AsyncIterable<SSEEvent>,
  opts: ParseResponsesEventsOptions,
): AsyncGenerator<StreamEvent> {
  const toolCalls = new Map<string, { name: string; args: string }>()
  let usage:
    | {
        input: number
        output: number
        cached?: number
        model?: string
      }
    | null = null

  for await (const frame of frames) {
    if (frame.data === "[DONE]") break
    notifyChunkArrival(opts.onChunk)

    let json: unknown
    try {
      json = JSON.parse(frame.data)
    } catch (error) {
      throw LLMError.fromSdkError(opts.provider, error, `${opts.provider} SSE parse error`)
    }
    if (!isObject(json)) continue

    const event = json as ResponsesEvent
    const type = event.type

    if (type === "response.output_text.delta") {
      if (typeof event.delta === "string" && event.delta !== "") {
        yield { type: "text_delta", delta: event.delta }
      }
      continue
    }

    if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning.delta") {
      if (typeof event.delta === "string" && event.delta !== "") {
        yield { type: "thinking_delta", text: event.delta }
      }
      dispatchNoThrow(opts.onReasoning)
      continue
    }

    if (type === "response.output_item.added" && event.item?.type === "function_call") {
      const id = event.item.call_id ?? event.item.id ?? ""
      const name = event.item.name ?? ""
      if (id !== "" && name !== "") {
        toolCalls.set(id, { name, args: "" })
        yield { type: "tool_use_start", id, name }
      }
      continue
    }

    if (type === "response.function_call_arguments.delta") {
      const id = event.item_id ?? ""
      const delta = event.delta ?? ""
      if (id !== "" && delta !== "") {
        const slot = toolCalls.get(id)
        if (slot !== undefined) slot.args += delta
        yield { type: "tool_use_delta", id, delta }
      }
      continue
    }

    if (type === "response.output_item.done") {
      const rawType = event.item?.type ?? ""
      if (rawType === "function_call") {
        const id = event.item?.call_id ?? event.item?.id ?? ""
        const slot = toolCalls.get(id)
        const raw = event.item?.arguments ?? slot?.args ?? "{}"
        const input = parseToolInputOrThrow(
          typeof raw === "string" ? raw : JSON.stringify(raw),
          id,
          opts.provider,
          "with-cause",
        )
        yield { type: "tool_use_end", id, input }
        toolCalls.delete(id)
      }
      if (rawType === "reasoning") dispatchNoThrow(opts.onReasoning)
      dispatchNoThrow(opts.onOutputItemDone, {
        rawType,
        normalized: normalizeResponsesOutputItem(event.item),
      })
      continue
    }

    if (type === "response.completed") {
      const rawUsage = event.response?.usage
      if (rawUsage !== undefined) {
        const cached = rawUsage.cached_input_tokens ?? rawUsage.input_tokens_details?.cached_tokens
        usage = {
          input: rawUsage.input_tokens ?? 0,
          output: rawUsage.output_tokens ?? 0,
          ...(typeof cached === "number" ? { cached } : {}),
          ...(typeof event.response?.model === "string" ? { model: event.response.model } : {}),
        }
        dispatchNoThrow(opts.onCompleted, {
          ...(typeof event.response?.id === "string" && event.response.id !== ""
            ? { responseId: event.response.id }
            : {}),
          ...(typeof event.response?.model === "string" ? { model: event.response.model } : {}),
          usage: {
            input: rawUsage.input_tokens ?? 0,
            output: rawUsage.output_tokens ?? 0,
            ...(typeof cached === "number" ? { cached } : {}),
            ...(typeof rawUsage.output_tokens_details?.reasoning_tokens === "number"
              ? { reasoning: rawUsage.output_tokens_details.reasoning_tokens }
              : {}),
          },
        })
      } else {
        dispatchNoThrow(opts.onCompleted, {
          ...(typeof event.response?.id === "string" && event.response.id !== ""
            ? { responseId: event.response.id }
            : {}),
          ...(typeof event.response?.model === "string" ? { model: event.response.model } : {}),
        })
      }
      continue
    }

    // Provider in-band terminal failure. The Responses stream surfaces the
    // failure as a typed SSE event rather than an HTTP error, so the sibling
    // adapters (openai.ts / anthropic.ts) throw a structured LLMError on the
    // equivalent shape. Mirror that here: a failed response is NOT a completed
    // turn — converting it to `message_stop` silently treated a provider
    // failure as a finished turn (the root-cause defect). Throw so the loop's
    // `classifyLLMError` routes it through the stream-error recovery path.
    if (type === "response.failed") {
      const errPayload = event.response?.error
      const detail =
        errPayload !== undefined ? `: ${JSON.stringify(errPayload)}` : " (no error payload)"
      throw new LLMError(`${opts.provider} response.failed${detail}`, {
        kind: "server_error",
        provider: opts.provider,
      })
    }

    // Incomplete response: the turn stopped early for a structured reason. Read
    // `incomplete_details.reason` and map it onto the canonical stop-reason
    // vocabulary so recovery can act per-reason instead of flattening every
    // early-stop into a single opaque `incomplete` (which the FSM could not
    // classify and would surface/abort indiscriminately). Emit the accumulated
    // usage event BEFORE the early return so token accounting is never dropped
    // on an incomplete turn.
    if (type === "response.incomplete") {
      const reason = event.response?.incomplete_details?.reason
      // `max_output_tokens` → max_tokens (recovery issues a continue nudge).
      // `content_filter` → content_filtered (recovery surfaces it as a
      // terminal refusal). Anything else is drift → surface via "error".
      const stopReason =
        reason === "max_output_tokens"
          ? "max_tokens"
          : reason === "content_filter"
            ? "content_filtered"
            : "error"
      yield* emitUsage(usage, opts.fallbackModel)
      yield { type: "message_stop", stop_reason: stopReason }
      return
    }
  }

  yield* emitUsage(usage, opts.fallbackModel)
  yield { type: "message_stop", stop_reason: "end_turn" }
}

/** Emit the accumulated usage StreamEvent (if any tokens were observed). Shared
 *  by the normal terminal path and the `response.incomplete` early-return so an
 *  early stop never drops token accounting. No-op generator when `usage` is
 *  null (older models / never-completed) so no zero-usage event is emitted. */
type AccumulatedUsage = {
  readonly input: number
  readonly output: number
  readonly cached?: number
  readonly model?: string
}

function* emitUsage(
  usage: AccumulatedUsage | null,
  fallbackModel: string,
): Generator<StreamEvent> {
  if (usage === null) return
  yield {
    type: "usage",
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cached !== undefined ? { cacheReadTokens: usage.cached } : {}),
    model: usage.model ?? fallbackModel,
  }
}

export const emitResponsesCheckpoint = (
  onCheckpoint: ((checkpoint: LlmCheckpoint) => void) | undefined,
  checkpoint: ResponsesCheckpoint,
): void => {
  // L6 H1: best-effort checkpoint sink — route through the shared no-throw
  // dispatcher so a throwing host bookkeeper can never abort the wire.
  dispatchNoThrow(onCheckpoint, checkpoint)
}
