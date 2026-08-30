import type Anthropic from "@anthropic-ai/sdk"
import { LLMError } from "@/shared/errors"
import { buildAnthropicMessagesRequest } from "../anthropic-messages-codec"
import type { LLMPort } from "../ports"
import { withStreamTimeout } from "../stream-timeout"
import type { CacheTtl, StreamEvent, StreamInput } from "../types"
import { buildUsageEvent, parseToolInputOrThrow, resolveAdapterStreamTimeouts } from "./shared"

export { buildAnthropicMessagesRequest, toAnthropicToolChoice } from "../anthropic-messages-codec"

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
  /** gap-other-agent GAP 5 — Anthropic `service_tier` intent (resolved from
   *  `QUANTA_SERVICE_TIER` / `QUANTA_FAST` at the factory). The codec normalizes
   *  it to Anthropic's `auto`|`standard_only` and DROPS anything else. Absent ⇒
   *  no `service_tier` key (byte-identical). */
  serviceTier?: string
  /** gap GAP 3 (ADR-0505) — the `<model>-1m` context-window key when the
   *  context-1m beta is active; surfaced as {@link LLMPort.contextWindowKey}. */
  contextWindowKey?: string
  /** T1 stream-hang guard overrides. Caller-supplied wins over env knobs
   *  (`QUANTA_LLM_STREAM_FIRST_CHUNK_MS` / `QUANTA_LLM_STREAM_IDLE_MS`); env
   *  wins over the defaults baked into `src/llm/stream-timeout.ts`. Read
   *  ONCE at construction — no per-call re-read. */
  streamFirstChunkMs?: number
  streamIdleMs?: number
  /** Prompt-cache TTL forwarded to the codec's 4th arg. Absent ⇒ `"5m"`
   *  (byte-identical to the prior fixed-5m cache_control). The factory gates
   *  `"1h"` behind a model allowlist before constructing this adapter. */
  cacheTtl?: CacheTtl
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
 *  `cache_read_input_tokens` is present only when prompt caching hit;
 *  `cache_creation_input_tokens` only when this turn WROTE new cache entries. */
export interface RawStartUsage {
  input_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
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
  cacheCreationTokens?: number
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

export class AnthropicAdapter implements LLMPort {
  private readonly client: Anthropic
  readonly model: string
  readonly provider = "anthropic"
  readonly surfaceId = "anthropic-messages"
  readonly transportId = "public"
  readonly authMode = "Anthropic BYOK"
  private readonly maxTokens: number
  private readonly cacheTtl: CacheTtl
  /** gap-other-agent GAP 5 — Anthropic `service_tier` intent (resolved at the
   *  composition root; the codec normalizes it to auto|standard_only at request
   *  time). Absent ⇒ no `service_tier` key (byte-identical). Public-readonly
   *  (like {@link betaHeaders}) so a factory→adapter e2e can assert the threading
   *  without driving a live request. */
  readonly serviceTier: string | undefined
  /** gap GAP 3 (ADR-0505) — the `<model>-1m` window key when context-1m is
   *  active; resolves the 1M compaction window while `model` stays canonical. */
  readonly contextWindowKey?: string
  readonly betaHeaders: readonly string[]
  /** T1 stream-hang guard: pinned at construction (env knobs + optional
   *  caller overrides resolved ONCE) and applied to every `stream()` call
   *  via the shared `withStreamTimeout` decorator. */
  private readonly streamTimeoutMs: { firstChunkMs: number; idleMs: number }

  constructor(config: AnthropicConfig) {
    // Literal require is bundleable and synchronous: unused providers do not
    // initialize their SDK, while client validation still happens in constructor.
    const { default: AnthropicClient } =
      require("@anthropic-ai/sdk") as typeof import("@anthropic-ai/sdk")
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
        ? new AnthropicClient({ ...base, defaultHeaders: { "anthropic-beta": beta } })
        : new AnthropicClient(base)
    this.model = config.model
    this.maxTokens = config.maxTokens ?? 8192
    this.cacheTtl = config.cacheTtl ?? "5m"
    this.serviceTier = config.serviceTier
    if (config.contextWindowKey !== undefined) this.contextWindowKey = config.contextWindowKey
  }

