import {
  type SessionHostTurnEvent,
  type SessionHostTurnEventType,
} from "@/kernel/session"
import { sliceWholeChars } from "@/shared"
import type { AgentEvent, AgentEventType } from "@/stream"

type SessionHostTurnEventBridgeRegistry = {
  [K in AgentEventType]?: (event: Extract<AgentEvent, { type: K }>) => SessionHostTurnEvent | undefined
}

export const AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_BRIDGED_TYPES = [
  "assistant_text",
  "llm_request",
  "llm_continuation",
  "tool_call",
  "tool_result",
  "usage",
  "skill_scope_decision",
] as const satisfies readonly AgentEventType[]

export const AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_TYPES = [
  "assistant_text.delta",
  "llm.request",
  "llm.continuation",
  "tool.invoked",
  "tool.completed",
  "usage",
  "skill.scope.decision",
] as const satisfies readonly SessionHostTurnEventType[]

const AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_BRIDGE = {
  assistant_text: (event) =>
    event.delta.length > 0 ? { type: "assistant_text.delta", delta: event.delta } : undefined,
  llm_request: (event) => ({
    type: "llm.request",
    model: event.model,
    ...(event.provider !== undefined ? { provider: event.provider } : {}),
    ...(event.surfaceId !== undefined ? { surfaceId: event.surfaceId } : {}),
    ...(event.transportId !== undefined ? { transportId: event.transportId } : {}),
    ...(event.authMode !== undefined ? { authMode: event.authMode } : {}),
    ...(event.policy !== undefined ? { policy: event.policy } : {}),
  }),
  llm_continuation: (event) => ({
    type: "llm.continuation",
    ...(event.provider !== undefined ? { provider: event.provider } : {}),
    surfaceId: event.surfaceId,
    transportId: event.transportId,
    phase: event.phase,
    mode: event.mode,
    reason: event.reason,
    ...(event.statusCode !== undefined ? { statusCode: event.statusCode } : {}),
  }),
  tool_call: (event) => ({
    type: "tool.invoked",
    toolCallId: event.id,
    toolName: event.name,
    ...(event.input !== undefined ? { argsPreview: previewToolArgs(event.input) } : {}),
  }),
  tool_result: (event) => ({
    type: "tool.completed",
    toolCallId: event.id,
    toolName: event.name,
    outcome: event.ok ? "ok" : "error",
    ...(event.preview !== undefined && event.preview.length > 0
      ? { resultPreview: clampPreview(event.preview) }
      : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
  }),
  usage: (event) => ({
    type: "usage",
    promptTokens: event.inputTokens,
    completionTokens: event.outputTokens,
    totalTokens: event.inputTokens + event.outputTokens,
  }),
  skill_scope_decision: (event) => ({
    type: "skill.scope.decision",
    tool: event.tool,
    activeSkill: event.activeSkill,
    decision: event.decision,
    isReadOnly: event.isReadOnly,
  }),
  // ALBB-18 P3 fix — `progress_update` is deliberately NOT bridged. ALBB-18 mapped
  // it onto `assistant_text.delta`, but the kernel projection APPENDS that to
  // `streamingAssistantText` and re-emits a prose `turn.output.delta`, splicing a
  // mid-turn progress line ("Reading config file") INTO the model's streaming
  // reply — display corruption on the primary text channel. No non-prose host
  // event type exists to carry progress cleanly, and progress is already rendered
  // to CLI stdout separately (`renderProgressUpdate` in stream/adapters/stdout.ts),
  // so the correct behavior is to drop it from the bridge entirely (no regression).
} satisfies SessionHostTurnEventBridgeRegistry

export const toSessionHostTurnEvent = (event: AgentEvent): SessionHostTurnEvent | undefined => {
  const handler = (
    AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_BRIDGE as Partial<
      Record<AgentEventType, (event: AgentEvent) => SessionHostTurnEvent | undefined>
    >
  )[event.type]
  return handler?.(event)
}

const PREVIEW_MAX = 256

const clampPreview = (text: string): string =>
  text.length <= PREVIEW_MAX ? text : `${sliceWholeChars(text, PREVIEW_MAX - 1)}…`

const previewToolArgs = (input: unknown): string => {
  let serialised: string
  try {
    serialised = typeof input === "string" ? input : JSON.stringify(input)
  } catch {
    return "<unserialisable>"
  }
  return clampPreview(serialised)
}
