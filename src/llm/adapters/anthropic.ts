import Anthropic from "@anthropic-ai/sdk"
import { LLMError } from "@/shared/errors"
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
import { buildUsageEvent, parseToolInputOrThrow, resolveAdapterStreamTimeouts } from "./shared"

interface AnthropicConfig {
  apiKey: string
  model: string
  maxTokens?: number
  /** Anthropic beta channels to activate per request, joined with comma into
   *  the `anthropic-beta` HTTP header. Examples: `skills-2025-10-02`,
   *  `oauth-2025-04-20`, `environments-2025-11-01` (Environments API; Claude
   *  Desktop 1.7196.3 round-2 finding — sandbox/microVM correlate). Empty /
   *  undefined ⇒ no header sent (byte-identical to pre-feature). Set ONCE at
   *  the SDK client level — beta channels are a per-conversation property
   *  (one adapter = one session), so `defaultHeaders` is the minimal-surface
   *  seam. Tier-0 absorption #0-6. */
  betaHeaders?: readonly string[]
  /** T1 stream-hang guard overrides. Caller-supplied wins over env knobs
   *  (`QUANTA_LLM_STREAM_FIRST_CHUNK_MS` / `QUANTA_LLM_STREAM_IDLE_MS`); env
   *  wins over the defaults baked into `src/llm/stream-timeout.ts`. Read
   *  ONCE at construction — no per-call re-read. */
  streamFirstChunkMs?: number
  streamIdleMs?: number
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
  // `redacted_thinking` carries the opaque encrypted reasoning inline on the
  // START event (no deltas follow): the ciphertext lives in `data`. We surface
  // it as a single redacted thinking_delta so it round-trips back verbatim.
  | { type: "redacted_thinking"; data: string }

export type RawDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string }
  // Streamed cryptographic signature for the current thinking block. Anthropic
  // emits this as a content_block_delta just before the block's stop.
  | { type: "signature_delta"; signature: string }

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
        // ADR-0126: when the dispatch seam attached `contentBlocks` (image-
        // bearing tool result), send the structured array on the wire so the
        // model actually sees the image. Our `ImageBlock` (`{data, mediaType}`)
        // maps to the SDK's `ImageBlockParam` (`source: {type:"base64",
        // media_type, data}`). Text parts pass through as `TextBlockParam`.
        // Absent ⇒ legacy string `content` (byte-identical pre-feature).
        content:
          block.contentBlocks !== undefined
            ? block.contentBlocks.map((p) =>
                p.type === "text"
                  ? ({ type: "text", text: p.text } satisfies Anthropic.TextBlockParam)
                  : ({
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: p.mediaType as
                          | "image/jpeg"
                          | "image/png"
                          | "image/gif"
                          | "image/webp",
                        data: p.data,
                      },
                    } satisfies Anthropic.ImageBlockParam),
              )
            : block.content,
        ...(block.is_error ? { is_error: true } : {}),
      }
    case "thinking": {
      // ADR-0076 Gap-2 carry-over: re-send the thinking block so the provider
      // keeps multi-turn extended-thinking context. The Messages API REQUIRES
      // the original cryptographic signature back verbatim on plaintext
      // thinking — without it the request 400s. A redacted block carries its
      // opaque ciphertext in `thinking` and re-serializes as redacted_thinking.
      //
      // Byte-identical guard: when extended-thinking was never enabled, no
      // ThinkingBlock is ever assembled (assemble.ts only builds one from a
      // thinking_delta, which adapters emit only under an active budget). A
      // signature-less plaintext block can therefore only be a stale artifact
      // (e.g. a hand-built message); we DROP it rather than fail the request,
      // exactly as the pre-feature path did.
      //
      // `satisfies` (not `as`) on both arms — the SDK's `ContentBlockParam`
      // union exports `RedactedThinkingBlockParam` / `ThinkingBlockParam`
      // structurally; `satisfies` catches a future required-field widening
      // at compile time whereas `as` would silently mask it.
      if (block.redacted) {
        return {
          type: "redacted_thinking",
          data: block.thinking,
        } satisfies Anthropic.ContentBlockParam
      }
      if (block.signature === undefined) return null
      return {
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature,
      } satisfies Anthropic.ContentBlockParam
    }
    case "image":
      // ADR-0083 multi-modal: Anthropic Messages API base64 image source. The
      // media type is narrowed to the SDK's accepted literal set; the CLI
      // image-loader only ever emits one of these four, so the cast is safe.
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: block.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: block.data,
        },
      } satisfies Anthropic.ContentBlockParam
    case "document":
      // ADR-0137 native document block: Anthropic Messages API base64 document
      // source (PDF only today). The SDK's ContentBlockParam union accepts
      // `application/pdf` as the media type via the document block param. The
      // `pdf_read` tool magic-byte-sniffs `%PDF-` BEFORE attaching, so any
      // block reaching this arm is byte-verified upstream.
      return {
        type: "document",
        source: {
          type: "base64",
          media_type: block.mediaType as "application/pdf",
          data: block.data,
        },
      } satisfies Anthropic.ContentBlockParam
    default: {
      // Exhaustiveness pin: a future `ContentBlock` variant must come back
      // here and decide its Anthropic mapping consciously — silent drop is
      // not acceptable for a content-bearing block. The `never` cast fails
      // compilation if the union widens; runtime fall-through is impossible.
      const _exhaustive: never = block
      return _exhaustive
    }
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