  private async openRawStream(input: StreamInput): Promise<AsyncIterable<RawEvent>> {
    try {
      const req = buildAnthropicMessagesRequest(
        this.model,
        this.maxTokens,
        input,
        this.cacheTtl,
        this.serviceTier,
      )
      // Caller cancellation: the SDK request-options `signal` aborts the
      // underlying fetch — covers the create()/TTFT phase that the stream
      // wrapper cannot see (it only decorates the AsyncIterable returned
      // AFTER create() resolves). Composes with the per-request `timeout`
      // set at construction: whichever fires first cancels the request.
      // Absent ⇒ `undefined` options, byte-identical to the pre-feature path.
      const opts = input.signal ? { signal: input.signal } : undefined
      const pending = this.client.messages.create(req, opts)
      // jun-6 account-ratelimit-snapshot — OPTIONAL success-path header capture.
      // Present ONLY when the loop wired the hook (gate QUANTA_RATELIMIT_PROACTIVE
      // ON). `.withResponse()` returns the SAME parsed stream plus the raw
      // `Response`; we hand the caller a case-insensitive header accessor and
      // swallow any hook throw (it must never poison the live stream). Absent ⇒
      // the plain `await pending` path runs, byte-identical to pre-feature.
      if (input.onResponseHeaders !== undefined) {
        const { data, response } = await pending.withResponse()
        try {
          input.onResponseHeaders((name) => response.headers.get(name))
        } catch {
          // best-effort: a faulty quota consumer must not break the stream.
        }
        return data as unknown as AsyncIterable<RawEvent>
      }
      return (await pending) as unknown as AsyncIterable<RawEvent>
    } catch (e) {
      throw LLMError.fromSdkError("anthropic", e)
    }
  }

  /**
   * `LLMPort.listModels` — the model ids this API key may run, from Anthropic's
   * own `/v1/models` (`client.models.list`, newest first). This is what keeps the
   * `/model` picker's candidate set the provider's live truth instead of a
   * hand-maintained slug list that drifts as models roll out.
   *
   * `limit: 100` is one page over a catalog of ~20 — no pagination loop needed
   * (and a truncated page would only mean a shorter picker list, never a wrong
   * one). Throws a typed {@link LLMError} on auth/network failure, per the port
   * contract; callers treat a rejection as "no catalog" and keep their seeded
   * candidates. No adapter-level cache: the CLI's catalog wire memoizes the
   * probe for the session, so this runs once per session.
   *
   * MR-07 — `signal` goes to the SDK request itself (`RequestOptions.signal`), so
   * an aborted probe tears the HTTP request down instead of merely releasing the
   * awaiting caller. The SDK rejects with an abort error, which
   * `LLMError.fromSdkError` classifies and the caller degrades to "no catalog".
   * `undefined` is an accepted value for the SDK's `signal` field, so an
   * unsignalled probe is byte-identical to the previous call.
   */
  async listModels(signal?: AbortSignal): Promise<readonly string[]> {
    try {
      const page = await this.client.models.list({ limit: 100 }, { signal })
      return page.data.map((m) => m.id)
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
  if (m.usage.cache_creation_input_tokens !== undefined) {
    usage.cacheCreationTokens = m.usage.cache_creation_input_tokens
  }
}

/** Terminal `message_delta`: fold the completion count, then emit the usage
 *  event (if any tokens were seen) immediately before `message_stop`. */
function* finishOnMessageDelta(
  ev: Extract<RawEvent, { type: "message_delta" }>,
  usage: UsageAccumulator,
): Generator<StreamEvent> {
  if (ev.usage) usage.outputTokens = ev.usage.output_tokens
  if (!ev.delta.stop_reason) {
    // Intermediate `message_delta`: Anthropic streams the CUMULATIVE
    // `output_tokens` (SDK `MessageDeltaUsage.output_tokens`) before the final
    // stop. Surface it as a LIVE `output_progress` so the spinner shows an
    // EXACT rising count, not just the chars/4 estimate. Deliberately NOT a
    // `usage` event: the loop folds `usage` into the recorder/budget/taskSpend,
    // and re-emitting a growing cumulative figure would massively over-count.
    // `output_progress` is UI-only (loop forwards it without accounting).
    if (ev.usage !== undefined && usage.outputTokens !== undefined) {
      yield { type: "output_progress", outputTokens: usage.outputTokens, exact: true }
    }
    return
  }
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
