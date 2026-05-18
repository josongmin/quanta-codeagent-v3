import { assembleFromEvents, type Message } from "@/llm"
import { LLMError } from "@/shared"
import { dispatchTool } from "./dispatch"
import type { AgentConfig, AgentOutcome, StopReason } from "./types"

/**
 * Minimal ReAct loop. One `while` over turns; each turn = one LLM stream then
 * (if any) serial tool dispatch. No transition state machine, no compaction,
 * no hooks — those are the v2 weight this project exists to avoid (RFC §1.2).
 */
type AssembledMessage = ReturnType<typeof assembleFromEvents>["message"]

/** Consume one LLM stream, emitting assistant_text deltas. Returns the
 *  assembled message, or `{ error }` if the stream threw. */
const consumeTurnStream = async (
  config: AgentConfig,
  messages: Message[],
  specs: ReturnType<AgentConfig["registry"]["specs"]>,
): Promise<{ message: AssembledMessage } | { error: string }> => {
  const events: Parameters<typeof assembleFromEvents>[0] = []
  try {
    for await (const ev of config.llm.stream({
      messages,
      system: config.system,
      tools: specs,
    })) {
      events.push(ev)
      if (ev.type === "text_delta") {
        config.stream.emit({ type: "assistant_text", delta: ev.delta })
      }
    }
  } catch (e) {
    const message = e instanceof LLMError ? e.message : (e as Error).message
    return { error: message }
  }
  return { message: assembleFromEvents(events).message }
}

/** Dispatch the turn's tool calls serially. Returns the result blocks, or
 *  `{ aborted: true }` if the signal tripped mid-loop. */
const dispatchTurnTools = async (
  config: AgentConfig,
  toolCalls: Extract<AssembledMessage["content"][number], { type: "tool_use" }>[],
): Promise<{ resultBlocks: AssembledMessage["content"] } | { aborted: true }> => {
  const resultBlocks = []
  for (const call of toolCalls) {
    if (config.signal.aborted) return { aborted: true }
    config.stream.emit({ type: "tool_call", id: call.id, name: call.name, input: call.input })

    const { block, ok, preview } = await dispatchTool(call, config, config.permission)
    config.stream.emit({ type: "tool_result", id: call.id, name: call.name, ok, preview })
    resultBlocks.push(block)
  }
  return { resultBlocks }
}

export const runAgent = async (config: AgentConfig): Promise<AgentOutcome> => {
  const { stream, registry } = config
  const messages: Message[] = [...config.messages]
  const specs = registry.specs()

  const finish = (reason: StopReason, turns: number): AgentOutcome => {
    stream.emit({ type: "done", reason, turns })
    return { reason, turns, messages }
  }

  for (let turn = 1; turn <= config.maxTurns; turn++) {
    if (config.signal.aborted) return finish("aborted", turn - 1)
    stream.emit({ type: "turn_start", turn })

    const result = await consumeTurnStream(config, messages, specs)
    if ("error" in result) {
      stream.emit({ type: "error", message: result.error })
      return finish("error", turn)
    }

    const { message } = result
    messages.push(message)

    const toolCalls = message.content.filter((b) => b.type === "tool_use")
    if (toolCalls.length === 0) return finish("completed", turn)

    const dispatched = await dispatchTurnTools(config, toolCalls)
    if ("aborted" in dispatched) return finish("aborted", turn)

    messages.push({ role: "user", content: dispatched.resultBlocks })
  }

  return finish("max_turns", config.maxTurns)
}
