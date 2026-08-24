import type Anthropic from "@anthropic-ai/sdk"
import { LLMError } from "@/shared/errors"
import {
  type ResponseFormat,
  toAnthropicForcedTool,
  validateResponseFormat,
} from "./structured-output"
import type {
  CacheTtl,
  ContentBlock,
  Message,
  StreamInput,
  SystemPromptInput,
  ToolChoice,
} from "./types"

/** Build the `cache_control` object for a prompt-cache breakpoint.
 *
 *  Anthropic's prompt cache supports exactly two retentions on an `ephemeral`
 *  breakpoint: the implicit 5-minute default (`{ type: "ephemeral" }`, NO `ttl`
 *  key) and an explicit 1-hour hold (`{ type: "ephemeral", ttl: "1h" }`). This
 *  is the single literal-construction site for both codec breakpoints
 *  ({@link toAnthropicSystem} and {@link cacheConversationPrefix}).
 *
 *  Default-OFF byte-identity (the sacred guarantee): `"5m"` (the default) MUST
 *  emit `{ type: "ephemeral" }` with NO `ttl` key — byte-identical to the
 *  pre-feature inline literal. `"1h"` adds `ttl: "1h"` and nothing else; it
 *  does NOT add a breakpoint, change which block is cached, or touch the
 *  4-breakpoint cap / prefix layout. It is purely a retention extension on the
 *  marker the codec already places. */
export const ttlControl = (ttl: CacheTtl = "5m"): { type: "ephemeral"; ttl?: "1h" } =>
  ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" }

/** Render a `tool_result` block into the SDK parameter shape.
 *
 *  A unit because the structured-content path carries one rule no other block
 *  kind shares: `contentBlocks` is projected into text/image params, unknown
 *  kinds are DROPPED, and the projection only REPLACES the flat `content`
 *  string when at least one block survived it. A tool result with no (or only
 *  unrecognized) structured blocks therefore stays byte-identical to the
 *  flat-string form the codec emitted before structured content existed. */
const toAnthropicToolResult = (
  block: Extract<ContentBlock, { type: "tool_result" }>,
): Anthropic.ToolResultBlockParam => {
  const structuredContent: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = []
  for (const p of block.contentBlocks ?? []) {
    if (p.type === "text") {
      structuredContent.push({ type: "text", text: p.text })
      continue
    }
    if (p.type === "image") {
      structuredContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: p.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: p.data,
        },
      })
    }
  }
  return {
    type: "tool_result",
    tool_use_id: block.tool_use_id,
    content: structuredContent.length > 0 ? structuredContent : block.content,
    ...(block.is_error ? { is_error: true } : {}),
  }
}

const toAnthropicContent = (block: ContentBlock): Anthropic.ContentBlockParam | null => {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text }
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input }
    case "tool_result":
      return toAnthropicToolResult(block)
    case "thinking":
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
    case "image":
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: block.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: block.data,
        },
      } satisfies Anthropic.ContentBlockParam
    case "document":
      return {
        type: "document",
        source: {
          type: "base64",
          media_type: block.mediaType as "application/pdf",
          data: block.data,
        },
      } satisfies Anthropic.ContentBlockParam
    default: {
      const _exhaustive: never = block
      return _exhaustive
    }
  }
}

export const toAnthropicSystem = (
  system: SystemPromptInput,
  cacheTtl: CacheTtl = "5m",
): string | Anthropic.TextBlockParam[] => {
  if (typeof system === "string") return system
  return system.map((b) => ({
    type: "text",
    text: b.text,
    ...(b.cache ? { cache_control: ttlControl(cacheTtl) } : {}),
  }))
}

export const cacheConversationPrefix = (
  messages: Anthropic.MessageParam[],
  cacheTtl: CacheTtl = "5m",
): Anthropic.MessageParam[] => {
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
  // Idempotent: if the chosen text block already carries a cache_control, do
  // not re-stamp it (re-stamping could silently flip a caller-set ttl).
  if ((blocks[textIdx] as Anthropic.TextBlockParam).cache_control !== undefined) {
    return messages
  }
  blocks[textIdx] = {
    ...(blocks[textIdx] as Anthropic.TextBlockParam),
    cache_control: ttlControl(cacheTtl),
  } as Anthropic.TextBlockParam
  const out = [...messages]
  out[lastIdx] = { ...last, content: blocks }
  return out
}

