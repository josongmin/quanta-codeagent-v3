import type { ResponsesContinuationStore } from "./responses-continuation-store"
import type {
  LlmCheckpoint,
  LlmTransportId,
  PromptCacheRetention,
  ResponsesContinuationMode,
  ResponsesContinuationPhase,
  ResponsesContinuationReason,
} from "./target-metadata"

export interface Message {
  role: "user" | "assistant"
  content: ContentBlock[]
  /**
   * Optional stable id for message-granularity rewind UX (Claude Desktop
   * 1.7196.3 parity). Absent on legacy sessions and on freshly-built
   * Messages — `assignMessageIds` mints ids for new sessions; old sessions
   * remain id-less to preserve the byte-identical default-OFF posture.
   * Never sent to the LLM adapters: producers MUST strip / ignore it when
   * shaping `StreamInput`.
   */
  id?: string
  /**
   * LOCAL-ONLY provenance: this message was authored by the HARNESS, not the
   * human, even though it rides as `role:"user"`.
   *
   * Separate from {@link id} on purpose. Provenance used to be encoded INTO the
   * id (`quanta:synthetic-user:<kind>:<uuid>`), which meant a harness message
   * without an id had no provenance at all — and the compaction summaries, the
   * harness's own output re-entering the transcript, are exactly that. The next
   * compaction then summarized the previous summary as if the user had written
   * it, `/rewind` offered it as a turn to undo, and memory recall anchored on
   * it. `id` is IDENTITY; this is ORIGIN. A message can carry either, both, or
   * neither.
   *
   * Never sent to the LLM adapters. The codecs map `role` + `content` only, so
   * this is structurally unreachable from a provider payload — pinned by a
   * wire-purity test rather than left to convention.
   */
  origin?: "harness"
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | ImageBlock
  | DocumentBlock

/** Native-document input (ADR-0137). Mirrors `ImageBlock` in shape and lifecycle:
 *  appears ONLY on the input/user side of a conversation (the model never streams
 *  a document back). Consumed by Anthropic Messages via
 *  `{type:"document", source:{type:"base64", media_type:"application/pdf", data}}`
 *  — Claude reads the PDF natively (vision + text) without a client-side
 *  extraction lib. Default-OFF byte-identical: a message / tool_result with no
 *  `DocumentBlock` is wired exactly as before. Providers that cannot transport
 *  documents on the wire (OpenAI today) MUST drop or text-flatten this block
 *  rather than crash. */
export interface DocumentBlock {
  type: "document"
  /** Base64-encoded document bytes, NO `data:` URI prefix. */
  data: string
  /** IANA media type — `application/pdf` today (the only type Anthropic accepts
   *  as a native document block). Future types (e.g. `text/plain`,
   *  `text/markdown`) will be added as the API surface widens. */
  mediaType: string
}

/** Multi-modal image input (ADR-0083). Appears ONLY on the input/user side of
 *  a conversation — the model never streams an image back, so assemblers that
 *  reconstruct messages from `StreamEvent`s never produce one. Both providers
 *  consume it: Anthropic via `{type:"image", source:{type:"base64", …}}`,
 *  OpenAI via a `{type:"image_url", image_url:{url:"data:…;base64,…"}}` content
 *  part. Default-OFF byte-identical: a message with no `ImageBlock` is wired
 *  exactly as before (OpenAI keeps the plain-string user content form). */
export interface ImageBlock {
  type: "image"
  /** Base64-encoded image bytes, NO `data:` URI prefix. */
  data: string
  /** IANA media type — `image/png` | `image/jpeg` | `image/webp` | `image/gif`. */
  mediaType: string
}

export interface TextBlock {
  type: "text"
  text: string
  /** ADR-0077 phase marker — STRUCTURAL (not inferred).
   *
   *  Set by {@link determinePhases} as a post-pass after `assembleFromEvents`:
   *  a text block is `"commentary"` IFF the assistant message's `content[]`
   *  has at least one `tool_use` block AFTER it (i.e. the model talks, then
   *  acts). Otherwise `"final_answer"` — the trailing text is the user-facing
   *  closeout.
   *
   *  Deterministic single backward scan; no probabilistic classifier. Consumers
   *  that ignore this field observe byte-identical behaviour (absent on every
   *  legacy / freshly-streamed block until the post-pass tags it). */
  phase?: "commentary" | "final_answer"
}

export interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: unknown
}