/** Mark the LAST TEXT block of the last message with an ephemeral
 *  `cache_control` breakpoint, caching the whole conversation prefix (static
 *  system + prior turns) up to the per-turn tail. Mutates a shallow copy.
 *
 *  R-Phase5 P0-B: the Anthropic API only honors `cache_control` on `text`
 *  blocks (server-side it is silently dropped on `tool_use` / `tool_result` /
 *  `thinking` blocks, AND some SDK / server versions reject the request
 *  outright). The prior implementation blindly stamped the TAIL block — when
 *  the last message ended with a tool_use (assistant just issued a call) or
 *  tool_result (user just returned a result), the breakpoint silently
 *  evaporated and the cache never landed on the conversation prefix.
 *
 *  Walk BACKWARD from the tail to find the last `text` block; attach the
 *  breakpoint there. If no text block exists in the last message (a turn
 *  that's purely tool_use / tool_result with no narration), return unchanged
 *  — the cache prefix on the SYSTEM blocks still applies, and the
 *  conversation-prefix breakpoint just doesn't bind this turn. Pure shallow
 *  copy, no mutation of input. */
const cacheConversationPrefix = (messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] => {
  if (messages.length === 0) return messages
  const lastIdx = messages.length - 1
  const last = messages[lastIdx] as Anthropic.MessageParam
  if (typeof last.content === "string" || last.content.length === 0) return messages
  const blocks = [...last.content]
  let textIdx = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    if ((blocks[i] as { type?: string }).type === "text") {
      textIdx = i
      break
    }
  }
  if (textIdx === -1) return messages
  blocks[textIdx] = {
    ...(blocks[textIdx] as Anthropic.TextBlockParam),
    cache_control: { type: "ephemeral" },
  } as Anthropic.TextBlockParam
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

/**
 * ADR-0079 — map our orthogonal {@link ToolChoice} to Anthropic's `tool_choice`
 * shape. Closed switch with a `never` default so adding a new variant is a
 * compile error here AND in the OpenAI adapter. The `auto` case returns
 * `undefined` so callers OMIT the field on the wire — byte-identical to the
 * pre-feature path. A `tool` choice whose `name` is not present in the request
 * `tools` is a caller bug; we throw at the adapter so the request never reaches
 * the provider with an unresolvable name (no silent fallback).
 */