export const toAnthropicMessages = (messages: Message[]): Anthropic.MessageParam[] =>
  messages.map((m) => ({
    role: m.role,
    content: m.content
      .map(toAnthropicContent)
      .filter((b): b is Anthropic.ContentBlockParam => b !== null),
  }))

export const toAnthropicToolChoice = (
  choice: ToolChoice | undefined,
  toolNames: readonly string[],
): Anthropic.MessageCreateParams["tool_choice"] | undefined => {
  if (choice === undefined) return undefined
  switch (choice.kind) {
    case "auto":
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
      const _exhaustive: never = choice
      return _exhaustive
    }
  }
}

/** Map a resolved service-tier intent onto the value we SEND to Anthropic. The
 *  Anthropic Messages API accepts `auto` | `standard_only` | `priority`; we emit
 *  only `auto` | `standard_only` and DELIBERATELY collapse `priority`/`fast` →
 *  `auto` (safer: `auto` uses priority capacity when available but falls back to
 *  standard, whereas a literal `priority` request can be rejected when priority
 *  capacity is unavailable). Anything unmappable (flex/scale/garbage) → undefined
 *  so an invalid tier is never sent. Pure, NO-THROW. (gap-other-agent GAP 5.) */
export const normalizeAnthropicServiceTier = (
  raw: string | undefined,
): "auto" | "standard_only" | undefined => {
  if (typeof raw !== "string") return undefined
  const v = raw.trim().toLowerCase()
  if (v === "auto" || v === "priority" || v === "fast") return "auto"
  if (v === "standard" || v === "standard_only") return "standard_only"
  return undefined
}

/** The Anthropic wire fragment for a schema-forced response: the single tool
 *  whose `input_schema` IS the json schema, plus the `tool_choice` that FORCES
 *  the model to call it. This is Anthropic's documented equivalent of OpenAI's
 *  `response_format` (Anthropic Messages has no `response_format` knob — see
 *  {@link RESPONSE_FORMAT_ANTHROPIC_NOTE}). */
export interface AnthropicForcedFormat {
  readonly tool: Anthropic.Tool
  readonly toolChoice: Anthropic.MessageCreateParams["tool_choice"]
}

/**
 * ADR-0469 — resolve `StreamInput.responseFormat` to the Anthropic forced-tool
 * wire fragment (PROVIDER PARITY with the OpenAI native `response_format`).
 * Absent ⇒ `undefined` so the caller omits every key (byte-identical
 * default-OFF). Present ⇒ the request fragment is FIRST validated
 * ({@link validateResponseFormat}: name charset/length + non-object schema) and
 * an invalid fragment THROWS a typed {@link LLMError} at request construction
 * rather than reaching the provider as an opaque 400 or being silently accepted.
 *
 * Pure; no I/O. Delegates the actual shape to the leaf builder
 * {@link toAnthropicForcedTool} so the strategy lives in exactly one place.
 */
export const resolveAnthropicResponseFormat = (
  responseFormat: StreamInput["responseFormat"],
): AnthropicForcedFormat | undefined => {
  if (responseFormat === undefined) return undefined
  const format = responseFormat as ResponseFormat
  const validated = validateResponseFormat(format)
  if (!validated.ok) {
    throw new LLMError(
      `invalid responseFormat for Anthropic forced-tool: ${validated.error.reason}`,
    )
  }
  const forced = toAnthropicForcedTool(validated.value)
  return {
    tool: {
      name: forced.tool.name,
      description: forced.tool.description,
      input_schema: forced.tool.input_schema as Anthropic.Tool.InputSchema,
    },
    toolChoice: { type: "tool", name: forced.toolChoice.name },
  }
}