export interface ToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  /** Legacy plain-text view of the tool result — byte-identical for every
   *  caller that does not emit image attachments. When `contentBlocks` is
   *  present, the Anthropic API consumes the array form on the wire while
   *  this string remains the canonical preview / log / OpenAI-tool-message
   *  surface (where image parts are not transportable). Callers should
   *  ALWAYS populate `content` so legacy consumers (compaction, distill,
   *  rewind, migration normalization, OpenAI flatten) keep working. */
  content: string
  /** ADR-0126 / ADR-0137 — OPTIONAL structured content mirroring Anthropic
   *  Messages API `tool_result.content`. Populated when a tool's
   *  `ToolResult.images` or `ToolResult.documents` is non-empty: dispatch's
   *  `composeToolResultContent` builds the array
   *  `[{type:"text",text:output}, ...ImageBlock, ...DocumentBlock]`. Absent ⇒
   *  adapters use `content` (byte-identical to the pre-feature path). Provider
   *  adapters that cannot carry image / document parts in tool-result messages
   *  (OpenAI chat / Responses) drop this field and fall back to `content`. */
  contentBlocks?: ReadonlyArray<{ type: "text"; text: string } | ImageBlock | DocumentBlock>
  is_error?: boolean
}

export interface ThinkingBlock {
  type: "thinking"
  thinking: string
  /** Anthropic extended-thinking cryptographic signature (ADR-0076 Gap-2).
   *  The Messages API REQUIRES this back verbatim on the input side when a
   *  prior-turn thinking block is re-sent in a multi-turn conversation — a
   *  missing signature causes a 400 and breaks the thinking carry-over chain.
   *  Accumulated from `signature_delta` StreamEvents during assembly and
   *  serialized straight back by the adapter. Absent for OpenAI reasoning
   *  (opaque, no client-visible signature) and absent when extended-thinking
   *  was never enabled (byte-identical to pre-feature ThinkingBlocks). */
  signature?: string
  /** TRUE when the provider returned an encrypted / redacted reasoning block
   *  (Anthropic `redacted_thinking`). The `thinking` field then holds the
   *  opaque ciphertext rather than human-readable reasoning; we preserve it
   *  verbatim so it can be carried back to the provider unmodified. Absent
   *  ⇒ ordinary plaintext thinking. */
  redacted?: true
}

