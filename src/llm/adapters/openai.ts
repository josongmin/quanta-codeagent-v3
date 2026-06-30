import OpenAI from "openai"
import { LLMError } from "@/shared"
import type { LLMPort } from "../ports"
import { withStreamTimeout } from "../stream-timeout"
import type {
  ContentBlock,
  Message,
  StreamEvent,
  StreamInput,
  SystemPromptInput,
  ToolChoice,
} from "../types"
import {
  buildUsageEvent as buildUsageEventShared,
  parseToolInputOrThrow,
  resolveAdapterStreamTimeouts,
} from "./shared"

interface OpenAIConfig {
  apiKey: string
  model: string
  maxTokens?: number
  baseURL?: string
  /** T1 stream-hang guard overrides. Caller-supplied wins over env knobs
   *  (`QUANTA_LLM_STREAM_FIRST_CHUNK_MS` / `QUANTA_LLM_STREAM_IDLE_MS`); env
   *  wins over the defaults baked into `src/llm/stream-timeout.ts`. Read
   *  ONCE at construction — no per-call re-read. */
  streamFirstChunkMs?: number
  streamIdleMs?: number
}

/** OpenAI vision content part (ADR-0083). User message content widens from a
 *  plain string to an array of parts ONLY when an `ImageBlock` is present —
 *  otherwise the string form is kept (byte-identical default-OFF). */
export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }

// OpenAI separates tool results into their own `role:"tool"` messages, so the
// mapping is less direct than Anthropic's. These params mirror only what we send.
export type ChatParam =
  | { role: "system"; content: string }
  | { role: "user"; content: string | UserContentPart[] }
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
      // Reasoning summary deltas (ADR-0076 Gap-2). Reasoning models stream a
      // human-readable summary of their thinking on one of these fields; the
      // exact key diverges across the OpenAI Chat Completions surface and
      // OpenAI-compatible providers, so we read both. OpenAI reasoning is
      // OPAQUE — there is no client-visible signature, so we never emit a
      // signature_delta from this adapter. Both omitted on non-reasoning
      // models / when no reasoning effort is requested ⇒ zero thinking_delta
      // emitted (byte-identical to the pre-feature path).
      reasoning?: string | null
      reasoning_content?: string | null
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

/** Model-family detector: TRUE for OpenAI families that reject `max_tokens`
 *  and require `max_completion_tokens` (reasoning models + GPT-5 line).
 *  Pinned by prefix — adding a new family means one line here, not a regex
 *  on the error message AFTER a 400. Exported for the unit test that pins
 *  the contract per model id. */
