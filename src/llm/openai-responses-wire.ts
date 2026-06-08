import { isDeepStrictEqual } from "node:util"
import { dispatchNoThrow, LLMError } from "@/shared"
import type { LLMProvider } from "@/shared/errors"
import { parseToolInputOrThrow } from "./adapters/shared"
import type { LlmCheckpoint, PromptCacheRetention, ResponsesCheckpoint } from "./target-metadata"
import type {
  Message,
  StreamEvent,
  StreamInput,
  SystemPromptInput,
  ToolChoice,
  ToolSchema,
} from "./types"

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
  /**
   * H15 — the captured, re-emittable reasoning INPUT item for a reasoning
   * output item carrying `encrypted_content`. Present ONLY when
   * {@link ParseResponsesEventsOptions.reasoningCarryover} is on AND the item
   * normalized to a non-null reasoning shape. Absent (undefined) on every
   * non-reasoning item, when carry-over is off, or when the reasoning item
   * carried no usable `encrypted_content` (safe-skip). The host persists this
   * verbatim and re-feeds it on the next turn's input.
   */
  readonly reasoningItem?: ResponsesInputItem
}

export interface ParseResponsesEventsOptions {
  readonly provider: LLMProvider
  readonly fallbackModel: string
  readonly onChunk?: () => void
  readonly onCompleted?: (meta: ResponsesCompletionMeta) => void
  readonly onOutputItemDone?: (item: ResponsesOutputItemDone) => void
  readonly onReasoning?: () => void
  /**
   * H15 reasoning carry-over capture gate (`QUANTA_REASONING_CARRYOVER`,
   * OpenAI-Responses ONLY). Resolved at the composition root — this wire only
   * reads the plain boolean it is handed (slice-boundary invariant: no
   * process.env read).
   *
   * Default-OFF semantics (BYTE-IDENTICAL): when `false`/omitted the
   * `response.output_item.done` reasoning arm behaves EXACTLY as today — it
   * fires `onReasoning` (resumable ⇒ false) and `normalizeResponsesOutputItem`
   * returns `null` for a reasoning item (dropped). NO `encrypted_content` is
   * captured, NO new callback fires.
   *
   * When `true`: a reasoning output item that carries `encrypted_content` is
   * normalized into a re-emittable input reasoning item and surfaced on
   * {@link ResponsesOutputItemDone.reasoningItem} so the host can persist it
   * for the next turn (ZDR-compatible: the body is opaque, never decoded
   * locally).
   */
  readonly reasoningCarryover?: boolean
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
  /** Reasoning effort (`"minimal" | "low" | "medium" | "high" | "xhigh"`).
   *  Env-derived (`QUANTA_REASONING_EFFORT`) but resolved at the composition
   *  root and passed in. Omitted ⇒ no `effort` inside `reasoning` (default). */
  readonly reasoningEffort?: string
  /** Reasoning-summary request (`QUANTA_REASONING_SUMMARY`, bool). When true,
   *  `reasoning.summary: "auto"` is added so the model streams a human-readable
   *  reasoning summary (`response.reasoning_summary_text.delta` — already mapped
   *  to `thinking_delta`). STANDALONE: the `reasoning` object is emitted when
   *  EITHER an effort OR summary is requested, so summary works even with no
   *  effort knob. Default-OFF ⇒ no `summary` key (byte-identical). */
  readonly reasoningSummary?: boolean
  /** Reasoning output verbosity (`QUANTA_REASONING_VERBOSITY`,
   *  `"low" | "medium" | "high"`). The wire shape is `text: { verbosity }` — a
   *  TOP-LEVEL sibling of `reasoning`/`input`, NOT a flat `verbosity` key (which
   *  the API silently ignores). Omitted / out-of-set ⇒ no `text` field, so the
   *  API resolves its own default verbosity (no default pinned here). */
  readonly reasoningVerbosity?: string
  /**
   * H15 reasoning carry-over re-emit gate (`QUANTA_REASONING_CARRYOVER`,
   * OpenAI-Responses ONLY). Resolved at the composition root and threaded in as
   * a plain boolean. Default-OFF ⇒ BYTE-IDENTICAL: NO `include` field is added,
   * NO prior reasoning items are prepended (today's body verbatim).
   *
   * When `true` AND {@link priorReasoningItems} is non-empty: the prior
   * reasoning input items are PREPENDED to `input` (Codex order: reasoning
   * items lead the turn they precede) and `include: ["reasoning.encrypted_content"]`
   * is added so the API echoes encrypted reasoning back on the response.
   * `store` stays `false` (ZDR round-trip — the encrypted body is opaque).
   */
  readonly reasoningCarryover?: boolean
  /**
   * H15 — prior turns' captured reasoning INPUT items, to re-emit at the head
   * of this turn's `input`. Only consulted when {@link reasoningCarryover} is
   * `true`. Empty/omitted ⇒ no re-emit (and no `include`, so the body is
   * byte-identical to off even with the gate on — the gate alone adds nothing
   * without captured items). Each entry is the opaque shape produced by
   * {@link normalizeResponsesReasoningItem}.
   */
  readonly priorReasoningItems?: readonly ResponsesInputItem[]
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
 *  `minimal | low | medium | high | xhigh` set (case-insensitive). Anything
 *  else ⇒ omitted. `xhigh` is a forward-compat extra-effort tier some Responses
 *  models expose; it is an opaque pass-through here — this normalizer stays the
 *  CLOSED-SET SSOT so an out-of-set value (`ultra`, typo) never reaches the wire
 *  and 400s. Env derivation (`QUANTA_REASONING_EFFORT`) happens at the
 *  composition root; this wire never reads process.env. */
export const normalizeResponsesReasoningEffort = (
  value: string | undefined,
): string | undefined => {
  const effort = value?.toLowerCase()
  return effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh"
    ? effort
    : undefined
}

/** Normalize a caller-supplied reasoning `text.verbosity` value to the closed
 *  `low | medium | high` set (case-insensitive). Anything else (incl. undefined
 *  / empty) ⇒ omitted, so the API resolves its OWN default verbosity rather than
 *  us pinning one. Env derivation (`QUANTA_REASONING_VERBOSITY`) happens at the
 *  composition root; this wire never reads process.env. */
export const normalizeResponsesReasoningVerbosity = (
  value: string | undefined,
): string | undefined => {
  const verbosity = value?.toLowerCase()
  return verbosity === "low" || verbosity === "medium" || verbosity === "high"
    ? verbosity
    : undefined
}

export const buildResponsesBody = (
  input: StreamInput,
  model: string,
  options: BuildResponsesBodyOptions = {},
): Record<string, unknown> => {
  // H15 re-emit: PREPEND prior captured reasoning items to the turn's input so
  // the model resumes its chain of thought (Codex order — reasoning items lead
  // the turn). Gated AND non-empty-guarded: when carry-over is off OR there are
  // no captured items, `priorReasoning` is empty and `items` is byte-identical
  // to today (the spread of an empty array prepends nothing).
  const priorReasoning =
    options.reasoningCarryover === true &&
    options.priorReasoningItems !== undefined &&
    options.priorReasoningItems.length > 0
      ? options.priorReasoningItems
      : []
  const items = [
    ...priorReasoning,
    ...(options.inputItems ?? buildResponsesInputItems(input.messages)),
  ]
  const instructions = (() => {
    const flattened = flattenResponsesSystem(input.system)
    return flattened !== "" ? flattened : DEFAULT_INSTRUCTIONS
  })()
  const serviceTier = normalizeResponsesServiceTier(options.serviceTier)
  const reasoningEffort = normalizeResponsesReasoningEffort(options.reasoningEffort)
  const reasoningSummary = options.reasoningSummary === true
  const verbosity = normalizeResponsesReasoningVerbosity(options.reasoningVerbosity)
  // The `reasoning` object co-locates effort + summary. It is emitted iff EITHER
  // is requested (summary is standalone — gating it on effort alone would drop
  // the summary stream when no effort knob is set). Default-OFF byte-identity:
  // when both are absent `reasoning` is `null` and the spread below adds NO key
  // — and when ONLY an effort is set the object is `{effort}`, exactly today's
  // shape (no stray `summary` key leaks in).
  const reasoning =
    reasoningEffort !== undefined || reasoningSummary
      ? {
          ...(reasoningEffort !== undefined ? { effort: reasoningEffort } : {}),
          ...(reasoningSummary ? { summary: "auto" as const } : {}),
        }
      : null
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
    // `reasoning` carries `{ effort?, summary? }`. Emitted only when non-empty
    // (effort OR summary requested); absent ⇒ no `reasoning` key (byte-identical
    // when both knobs are off — and an effort-only call keeps its legacy
    // `{ effort }` shape exactly).
    ...(reasoning !== null ? { reasoning } : {}),
    // Verbosity is a TOP-LEVEL `text: { verbosity }` sibling (NOT a flat
    // `verbosity` key — that is silently ignored by the API). Independent of
    // `reasoning`. Omitted / out-of-set ⇒ no `text` key (API default verbosity).
    ...(verbosity !== undefined ? { text: { verbosity } } : {}),
    // H15 — request encrypted reasoning back ONLY when we are actually
    // re-emitting prior reasoning items (carry-over on + non-empty). The
    // `include` field is the body-level SSOT for "echo reasoning.encrypted_content"
    // (the `x-reasoning-included` transport header is the adapter-side seam,
    // documented but not set here — this wire owns no headers). Off / empty ⇒
    // no `include` key (byte-identical).
    ...(priorReasoning.length > 0 ? { include: ["reasoning.encrypted_content"] } : {}),
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

/**
 * H15 — normalize a Responses `reasoning` OUTPUT item into a re-emittable
 * INPUT reasoning item (the shape Codex re-feeds: `type: "reasoning"` carrying
 * the opaque `encrypted_content`, plus `id`/`summary` when present).
 *
 * Returns `null` (safe-skip) when there is no usable `encrypted_content`:
 *   - missing / non-string / empty `encrypted_content` ⇒ nothing to carry over.
 * A null here means the host captures nothing for this item and the turn stays
 * non-resumable exactly as before — never a crash on a malformed reasoning
 * payload (mirrors Codex's "contained no … encrypted_content" reducer skip).
 *
 * The `summary` is preserved verbatim ONLY when it is an array (the Responses
 * reasoning-summary shape); anything else is dropped. The body is NEVER decoded
 * locally (ZDR — `encrypted_content` is opaque ciphertext).
 */
export const normalizeResponsesReasoningItem = (item: unknown): ResponsesInputItem | null => {
  if (!isObject(item) || item.type !== "reasoning") return null
  const encrypted = item.encrypted_content
  if (typeof encrypted !== "string" || encrypted === "") return null
  return {
    type: "reasoning",
    ...(typeof item.id === "string" && item.id !== "" ? { id: item.id } : {}),
    encrypted_content: encrypted,
    ...(Array.isArray(item.summary) ? { summary: item.summary } : {}),
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
  return event !== undefined
    ? { event, data: dataParts.join("\n") }
    : { data: dataParts.join("\n") }
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
  // OpenAI Responses streams a function call's arguments via
  // `response.function_call_arguments.delta`, which is keyed by the output
  // ITEM id (`event.item_id`, the `fc_…` id) — NOT the `call_id` that
  // `output_item.added`/`output_item.done` and every downstream consumer
  // (tool_use_start/_delta/_end → buildToolInputSeam idToName) are keyed by.
  // Capture the item_id → call_id correlation at `added` so a delta resolves
  // to the SAME id the slot was created with: deltas accumulate into the
  // correct slot and the emitted `tool_use_delta.id` stays consistent with
  // start/end. Without this the lookup misses, `slot.args` never accumulates,
  // and per-tool `onInputDelta` never fires for live OpenAI streaming.
  const itemIdToCallId = new Map<string, string>()
  let usage: AccumulatedUsage | null = null

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
        // Map the output ITEM id (`fc_…`) to the canonical call id so a later
        // `function_call_arguments.delta` (keyed by item_id) resolves to this
        // same slot. The item id can equal the call id on some payloads; the
        // mapping is harmless (identity) in that case.
        if (typeof event.item.id === "string" && event.item.id !== "") {
          itemIdToCallId.set(event.item.id, id)
        }
        yield { type: "tool_use_start", id, name }
      }
      continue
    }

    if (type === "response.function_call_arguments.delta") {
      const rawId = event.item_id ?? ""
      const delta = event.delta ?? ""
      // Resolve the item-scoped delta id back to the canonical call id used at
      // start/end. Fall back to the raw id only when no correlation exists
      // (e.g. a delta with no preceding `added`) so a still-keyed slot is not
      // silently dropped.
      const id = itemIdToCallId.get(rawId) ?? rawId
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
        // Prefer the streamed-delta accumulation (`slot.args`) when present so
        // we do NOT depend on `output_item.done` always carrying `arguments`
        // (it may be omitted for pure-streamed calls). Only fall back to the
        // done-carried `arguments` when no deltas accumulated, then to "{}".
        const raw =
          slot?.args !== undefined && slot.args !== "" ? slot.args : (event.item?.arguments ?? "{}")
        const input = parseToolInputOrThrow(
          typeof raw === "string" ? raw : JSON.stringify(raw),
          id,
          opts.provider,
          "with-cause",
        )
        yield { type: "tool_use_end", id, input }
        toolCalls.delete(id)
        if (typeof event.item?.id === "string") itemIdToCallId.delete(event.item.id)
      }
      if (rawType === "reasoning") dispatchNoThrow(opts.onReasoning)
      // H15 default-OFF byte-identity: when carry-over is off the captured
      // `reasoningItem` key is NEVER added (the payload is the legacy 2-field
      // shape). When on AND the item is a reasoning item carrying usable
      // `encrypted_content`, surface the re-emittable input item so the host
      // can persist it. A reasoning item still normalizes to `null` for the
      // resume/baseline path (`normalizeResponsesOutputItem` is unchanged), so
      // the continuation-store semantics are untouched.
      const reasoningItem =
        opts.reasoningCarryover === true && rawType === "reasoning"
          ? normalizeResponsesReasoningItem(event.item)
          : null
      dispatchNoThrow(opts.onOutputItemDone, {
        rawType,
        normalized: normalizeResponsesOutputItem(event.item),
        ...(reasoningItem !== null ? { reasoningItem } : {}),
      })
      continue
    }

