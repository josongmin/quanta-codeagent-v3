import {
  assembleFromEvents,
  type LLMPort,
  type Message,
  type StreamEvent,
  validateAgainstResponseSchema,
} from "@/llm"
import type { AdaptiveModelCall, AdaptiveModelCallArgs } from "./llm-router"

const ROUTER_TOOL_NAME = "route_adaptive_phase"

const ROUTER_SYSTEM = [
  "You are a strict structured-output router.",
  "Call the single provided tool exactly once.",
  "Do not emit prose or markdown.",
].join("\n")

const collectText = (events: readonly StreamEvent[]): string =>
  assembleFromEvents([...events])
    .message.content.filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()

/**
 * Provider-agnostic adaptive router call. The primary path is one forced
 * schema-tool call (`toolChoice:{kind:"tool"}`), which Anthropic and OpenAI
 * both support. If a provider still returns plain text, we accept it only when
 * it parses and validates against the requested schema; otherwise the raw text
 * is returned and the controller rejects it fail-closed.
 */
export const makeAdaptiveToolModelCall = (args: {
  readonly llm: LLMPort
  readonly signal?: AbortSignal
}): AdaptiveModelCall => {
  return async (input: AdaptiveModelCallArgs): Promise<unknown> => {
    const events: StreamEvent[] = []
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: input.prompt }],
      },
    ]
    for await (const event of args.llm.stream({
      system: [{ type: "text", text: ROUTER_SYSTEM }],
      messages,
      tools: [
        {
          name: ROUTER_TOOL_NAME,
          description: "Return the adaptive routing decision as one JSON object.",
          input_schema: input.schema as Record<string, unknown>,
        },
      ],
      toolChoice: { kind: "tool", name: ROUTER_TOOL_NAME },
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    })) {
      events.push(event)
    }
    const assembled = assembleFromEvents([...events]).message
    for (const block of assembled.content) {
      if (block.type === "tool_use" && block.name === ROUTER_TOOL_NAME) return block.input
    }
    const text = collectText(events)
    const parsed = validateAgainstResponseSchema(text, input.schema as Record<string, unknown>)
    return parsed.ok ? parsed.value : text === "" ? null : text
  }
}
