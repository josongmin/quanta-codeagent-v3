import type Anthropic from "@anthropic-ai/sdk"
import { LLMError } from "@/shared/errors"
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

const toAnthropicContent = (block: ContentBlock): Anthropic.ContentBlockParam | null => {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text }
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input }
    case "tool_result": {
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

export const buildAnthropicMessagesRequest = (
  model: string,
  maxTokens: number,
  input: StreamInput,
  cacheTtl: CacheTtl = "5m",
  serviceTier?: string,
): Anthropic.MessageCreateParamsStreaming => {
  const toolNames = input.tools.map((t) => t.name)
  const toolChoice = toAnthropicToolChoice(input.toolChoice, toolNames)
  const tier = normalizeAnthropicServiceTier(serviceTier)
  return {
    model,
    max_tokens: maxTokens,
    stream: true,
    // gap-other-agent GAP 5 — `service_tier` (auto|standard_only). Absent ⇒ key
    // omitted (byte-identical). The installed @anthropic-ai/sdk@0.40.1 type lacks
    // the field, so the same scoped-cast style as `thinking` below is used.
    ...(tier !== undefined ? ({ service_tier: tier } as { service_tier: string }) : {}),
    ...(input.system ? { system: toAnthropicSystem(input.system, cacheTtl) } : {}),
    // The `thinking` object is already the correct wire JSON for every arm
    // (`enabled` / `adaptive` / `disabled`). The installed `@anthropic-ai/sdk`
    // @0.40.1 types `thinking` as `enabled | disabled` only — it has NO
    // `ThinkingConfigAdaptive` arm (the wire `{"type":"adaptive"}` is correct
    // regardless; only the compile-time type lags the API). Scoped cast to
    // satisfy the pinned SDK type until a bump adds the adaptive arm. Same
    // in-house style as the raw-SSE `as unknown as` narrow in `anthropic.ts`.
    ...(input.thinking ? { thinking: input.thinking as Anthropic.ThinkingConfigParam } : {}),
    messages: cacheConversationPrefix(toAnthropicMessages(input.messages), cacheTtl),
    tools: input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    })),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
  }
}