export const usesCompletionTokensParam = (model: string): boolean => {
  const m = model.toLowerCase()
  // o1/o3 reasoning families + gpt-5 generation all use max_completion_tokens.
  // The trailing `-` / `.` cases bound the prefix so `gpt-5o-future` style
  // model names are caught while `gpt-4o` (legacy) is not.
  return m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4") || m.startsWith("gpt-5")
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
  const images = blocks.filter(
    (b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image",
  )
  if (images.length > 0) {
    // ADR-0083 multi-modal: emit OpenAI's content-ARRAY form so text + images
    // ride on a single user message. A data-URL carries the base64 inline.
    const parts: UserContentPart[] = []
    if (text !== "") parts.push({ type: "text", text })
    for (const img of images) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${img.mediaType};base64,${img.data}` },
      })
    }
    params.push({ role: "user", content: parts })
  } else if (text !== "") {
    // No images ⇒ legacy plain-string content (byte-identical).
    params.push({ role: "user", content: text })
  }
  for (const b of blocks) {
    if (b.type === "tool_result") {
      // ADR-0126: `contentBlocks` (when present) carries the structured
      // array form for image-bearing tool results. OpenAI's `role:"tool"`
      // message content is string-only — we ALWAYS use `b.content` (the
      // legacy text view) here; the structured form is ignored on this
      // surface. Byte-identical to the pre-feature path.
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

/**
 * ADR-0079 — map our orthogonal {@link ToolChoice} to OpenAI's `tool_choice`
 * shape. Closed switch with a `never` default so adding a new variant is a
 * compile error here AND in the Anthropic adapter. The `auto` case returns
 * `undefined` so callers OMIT the field — byte-identical to the pre-feature
 * path (OpenAI's default is auto). A `tool` choice whose `name` is not
 * present in the request `tools` is a caller bug; we throw at the adapter so
 * the request never reaches the provider with an unresolvable name (no
 * silent fallback).
 */
export const toOpenAIToolChoice = (
  choice: ToolChoice | undefined,
  toolNames: readonly string[],
): OpenAI.ChatCompletionToolChoiceOption | undefined => {
  if (choice === undefined) return undefined
  switch (choice.kind) {
    case "auto":
      // Byte-identical to pre-feature: OMIT the field. OpenAI's default is
      // "auto" so emitting the literal string would be semantically the
      // same but a different wire payload — we choose omit so default-OFF
      // holds at the byte level.
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
      return { type: "function", function: { name: choice.name } }
    default: {
      const _exhaustive: never = choice
      return _exhaustive
    }
  }
}

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
    const input = parseToolInputOrThrow(slot.args, slot.id, "openai", "with-cause")
    yield { type: "tool_use_end", id: slot.id, input }
  }
}

/** Map an OpenAI usage payload to the additive usage StreamEvent. Returns
 *  `null` when the stream carried no usage (older models) so we never emit
 *  zeros. `cacheReadTokens` is included only on a reported cache hit
 *  (exactOptionalPropertyTypes: conditional spread, not undefined). */
export const buildUsageEvent = (
  usage: RawUsage | null | undefined,
  model: string,
): StreamEvent | null => {
  if (!usage) return null
  const cached = usage.prompt_tokens_details?.cached_tokens
  return buildUsageEventShared({
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    model,
    ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
  })
}

interface StreamState {
  pending: Map<number, PendingCall>
  finish: string | null
  rawUsage: RawUsage | null | undefined
  usageModel: string
  /** jun-25 (defense-in-depth, mirrors responses-stream.ts:632-645) — TRUE
   *  once a real content event flowed (text / reasoning / tool-call delta).
   *  A trailing usage-only chunk does NOT set this. Used together with
   *  `finish === null` to detect a swallowed-throttle empty 200: a stream that
   *  emitted ZERO content AND never carried a `finish_reason` is reclassified
   *  as a retryable `rate_limit` on drain so the loop's backoff engages. */
  sawContent: boolean
}

/** Map one streamed chunk to events, threading finish/usage/model into the
 *  shared state. The trailing usage chunk has empty `choices`, so usage/model
 *  are captured before the early return. */
function* processChunk(chunk: RawChunk, st: StreamState): Generator<StreamEvent> {
  if (chunk.usage) st.rawUsage = chunk.usage
  if (chunk.model) st.usageModel = chunk.model
  const choice = chunk.choices[0]
  if (!choice) return
  // ADR-0076 Gap-2: reasoning summary delta → thinking_delta. The OpenAI Chat
  // Completions surface and compatible providers diverge between `reasoning`
  // and `reasoning_content`; read both, preferring `reasoning` when both
  // populated on the same chunk (provider bug guard — concatenating would
  // double-count). No signature: OpenAI reasoning is opaque.
  const r = choice.delta.reasoning ?? choice.delta.reasoning_content
  if (r) {
    st.sawContent = true
    yield { type: "thinking_delta", text: r }
  }
  if (choice.delta.content) {
    st.sawContent = true
    yield { type: "text_delta", delta: choice.delta.content }
  }
  if (choice.delta.tool_calls && choice.delta.tool_calls.length > 0) st.sawContent = true
  yield* mapToolCallDeltas(chunk, st.pending)
  if (choice.finish_reason) st.finish = choice.finish_reason
}

export class OpenAIAdapter implements LLMPort {
  private readonly client: OpenAI
  readonly model: string
  readonly provider = "openai"
  readonly surfaceId = "openai-chat-completions"
  readonly transportId = "public"
  readonly authMode = "OpenAI BYOK"
  private readonly maxTokens: number
  /** T1 stream-hang guard: pinned at construction (env knobs + optional
   *  caller overrides resolved ONCE) and applied to every `stream()` call
   *  via the shared `withStreamTimeout` decorator. */
  private readonly streamTimeoutMs: { firstChunkMs: number; idleMs: number }

  constructor(config: OpenAIConfig) {
    this.streamTimeoutMs = resolveAdapterStreamTimeouts(config)
    // T1 gap-closer: the per-request SDK `timeout` covers the `create()` call
    // itself (HTTP connect + time-to-first-byte) — the hang point the stream
    // wrapper CANNOT see because it decorates the AsyncIterable returned AFTER
    // create() resolves. A huge-prompt instance (swebench django-11179) hangs
    // here for the SDK's 10-min default, burning the whole bench deadline. We
    // bound it to the first-chunk budget and let the SDK retry once.
    this.client = new OpenAI({
      apiKey: config.apiKey,
      timeout: this.streamTimeoutMs.firstChunkMs,
      maxRetries: 2,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    })
    this.model = config.model
    this.maxTokens = config.maxTokens ?? 8192
  }

  private async openRawStream(input: StreamInput): Promise<AsyncIterable<RawChunk>> {
    const promptCacheRetention =
      input.promptCacheRetention === "in-memory" ? "in_memory" : input.promptCacheRetention
    // Token-cap param naming diverges between OpenAI families:
    //  - Legacy chat models (`gpt-4o`, `gpt-4`, `gpt-3.5-*`, `gpt-4-turbo`,
    //    `chatgpt-4o-latest`, …) accept `max_tokens`.
    //  - Reasoning + GPT-5 generations (`o1*`, `o3*`, `gpt-5*`) REJECT
    //    `max_tokens` with a 400 and require `max_completion_tokens`.
    // Pick at request time off the configured model id; structured detection
    // (not a heuristic on the error message AFTER we get rejected). Adding a
    // new reasoning family ⇒ extend `usesCompletionTokensParam`.
    const tokenCap = usesCompletionTokensParam(this.model)
      ? { max_completion_tokens: this.maxTokens }
      : { max_tokens: this.maxTokens }
    // ADR-0079 — resolve tool_choice BEFORE create() so an unregistered-name
    // throw surfaces from the same path as any other request-construction
    // failure. `undefined` ⇒ field omitted on the wire (byte-identical).
    const toolNames = input.tools.map((t) => t.name)
    const toolChoice = toOpenAIToolChoice(input.toolChoice, toolNames)
    try {
      return (await this.client.chat.completions.create(
        {
          model: this.model,
          ...tokenCap,
          stream: true,
          // Opt into the trailing usage chunk (RFC-0002 §5.3). Older models that
          // don't support it simply omit the chunk — we then emit no usage.
          stream_options: { include_usage: true },
          messages: toChatMessages(input.system, input.messages),
          tools: input.tools.map((t) => ({
            type: "function" as const,
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          })),
          ...(input.promptCacheKey !== undefined ? { prompt_cache_key: input.promptCacheKey } : {}),
          ...(promptCacheRetention !== undefined
            ? { prompt_cache_retention: promptCacheRetention }
            : {}),
          // Per-call sampling temperature (repair-breadth fanout). Present ⇒
          // spread OpenAI's `temperature` param; absent ⇒ OMIT the key entirely
          // (byte-identical to the pre-feature wire — same conditional-spread
          // pattern as `prompt_cache_key` above). Chat-completions accepts
          // `temperature` on every model we drive through this surface.
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
          // ADR-0469 — Structured Outputs passthrough. Present ⇒ spread the
          // OpenAI `response_format:{type:"json_schema",…}` param; absent ⇒
          // OMIT the field entirely (byte-identical to the pre-feature wire).
          // `strict` is conditionally nested so omitting it on the request
          // omits it on the wire (exactOptionalPropertyTypes honest). The
          // shape mirrors the SDK 1:1 so no translation layer is needed; the
          // pure builder + validator live in `../structured-output.ts`.
          ...(input.responseFormat !== undefined
            ? {
                response_format: {
                  type: "json_schema" as const,
                  json_schema: {
                    name: input.responseFormat.name,
                    schema: input.responseFormat.schema,
                    ...(input.responseFormat.strict !== undefined
                      ? { strict: input.responseFormat.strict }
                      : {}),
                  },
                },
              }
            : {}),
        },
        // Caller cancellation: the SDK request-options `signal` aborts the
        // underlying fetch — covers the create()/TTFT phase that the stream
        // wrapper cannot see. Composes with the per-request `timeout` set at
        // construction (whichever fires first cancels). Absent ⇒ `undefined`
        // options, byte-identical to the pre-feature path.
        input.signal ? { signal: input.signal } : undefined,
      )) as unknown as AsyncIterable<RawChunk>
    } catch (e) {
      throw LLMError.fromSdkError("openai", e)
    }
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const raw = await this.openRawStream(input)
    // T1: wrap the raw SDK stream with first-chunk + idle deadlines. A
    // silently-hung stream now throws a structured `stream_corrupt` LLMError
    // (message includes "timeout") that the agent loop's `classifyLLMError`
    // routes through the existing same-turn retry path (RETRYABLE_MARKERS
    // hit). On timeout or early consumer stop the wrapper finalizes the raw
    // SDK stream and aborts its exposed upstream cancellation surface, so no
    // orphan request is left holding the socket.
    const guarded = withStreamTimeout(raw, {
      firstChunkMs: this.streamTimeoutMs.firstChunkMs,
      idleMs: this.streamTimeoutMs.idleMs,
      provider: "openai",
      // Compose the caller's signal into the wrapper: when it fires, the
      // wrapper aborts the raw SDK stream's own upstream cancellation surface
      // and tears down the timeout race cleanly. Handles the post-create()
      // streaming phase (the SDK signal above handles create()/TTFT). Absent
      // ⇒ wrapper still self-aborts on its own timeouts (byte-identical).
      ...(input.signal ? { signal: input.signal } : {}),
      // ADR-0234: thread the per-call spinner-stall tick hook through to the
      // wrapper's `notifyChunkArrival`. Absent ⇒ omitted on the wrapper opts
      // (exactOptional honest, byte-identical to the pre-feature path).
      ...(input.onChunk ? { onChunk: input.onChunk } : {}),
    })
    const st: StreamState = {
      pending: new Map<number, PendingCall>(),
      finish: null,
      rawUsage: undefined,
      usageModel: this.model,
      sawContent: false,
    }

    // L6 H2: `finalizeCalls` MUST run inside the same try/catch as the stream
    // drain. `parseToolInputOrThrow` (malformed tool-call JSON) throws here, and
    // pre-fix that escaped as a non-structured Error — bypassing the loop's
    // retry/classification (which branches on `LLMError.kind`). Route it through
    // the SAME single error-mapping fn (`LLMError.fromSdkError`) so finalize,
    // abort, and drain all classify consistently.
    try {
      for await (const chunk of guarded) yield* processChunk(chunk, st)
      // jun-25 (defense-in-depth) — STRUCTURAL throttle-swallow guard, mirroring
      // responses-stream.ts:632-645. A 200 chat-completions response that streamed
      // ZERO content events and never carried a `finish_reason` is NOT a valid
      // empty turn: under load the endpoint can accept the request then close the
      // stream with nothing (a silently-swallowed throttle). Pre-guard this drained
      // to a synthetic completed-empty `message_stop` (stop_reason:"end_turn") with
      // no backoff → the loop fires the next request straight into the same window.
      // Reclassify as a RETRYABLE `rate_limit` so the agent loop's exponential-
      // jitter backoff (src/agent/retry.ts, RETRYABLE_KINDS) spaces the retries.
      // Guarded on BOTH no-content AND no-finish_reason: a legitimate empty
      // completion that DOES carry a `finish_reason` (e.g. `stop`/`length` with
      // empty content) completes exactly as before (byte-identical), and a partial
      // stream (content then drop) is untouched. Aborts already threw above.
      if (!st.sawContent && st.finish === null) {
        throw new LLMError(
          "openai chat-completions stream produced no content and no finish_reason " +
            "(empty/truncated stream — likely transport throttle); retrying with backoff",
          { kind: "rate_limit", provider: "openai" },
        )
      }
      yield* finalizeCalls(st.pending)
      const usageEvent = buildUsageEvent(st.rawUsage, st.usageModel)
      if (usageEvent) yield usageEvent
      yield {
        type: "message_stop",
        stop_reason: st.finish ? (STOP_REASON[st.finish] ?? st.finish) : "end_turn",
      }
    } catch (e) {
      throw LLMError.fromSdkError("openai", e, "OpenAI stream error")
    }
  }
}