/** Anthropic's hard per-request limit: a request carrying more than this many
 *  `cache_control` blocks is rejected with an HTTP 400. */
export const MAX_ANTHROPIC_CACHE_MARKERS = 4

/** Count the `cache_control` markers a built request part actually carries.
 *
 *  STRUCTURAL on purpose. An earlier cut counted occurrences of the literal
 *  `"cache_control"` in `JSON.stringify(part)`, which a user could inflate
 *  simply by typing: a message whose text is exactly `cache_control`
 *  serializes as `"text":"cache_control"` and was counted as a marker, so the
 *  budget silently dropped a real system breakpoint (and enough such messages
 *  stripped every one of them). Marker accounting must read PROPERTIES, never
 *  content bytes. */
const countMarkers = (part: unknown): number => {
  if (part === null || typeof part !== "object") return 0
  if (Array.isArray(part)) {
    let n = 0
    for (const item of part) n += countMarkers(item)
    return n
  }
  let n = 0
  for (const [key, value] of Object.entries(part)) {
    if (key === "cache_control") {
      if (value !== undefined) n++
      continue
    }
    n += countMarkers(value)
  }
  return n
}

/** Cap the FINAL request's `cache_control` markers at Anthropic's limit.
 *
 *  The budget MUST be counted here, on the assembled request, because the
 *  marker sources are in different layers and no single upstream layer sees
 *  the total: `prompt-sections.ts` allocates up to `MAX_CACHE_BREAKPOINTS`
 *  SYSTEM sections, and {@link cacheConversationPrefix} then ALWAYS adds the
 *  trailing conversation breakpoint on top. Four cached sections therefore
 *  produce five markers on the wire — an unconditional 400 for every one of
 *  the five providers sharing this codec.
 *
 *  WHICH markers are dropped is not a heuristic: `prompt-sections.ts` declares
 *  its section order to BE the cache prefix, emitted most-stable-first
 *  (`base` -> `project_md` -> `session_ctx` -> `user_append`). Keeping the
 *  LEADING markers preserves the fallback ladder — when a late section drifts,
 *  an earlier breakpoint still hits. Dropping a middle marker instead would
 *  strand every later breakpoint behind a prefix that just changed.
 *
 *  The conversation marker is never dropped: it covers the longest prefix (all
 *  of system plus the prior turns), so it is the single highest-value
 *  breakpoint in the request.
 *
 *  INERT at and under budget: a legal request is returned by reference,
 *  byte-identical. Only the offending blocks lose their `cache_control` key —
 *  the block and its text always stay on the wire. */
const capSystemCacheMarkers = (
  system: string | Anthropic.TextBlockParam[] | undefined,
  reserved: number,
): string | Anthropic.TextBlockParam[] | undefined => {
  if (system === undefined || typeof system === "string") return system
  const budget = MAX_ANTHROPIC_CACHE_MARKERS - reserved
  let seen = 0
  let over = false
  for (const block of system) {
    if (block.cache_control === undefined) continue
    seen++
    if (seen > budget) {
      over = true
      break
    }
  }
  if (!over) return system
  let kept = 0
  return system.map((block) => {
    if (block.cache_control === undefined) return block
    kept++
    if (kept <= budget) return block
    const { cache_control: _dropped, ...rest } = block
    return rest as Anthropic.TextBlockParam
  })
}