export const toAnthropicToolChoice = (
  choice: ToolChoice | undefined,
  toolNames: readonly string[],
): Anthropic.MessageCreateParams["tool_choice"] | undefined => {
  if (choice === undefined) return undefined
  switch (choice.kind) {
    case "auto":
      // Byte-identical to pre-feature: OMIT the field. The SDK default is
      // auto, so emitting `{type:"auto"}` would be semantically identical
      // but a different wire payload — we choose the omit form so the
      // default-OFF promise holds at the byte level.
      return undefined
    case "any":
      return { type: "any" }
    case "none":
      return { type: "none" }
    case "tool":
      if (!toolNames.includes(choice.name)) {
        throw new LLMError(
          `tool_choice references unregistered tool name "${choice.name}" ` +
            `(registered: ${toolNames.length === 0 ? "<none>" : toolNames.join(", ")})`,
        )
      }
      return { type: "tool", name: choice.name }
    default: {
      // Exhaustiveness check — adding a new ToolChoice variant without
      // updating this switch is a compile error.
      const _exhaustive: never = choice
      return _exhaustive
    }
  }
}

export class AnthropicAdapter implements LLMPort {
  private readonly client: Anthropic
  readonly model: string
  readonly provider = "anthropic"
  readonly authMode = "Anthropic BYOK"
  private readonly maxTokens: number
  readonly betaHeaders: readonly string[]
  /** T1 stream-hang guard: pinned at construction (env knobs + optional
   *  caller overrides resolved ONCE) and applied to every `stream()` call
   *  via the shared `withStreamTimeout` decorator. */
  private readonly streamTimeoutMs: { firstChunkMs: number; idleMs: number }

  constructor(config: AnthropicConfig) {
    this.betaHeaders = config.betaHeaders ?? []
    this.streamTimeoutMs = resolveAdapterStreamTimeouts(config)
    // T1 gap-closer: the per-request SDK `timeout` covers the `create()` call
    // itself (HTTP connect + time-to-first-byte) — the hang point the stream
    // wrapper CANNOT see because it decorates the AsyncIterable returned AFTER
    // create() resolves. We bound it to the first-chunk budget and let the SDK
    // retry once rather than burn the whole instance deadline on a TTFT stall.
    const beta = this.betaHeaders.join(",")
    const base = {
      apiKey: config.apiKey,
      timeout: this.streamTimeoutMs.firstChunkMs,
      maxRetries: 2,
    }
    this.client =
      beta.length > 0
        ? new Anthropic({ ...base, defaultHeaders: { "anthropic-beta": beta } })
        : new Anthropic(base)
    this.model = config.model
    this.maxTokens = config.maxTokens ?? 8192
  }

  private async openRawStream(input: StreamInput): Promise<AsyncIterable<RawEvent>> {
    // ADR-0079 — resolve tool_choice BEFORE the create() call so an
    // unregistered-tool-name throw surfaces from the same try/catch as any
    // other request-construction failure. `undefined` ⇒ field omitted on the
    // wire, byte-identical to the pre-feature path.
    const toolNames = input.tools.map((t) => t.name)
    const toolChoice = toAnthropicToolChoice(input.toolChoice, toolNames)
    try {
      return (await this.client.messages.create(
        {
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
          ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
        },
        // Caller cancellation: the SDK request-options `signal` aborts the
        // underlying fetch — covers the create()/TTFT phase that the stream
        // wrapper cannot see (it only decorates the AsyncIterable returned
        // AFTER create() resolves). Composes with the per-request `timeout`
        // set at construction: whichever fires first cancels the request.
        // Absent ⇒ `undefined` options, byte-identical to the pre-feature path.
        input.signal ? { signal: input.signal } : undefined,
      )) as unknown as AsyncIterable<RawEvent>
    } catch (e) {
      throw LLMError.fromSdkError("anthropic", e)
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
      provider: "anthropic",
      // Compose the caller's signal into the wrapper: when it fires, the
      // wrapper aborts the raw SDK stream's own upstream cancellation surface
      // and tears down the timeout race cleanly. This handles the post-create()
      // streaming phase (the SDK signal above handles the create()/TTFT
      // phase). Absent ⇒ wrapper still self-aborts on its own timeouts
      // (byte-identical).
      ...(input.signal ? { signal: input.signal } : {}),
      // ADR-0234: thread the per-call spinner-stall tick hook through to the
      // wrapper's `notifyChunkArrival`. Absent ⇒ omitted on the wrapper opts
      // (exactOptional honest, byte-identical to the pre-feature path).
      ...(input.onChunk ? { onChunk: input.onChunk } : {}),
    })

