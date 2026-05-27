import Anthropic from "@anthropic-ai/sdk"
import { LLMError } from "@/shared/errors"
import type {
  ContentBlock,
  Message,
  StreamInput,
  SystemPromptInput,
  ToolChoice,
} from "./types"

const toAnthropicContent = (block: ContentBlock): Anthropic.ContentBlockParam | null => {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text }
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input }
    case "tool_result":
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
): string | Anthropic.TextBlockParam[] => {
  if (typeof system === "string") return system
  return system.map((b) => ({
    type: "text",
    text: b.text,
    ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
  }))
}

export const cacheConversationPrefix = (
  messages: Anthropic.MessageParam[],
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
  blocks[textIdx] = {
    ...(blocks[textIdx] as Anthropic.TextBlockParam),
    cache_control: { type: "ephemeral" },
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

export const buildAnthropicMessagesRequest = (
  model: string,
  maxTokens: number,
  input: StreamInput,
): Anthropic.MessageCreateParamsStreaming => {
  const toolNames = input.tools.map((t) => t.name)
  const toolChoice = toAnthropicToolChoice(input.toolChoice, toolNames)
  return {
    model,
    max_tokens: maxTokens,
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
  }
}