export const buildAnthropicMessagesRequest = (
  model: string,
  maxTokens: number,
  input: StreamInput,
  cacheTtl: CacheTtl = "5m",
  serviceTier?: string,
): Anthropic.MessageCreateParamsStreaming => {
  // ADR-0469 provider parity — a schema-forced response is expressed on
  // Anthropic as a single FORCED tool (input_schema = json schema, tool_choice
  // pinned to it). When present it OVERRIDES the caller's tool surface for this
  // request (the forced tool is the only one, its choice supersedes
  // `input.toolChoice`) — that is the whole point of a structured-output
  // request. Absent ⇒ `undefined`, so every branch below falls through to the
  // caller's own tools/tool_choice and the wire is byte-identical.
  const forced = resolveAnthropicResponseFormat(input.responseFormat)
  const effectiveTools = forced ? [forced.tool] : undefined
  const toolNames = input.tools.map((t) => t.name)
  const toolChoice = forced ? forced.toolChoice : toAnthropicToolChoice(input.toolChoice, toolNames)
  const tier = normalizeAnthropicServiceTier(serviceTier)
  // Anthropic REJECTS `temperature` != 1 whenever extended thinking is active
  // (`{type:"enabled"|"adaptive"}`) — HTTP 400 "temperature may only be set to 1
  // when thinking is enabled". A repair-breadth fanout lane that sampled at 0.8
  // would 400 every candidate on a thinking model. Suppress the field when
  // thinking is active so the request defaults to the required temperature=1
  // (an explicitly `disabled`/absent thinking turn keeps the caller's value).
  const thinkingActive = input.thinking !== undefined && input.thinking.type !== "disabled"
  // Cache-marker budget — see `capSystemCacheMarkers`. The two marker sources
  // must be built BEFORE the request literal so the total can be counted; the
  // conversation breakpoint is reserved first (it covers the longest prefix)
  // and the system sections are capped against what is left. `tools` is counted
  // too: the tool mapping below emits no `cache_control` today, so this is
  // structurally 0, but counting it keeps the invariant on the ACTUAL request
  // rather than on an assumption about which parts may carry markers.
  const cachedMessages = cacheConversationPrefix(toAnthropicMessages(input.messages), cacheTtl)
  const builtTools =
    effectiveTools ??
    input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }))
  const reserved = countMarkers(cachedMessages) + countMarkers(builtTools)
  const cappedSystem = input.system
    ? capSystemCacheMarkers(toAnthropicSystem(input.system, cacheTtl), reserved)
    : undefined
  return {
    model,
    max_tokens: maxTokens,
    stream: true,
    // gap-other-agent GAP 5 — `service_tier` (auto|standard_only). Absent ⇒ key
    // omitted (byte-identical). The installed @anthropic-ai/sdk@0.40.1 type lacks
    // the field, so the same scoped-cast style as `thinking` below is used.
    ...(tier !== undefined ? ({ service_tier: tier } as { service_tier: string }) : {}),
    ...(cappedSystem !== undefined ? { system: cappedSystem } : {}),
    // The `thinking` object is already the correct wire JSON for every arm
    // (`enabled` / `adaptive` / `disabled`). The installed `@anthropic-ai/sdk`
    // @0.40.1 types `thinking` as `enabled | disabled` only — it has NO
    // `ThinkingConfigAdaptive` arm (the wire `{"type":"adaptive"}` is correct
    // regardless; only the compile-time type lags the API). Scoped cast to
    // satisfy the pinned SDK type until a bump adds the adaptive arm. Same
    // in-house style as the raw-SSE `as unknown as` narrow in `anthropic.ts`.
    ...(input.thinking ? { thinking: input.thinking as Anthropic.ThinkingConfigParam } : {}),
    messages: cachedMessages,
    // ADR-0469 — when a schema-forced response is requested, the SINGLE forced
    // tool (whose input_schema IS the json schema) replaces the caller's tool
    // list; otherwise the caller's tools pass through unchanged (byte-identical
    // default-OFF: `forced` is undefined ⇒ `effectiveTools` is undefined ⇒ this
    // maps the caller's `input.tools` exactly as before).
    tools: builtTools,
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    // Per-call sampling temperature (repair-breadth fanout). Present ⇒ spread
    // Anthropic's `temperature` field; absent (or thinking active, see above) ⇒
    // OMIT the key entirely (byte-identical to the pre-feature wire — same
    // conditional-spread pattern as `service_tier`/`tool_choice` above).
    // Anthropic Messages accepts `temperature` (0–1) on the surface we drive; the
    // caller owns the value — except under active thinking, which forces 1.
    ...(input.temperature !== undefined && !thinkingActive
      ? { temperature: input.temperature }
      : {}),
  }
}