    try {
      for await (const ev of guarded) {
        yield* mapRawEvent(ev, open, usage)
      }
    } catch (e) {
      throw LLMError.fromSdkError("anthropic", e, "Anthropic stream error")
    }
  }
}

export type OpenSlots = Map<
  number,
  { kind: "tool_use" | "text" | "thinking"; id: string; json: string }
>

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

/** Translate one Anthropic `content_block_delta`'s inner `RawDelta` payload
 *  into our `StreamEvent` shape. Exhaustiveness is enforced by `default: never`
 *  so a future widening of `RawDelta` (e.g. a new `citations_delta` arm) MUST
 *  come back here and decide its mapping consciously — no silent drop. */
function* yieldFromContentBlockDelta(
  d: RawDelta,
  open: OpenSlots,
  index: number,
): Generator<StreamEvent> {
  switch (d.type) {
    case "text_delta":
      yield { type: "text_delta", delta: d.text }
      return
    case "input_json_delta": {
      const slot = open.get(index)
      if (slot) {
        slot.json += d.partial_json
        yield { type: "tool_use_delta", id: slot.id, delta: d.partial_json }
      }
      return
    }
    case "thinking_delta":
      // ADR-0076 Gap-2: surface extended-thinking content. Emitted only when
      // a thinking budget is active — with no budget the provider streams no
      // thinking blocks, so this branch never fires (byte-identical).
      yield { type: "thinking_delta", text: d.thinking }
      return
    case "signature_delta":
      // The cryptographic signature for the in-flight thinking block.
      // Required back verbatim on the next turn's input for carry-over.
      yield { type: "signature_delta", signature: d.signature }
      return
    default: {
      // Exhaustiveness pin. SDK union widening fails compilation here; the
      // runtime cannot fall through to a silent drop.
      const _exhaustive: never = d
      void _exhaustive
      return
    }
  }
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
      } else if (b.type === "redacted_thinking") {
        // ADR-0076 Gap-2: the encrypted reasoning ships whole on the start
        // event — no deltas follow. Emit one redacted thinking_delta carrying
        // the opaque ciphertext so assembly preserves it for carry-over.
        open.set(ev.index, { kind: "thinking", id: "", json: "" })
        yield { type: "thinking_delta", text: b.data, redacted: true }
      } else {
        open.set(ev.index, { kind: b.type, id: "", json: "" })
      }
      break
    }
    case "content_block_delta": {
      yield* yieldFromContentBlockDelta(ev.delta, open, ev.index)
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
    case "message_stop":
    case "ping":
      // Intentionally emit nothing. The terminal `message_stop` StreamEvent is
      // synthesized from `message_delta`'s `stop_reason` (carries the reason,
      // which the raw `message_stop` does not); `ping` is a keep-alive. Listed
      // explicitly so the `default: never` below pins exhaustiveness — a future
      // RawEvent variant must come back here and decide its mapping.
      break
    default: {
      // Exhaustiveness pin: a new RawEvent arm fails compilation here rather
      // than being silently dropped.
      const _exhaustive: never = ev
      void _exhaustive
      break
    }
  }
}

export const finalizeToolInput = (json: string, id: string): unknown =>
  parseToolInputOrThrow(json, id, "anthropic", "no-cause")
