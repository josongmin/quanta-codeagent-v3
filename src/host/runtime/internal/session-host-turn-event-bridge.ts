import type { SessionHostTurnEvent, SessionHostTurnEventType } from "@/kernel/session"
import { sliceWholeChars } from "@/shared"
import type { AgentEvent, AgentEventType } from "@/stream"

type SessionHostTurnEventBridgeRegistry = {
  [K in AgentEventType]?: (
    event: Extract<AgentEvent, { type: K }>,
  ) => SessionHostTurnEvent | undefined
}

export const AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_BRIDGED_TYPES = [
  "assistant_text",
  "llm_request",
  "llm_continuation",
  "tool_call",
  "tool_progress",
  "tool_result",
  "usage",
  "skill_scope_decision",
  "recovery",
  "context_compacted",
  "budget_breach",
] as const satisfies readonly AgentEventType[]

export const AGENT_EVENT_TO_SESSION_HOST_TURN_EVENT_TYPES = [
  "assistant_text.delta",
  "llm.request",
  "llm.continuation",
  "tool.invoked",
  "tool.progress",
  "tool.completed",
  "usage",
  "skill.scope.decision",
  "recovery",
  "context.compacted",
  "budget.breach",
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
  // UUX-1-12 (jul-10) — the four HIGH-VALUE observability events, each on its
  // OWN non-prose host event type (never `assistant_text.delta` — see the
  // ALBB-18 note below). Free-text payloads are clamped so a runaway message
  // cannot bloat a wire frame; numeric/enum payloads are carried verbatim.
  tool_progress: (event) => ({
    type: "tool.progress",
    toolCallId: event.id,
    toolName: event.name,
    message: clampPreview(event.message),
  }),
  recovery: (event) => ({
    type: "recovery",
    reason: event.reason,
    ...(event.detail !== undefined ? { detail: clampPreview(event.detail) } : {}),
  }),
  context_compacted: (event) => ({
    type: "context.compacted",
    fromTurnId: event.fromTurnId,
    toTurnId: event.toTurnId,
    // The wire carries a bounded summary; the FULL archive entry stays in the
    // session recorder (ADR-0075) — the UI marker does not need a novel.
    summary: clampSummary(event.summary),
    ts: event.ts,
    tokens: event.tokens,
  }),
  budget_breach: (event) => ({
    type: "budget.breach",
    severity: event.severity,
    scope: event.scope,
    observed: event.observed,
    limit: event.limit,
  }),
  // ALBB-18 P3 fix — `progress_update` is deliberately NOT bridged. ALBB-18 mapped
  // it onto `assistant_text.delta`, but the kernel projection APPENDS that to
  // `streamingAssistantText` and re-emits a prose `turn.output.delta`, splicing a
  // mid-turn progress line ("Reading config file") INTO the model's streaming
  // reply — display corruption on the primary text channel. The UUX-1-12
  // expansion added DEDICATED non-prose channels for tool/recovery/compaction/
  // budget observability; `progress_update` remains excluded (documented
  // decision — its rendering channel is CLI stdout `renderProgressUpdate`).
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
/** Compaction summaries get a little more room than a tool preview — they
 *  replace whole conversation stretches — but stay bounded for the wire. */
const SUMMARY_MAX = 512

const clampPreview = (text: string): string =>
  text.length <= PREVIEW_MAX ? text : `${sliceWholeChars(text, PREVIEW_MAX - 1)}…`

const clampSummary = (text: string): string =>
  text.length <= SUMMARY_MAX ? text : `${sliceWholeChars(text, SUMMARY_MAX - 1)}…`

const previewToolArgs = (input: unknown): string => {
  let serialised: string
  try {
    serialised = typeof input === "string" ? input : JSON.stringify(input)
  } catch {
    return "<unserialisable>"
  }
  return clampPreview(serialised)
}