    if (type === "response.completed") {
      const extracted = extractResponsesUsage(event.response)
      if (extracted !== null) {
        usage = extracted
        dispatchNoThrow(opts.onCompleted, {
          ...(typeof event.response?.id === "string" && event.response.id !== ""
            ? { responseId: event.response.id }
            : {}),
          ...(typeof event.response?.model === "string" ? { model: event.response.model } : {}),
          usage: {
            input: extracted.input,
            output: extracted.output,
            ...(extracted.cached !== undefined ? { cached: extracted.cached } : {}),
            ...(extracted.reasoning !== undefined ? { reasoning: extracted.reasoning } : {}),
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
      // A real incomplete-only stream (hit max_output_tokens / content_filter)
      // terminates with `response.incomplete` and NO preceding
      // `response.completed`, so the accumulator is still null. The incomplete
      // event carries its OWN counts on `event.response.usage` — and these are
      // the most expensive turns (output capped at the ceiling). Fold the
      // incomplete-carried usage into the canonical shape and emit THAT so the
      // turn is never undercounted to zero. Fall back to the (possibly null)
      // accumulator when the incomplete event omits usage.
      const incompleteUsage = extractResponsesUsage(event.response)
      yield* emitUsage(incompleteUsage ?? usage, opts.fallbackModel)
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
  readonly reasoning?: number
  readonly model?: string
}

/** Single source of truth for folding a Responses `response.usage` payload into
 *  the canonical {@link AccumulatedUsage} shape — shared by the
 *  `response.completed` and `response.incomplete` arms so an incomplete-only
 *  stream (which carries its own counts) is accounted identically to a
 *  completed one. Returns null when no usage payload is present so the caller
 *  can fall back to the prior accumulator (and `emitUsage` stays a no-op for a
 *  truly usage-less stream rather than emitting a fabricated zero). */
const extractResponsesUsage = (response: ResponsesEvent["response"]): AccumulatedUsage | null => {
  const rawUsage = response?.usage
  if (rawUsage === undefined) return null
  const cached = rawUsage.cached_input_tokens ?? rawUsage.input_tokens_details?.cached_tokens
  const reasoning = rawUsage.output_tokens_details?.reasoning_tokens
  return {
    input: rawUsage.input_tokens ?? 0,
    output: rawUsage.output_tokens ?? 0,
    ...(typeof cached === "number" ? { cached } : {}),
    ...(typeof reasoning === "number" ? { reasoning } : {}),
    ...(typeof response?.model === "string" ? { model: response.model } : {}),
  }
}

function* emitUsage(usage: AccumulatedUsage | null, fallbackModel: string): Generator<StreamEvent> {
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
