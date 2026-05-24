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
      model: string
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

export interface StreamInput {
  messages: Message[]
  system?: SystemPromptInput
  tools: ToolSchema[]
  thinking?: { type: "enabled"; budget_tokens: number }
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
  /**
   * Wall-clock capture for the active provider wire request.
   * The loop passes this through so the adapter can stamp the actual POST
   * boundary instead of the caller's preflight time.
   */
  turnTimingCapture?: RequestTimingCapture
}
