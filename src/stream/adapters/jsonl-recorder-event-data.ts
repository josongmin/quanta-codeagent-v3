import type { AgentEvent } from "../types"

type EventOf<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>

export const llmRequestData = (event: EventOf<"llm_request">): Record<string, unknown> => ({
  model: event.model,
  ...(event.provider !== undefined ? { provider: event.provider } : {}),
  ...(event.surfaceId !== undefined ? { surfaceId: event.surfaceId } : {}),
  ...(event.transportId !== undefined ? { transportId: event.transportId } : {}),
  ...(event.authMode !== undefined ? { authMode: event.authMode } : {}),
  ...(event.policy !== undefined ? { policy: event.policy } : {}),
})

export const toolResultData = (event: EventOf<"tool_result">): Record<string, unknown> => ({
  name: event.name,
  ok: event.ok,
  stdoutTail: event.preview,
  ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
  ...(event.stderrTail !== undefined ? { stderrTail: event.stderrTail } : {}),
  ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
  ...(event.executedCommand !== undefined ? { executedCommand: event.executedCommand } : {}),
  ...(event.fullLogPath !== undefined ? { fullLogPath: event.fullLogPath } : {}),
})

export const recoveryData = (event: EventOf<"recovery">): Record<string, unknown> => ({
  reason: event.reason,
  ...(event.detail !== undefined ? { detail: event.detail } : {}),
})

export const usageData = (event: EventOf<"usage">): Record<string, unknown> => ({
  model: event.model,
  inputTokens: event.inputTokens,
  outputTokens: event.outputTokens,
  ...(event.cacheReadTokens !== undefined ? { cacheReadTokens: event.cacheReadTokens } : {}),
  costUsd: null,
})