/** JSON-schema description of a tool, as sent to the model. */
export interface ToolSchema {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** One static span of the system prompt. `cache: true` marks the prefix
 *  breakpoint: everything up to and including this block is byte-stable
 *  across turns and is the provider cache boundary. */
export interface SystemBlock {
  type: "text"
  text: string
  cache?: boolean
}

/** System prompt as either a plain string (legacy, still accepted) or an
 *  ordered list of static blocks. Adapters must treat the block order as
 *  significant and stable so the cached prefix never shifts. */
export type SystemPromptInput = string | SystemBlock[]

/** Anthropic prompt-cache retention for an `ephemeral` `cache_control`
 *  breakpoint — a CLOSED union matching Anthropic's two supported TTLs.
 *  `"5m"` is the implicit default (emitted as `{ type: "ephemeral" }` with NO
 *  `ttl` key — byte-identical to the pre-feature wire); `"1h"` adds
 *  `ttl: "1h"` to hold the cached prefix warm across gaps > 5 min.
 *
 *  This is the Anthropic `cache_control.ttl` axis ONLY. It is DELIBERATELY
 *  distinct from {@link PromptCacheRetention} (`"in-memory" | "24h"`), which is
 *  the OpenAI Responses `prompt_cache` retention — a different vendor, field,
 *  and value set. Do not conflate the two. */
export type CacheTtl = "5m" | "1h"

export type StreamEvent =
  /** Tombstone: every event yielded so far in this turn belongs to a now-dead
   *  partial (e.g. a provider died mid-stream and {@link FallbackLLM} switched
   *  to a backup). A consumer assembling a message MUST discard everything it
   *  has accumulated and start fresh from the next event. Emitted as the first
   *  event of the replacement stream; never emitted before any other event. */
  | { type: "stream_reset" }
  | { type: "text_delta"; delta: string }
  /** Extended-thinking / reasoning content delta (ADR-0076 Gap-2). Emitted
   *  ONLY when a thinking budget is active (Anthropic `thinking:{enabled}`) or
   *  a reasoning model streams a summary (OpenAI). Consecutive deltas for the
   *  same logical thinking block accumulate, in stream order, into the leading
   *  {@link ThinkingBlock} of the assembled assistant message. `redacted:true`
   *  marks an opaque encrypted reasoning block whose `text` is ciphertext to be
   *  preserved verbatim, not human-readable. With NO thinking budget set, zero
   *  of these are emitted, so the assembled message is byte-identical to the
   *  pre-feature path. */
  | { type: "thinking_delta"; text: string; redacted?: true }
  /** Anthropic extended-thinking signature delta (ADR-0076 Gap-2). The provider
   *  streams the cryptographic signature for the just-completed thinking block;
   *  deltas accumulate into {@link ThinkingBlock.signature}. The signature is
   *  REQUIRED back on the input side for multi-turn carry-over. OpenAI reasoning
   *  has no client-visible signature and emits none of these. */
  | { type: "signature_delta"; signature: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; delta: string }
  | { type: "tool_use_end"; id: string; input: unknown }
  | {
      type: "usage"
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      cacheCreationTokens?: number
      /** OpenAI-Responses-ONLY reasoning-token split (the portion of
       *  `outputTokens` the model spent on hidden reasoning; from
       *  `response.usage.output_tokens_details.reasoning_tokens`). OPTIONAL
       *  (exactOptionalPropertyTypes): OMITTED for providers with no split —
       *  Anthropic bills thinking as ordinary output and emits no reasoning
       *  field, so it is simply absent (never a synthetic/guessed value), which
       *  keeps the Anthropic path byte-identical. `0` is a real provider datum
       *  (reasoned zero) and is forwarded verbatim, distinct from omission. */
      reasoningTokens?: number
      model: string
    }
  /** Live output-token progress for the in-flight response (the rising "·
   *  N tokens" the CLI spinner shows). Vendor-agnostic: synthesized by the
   *  {@link LiveUsageLLM} decorator from the normalized `text_delta` /
   *  `thinking_delta` stream (so every adapter is covered), and UPGRADED to
   *  provider-authoritative numbers when the adapter streams incremental
   *  `usage` (Anthropic `message_delta` carries cumulative `output_tokens`).
   *
   *  This is transient UI signal, NOT billing usage and NOT content:
   *    - assemblers IGNORE it (the reconstructed message is byte-identical);
   *    - the loop forwards it to the surface WITHOUT folding it into the
   *      recorder / budget meter (those consume the terminal `usage` only),
   *      so token accounting is never double-counted;
   *    - the trajectory recorder SKIPS it (high-frequency, non-durable).
   *  Emitted only when a surface opted the decorator in (default-OFF /
   *  byte-identical otherwise). */
  | {
      type: "output_progress"
      /** Best-known cumulative output tokens so far in this response. */
      outputTokens: number
      /** True ⇒ sourced from a provider-authoritative `usage` event; false ⇒
       *  locally estimated from streamed content (the chars/4 convention
       *  `estimateTokens` uses). A UI can render `~N` when `exact` is false. */
      exact: boolean
    }
  /** OpenAI Responses continuation-wire observation. Emitted when a Responses
   *  surface decides whether to send a full input, resume from a prior
   *  `previous_response_id`, or self-heal after a resume failure. This is
   *  transport/control metadata, not assistant content: assemblers and text
   *  collectors MUST ignore it. The union is closed so new failure / fallback
   *  reasons become explicit compile-time work across adapters and observers. */
  | {
      type: "llm_continuation"
      surfaceId: "openai-responses"
      transportId: LlmTransportId
      phase: ResponsesContinuationPhase
      mode: ResponsesContinuationMode
      reason: ResponsesContinuationReason
      statusCode?: number
    }
  /** Heartbeat: provider is still "thinking" — no new content yet. Surfaced
   *  ONLY by adapters that decode an OpenAI Responses API `response.in_progress`
   *  event (see ADR-0048). Carries an optional human-readable `message`,
   *  an optional `progress` ratio (0..1), and the provider-side `createdAt`
   *  timestamp when present, so a UI can render a "thinking…" indicator
   *  without losing any other in-flight state. Assemblers must IGNORE this
   *  event when reconstructing the final message: it is non-cumulative
   *  signal, not content. */
  | {
      type: "response_in_progress"
      message?: string
      progress?: number
      createdAt?: number
    }
  | { type: "message_stop"; stop_reason: string }

/**
 * ADR-0079 — pre-call tool_choice control (orthogonal to admissibility, which
 * gates the post-call result). Closed discriminated union; adapters map 1:1 to
 * provider-specific shapes. The default-OFF posture is `{kind:"auto"}` (or
 * field absent) — adapters MUST emit a byte-identical wire payload to the
 * pre-feature path in that case.
 *
 * SoT (PR-3 self-audit fix): the canonical definition lives HERE in the wire
 * layer; `@/agent/tool-choice.ts` re-exports it so resolver, adapters, and
 * tests share one compile-time identity. `llm/` still does not depend on
 * `agent/` — agent imports DOWN to llm, which is the natural direction.
 */
export type ToolChoice =
  | { readonly kind: "auto" }
  | { readonly kind: "any" }
  | { readonly kind: "none" }
  | { readonly kind: "tool"; readonly name: string }

/** Minimal timing-capture seam for the active provider wire request.
 *  Structural only; the loop passes the full capture object through. */
export interface RequestTimingCapture {
  markRequestSent(): void
}

/** Anthropic extended-thinking request shape (closed discriminated union).
 *  - `enabled` — manual fixed budget (today's only arm; byte-identical). Used
 *    for older models (Sonnet 4.5 / Haiku 4.5 / 3.x) and as the default-OFF /
 *    knob-off path for every model.
 *  - `adaptive` — the model self-paces per request (Anthropic 4.6+ families).
 *    Carries NO `budget_tokens`. The optional `display` controls whether
 *    thinking text is summarized (`"omitted"` is the API default → empty text).
 *    Produced ONLY when `QUANTA_ADAPTIVE_THINKING` is on AND the model family is
 *    adaptive-capable (`supportsAdaptiveThinking`); the manual `enabled` arm is
 *    the per-model fallback so an older model never receives `{type:"adaptive"}`
 *    (which would otherwise be a deprecation) nor `budget_tokens` on a 4.7/4.8
 *    model (which 400s).
 *  - `disabled` — explicit force-off. Not produced by the loop today (a
 *    no-thinking turn omits the field entirely, byte-identical), kept so a
 *    future caller can force thinking off on a model that would default it on.
 *  The union is closed so the adapter/codec gets a compile error if a new arm is
 *  added without a wire mapping. */
export type ThinkingConfig =
  | { readonly type: "enabled"; readonly budget_tokens: number }
  | { readonly type: "adaptive"; readonly display?: "summarized" | "omitted" }
  | { readonly type: "disabled" }

export interface StreamInput {
  messages: Message[]
  system?: SystemPromptInput
  tools: ToolSchema[]
  thinking?: ThinkingConfig
  /** ADR-0079 — optional pre-call gate. Absent (or `{kind:"auto"}`) ⇒ adapters
   *  emit the byte-identical pre-feature wire payload. `{kind:"tool",name}` with
   *  a name that doesn't match any entry in `tools` throws at the adapter (NOT
   *  a silent fallback). */
  toolChoice?: ToolChoice
  /** Caller's cancellation signal (user Ctrl+C / cancel / deadline). When it
   *  fires, the adapter aborts the in-flight provider HTTP request so the
   *  socket is released immediately rather than hanging until completion or
   *  the SDK timeout. Threaded end-to-end: loop → StreamInput → adapter SDK
   *  request options, and composed with the stream-timeout wrapper's internal
   *  controller so either trip tears down the upstream symmetrically. Optional
   *  → absent is byte-identical to the pre-feature path (no signal forwarded,
   *  no behavioural change). */
  signal?: AbortSignal
  /** Optional stable routing key for OpenAI prompt caching. When present,
   *  compatible surfaces forward it as `prompt_cache_key` so repeated turns
   *  in the same logical thread hash into the same cache bucket more often.
   *  Surfaces that do not expose this concept ignore it. */
  promptCacheKey?: string
  /** Optional extended prompt-cache retention knob for compatible OpenAI
   *  surfaces. Omitted by default; callers that care about longer-lived cache
   *  prefixes opt in explicitly. */
  promptCacheRetention?: PromptCacheRetention
  /**
   * Wall-clock capture for the active provider wire request.
   * The loop passes this through so the adapter can stamp the actual POST
   * boundary instead of the caller's preflight time.
   */
  turnTimingCapture?: RequestTimingCapture
  /**
   * ADR-0234 — per-call spinner-stall tick hook. Invoked by adapters on EVERY
   * yielded raw stream chunk (token / tool-use delta / SSE frame); never on
   * `done`, never on timeout. The spinner-stall detector consumes this to
   * bump its per-correlation `lastEventMs` so the soft "still working…"
   * panel (ADR-0227) fires before the hard idle abort (ADR-0200).
   *
   * Best-effort by contract — adapters MUST swallow any exception thrown by
   * the hook so a faulty surface detector never poisons the live producer.
   * The `withStreamTimeout` wrapper already enforces this via its own
   * `notifyChunkArrival` helper; adapters that bypass the wrapper (e.g.
   * `chatgpt-oauth`'s SSE parser) carry the same swallow-policy locally.
   *
   * Absent ⇒ adapters emit byte-identical wire payloads and skip the call
   * (default-OFF: a process that never builds a spinner-stall emitter sees
   * zero behavioural change).
   */
  onChunk?: () => void
  /**
   * jun-6 account-ratelimit-snapshot (gate `QUANTA_RATELIMIT_PROACTIVE`).
   * Optional SUCCESS-PATH response-headers hook. When present, an adapter that
   * can observe the raw HTTP response (e.g. Anthropic's `.withResponse()`)
   * invokes it ONCE with a case-insensitive header accessor so the caller can
   * read the provider's live quota meter (`*-ratelimit-*-remaining` / `*-reset`)
   * the provider returns on EVERY response. The caller feeds the accessor to
   * `parseRateLimitSnapshot` and stores the result for a PROACTIVE pre-request
   * delay; the adapter itself stays accounting-free.
   *
   * Best-effort by contract — adapters MUST swallow any exception thrown by the
   * hook (a faulty consumer must never poison the live stream) and MUST NOT
   * forward header VALUES anywhere (the accessor is read-only inside the hook).
   *
   * Absent (the default, and whenever the knob is OFF) ⇒ adapters do NOT call
   * `.withResponse()` / capture headers and emit byte-identical wire payloads —
   * the reactive B3 429-retry path is untouched either way.
   */
  onResponseHeaders?: (get: (name: string) => string | null) => void
  /** Optional terminal checkpoint sink. Responses surfaces call this when the
   *  server returns a resumable response id; other surfaces never invoke it.
   *  Best-effort by contract: adapters swallow callback failures so a caller's
   *  bookkeeping cannot poison the live stream. */
  onCheckpoint?: (checkpoint: LlmCheckpoint) => void
  /** Optional per-session Responses continuation store. Session-owned wrapper
   *  ports inject this so stateful `previous_response_id` routing stays
   *  outside the adapter instance and cannot leak across sessions that share
   *  one boot-time `LLMPort`. Surfaces without a store omit it; adapters fall
   *  back to their local default. */
  responsesContinuation?: { store: ResponsesContinuationStore }
  /** ADR-0469 — optional schema-forced response request. When present, the
   *  OpenAI adapter spreads it onto the request as
   *  `response_format:{type:"json_schema", json_schema:{name, schema, strict}}`
   *  (OpenAI Structured Outputs). Anthropic has NO symmetric knob — the
   *  documented strategy there is a single forced tool-call (see
   *  `src/llm/structured-output.ts` `toAnthropicForcedTool` +
   *  `RESPONSE_FORMAT_ANTHROPIC_NOTE`); the Anthropic adapter MAY adopt it at
   *  integration. The shape is defined in `src/llm/structured-output.ts`
   *  (`ResponseFormat`); it is re-stated structurally here so `@/llm/types`
   *  stays import-light. Absent ⇒ adapters emit a byte-identical pre-feature
   *  wire payload (default-OFF, opt-in per request). Callers confirm the model
   *  obeyed via `validateAgainstResponseSchema`. */
  responseFormat?: {
    readonly type: "json_schema"
    readonly name: string
    readonly schema: Record<string, unknown>
    readonly strict?: boolean
  }
  /** Per-call sampling temperature (repair-breadth fanout diversity, Agentless
   *  `repair.py` greedy + temperature-0.8 sampling). Range 0–2 (the common
   *  OpenAI/Anthropic bound); the value is passed straight through to each
   *  provider's wire field of the same name with no clamping here — callers own
   *  the value. Absent ⇒ BYTE-IDENTICAL: every adapter OMITS the `temperature`
   *  key entirely (no key on the wire), so the pre-feature request is
   *  reproduced exactly and the model uses its own default sampling. Threaded
   *  loop → StreamInput → adapter wire body; the {@link withTemperature}
   *  decorator is the canonical injector (it defers to a caller-set value, so
   *  this field is the override seam). Reasoning surfaces that reject the field
   *  (e.g. OpenAI o-series / GPT-5 on the Responses API) drop it — see the
   *  per-adapter notes. */
  temperature?: number
  /** Optional RECORDING lane label — a correlation id identifying WHICH parallel
   *  lane (repair-breadth candidate, verify-select candidate, location fanout
   *  seed) this call belongs to. When the bench runs N candidates concurrently
   *  they all share ONE recording port, so without a lane label their turns
   *  interleave INDISTINGUISHABLY on the one tape. The {@link laneLabeledPort}
   *  decorator sets it per fork; the recorder strips it from the stored request
   *  (so it is REPLAY-NEUTRAL — never hashed, never part of the matched key) and
   *  stamps it into `metadata.lane`. Absent ⇒ byte-identical to the pre-feature
   *  path (no key on the wire, no `lane` in metadata). */
  recordingLane?: string
}
