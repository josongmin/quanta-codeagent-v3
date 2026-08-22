/**
 * Central agent-state projection ownership.
 *
 * Owns the closed tapped inventory plus the two pure read-model projectors:
 *
 *   AgentEvent -> AgentStateObservation
 *   AgentStateObservation -> AgentStateMessage
 *
 * The tap (`wireAgentStateTap`) and the daemon WS forwarder both route through
 * this module so widening the side channel now requires an intentional update
 * at one owner seam instead of drifting across independent filter/mapper code.
 */

import type { ItemStreamCore } from "@/shared/item-stream"
import type {
  AgentEvent,
  PlanDeltaKindMirror,
  PlanDeltaReadonlyMirror,
  PlanReadonlyMirror,
  TodoReadonlyMirror,
  TodoStatusMirror,
} from "@/stream"
import type {
  AgentStateMessage,
  AgentStateMessageKind,
  ContextCompactedMessage,
  ItemCompletedMessage,
  ItemDeltaMessage,
  ItemStartedMessage,
  ModeChangedMessage,
  PlanCreatedMessage,
  PlanInputChoiceDetail,
  PlanInputRequestedMessage,
  PlanInputResolvedMessage,
  PlanSnapshotMessage,
  PlanUpdatedMessage,
  RatelimitSnapshotMessage,
  ToolProgressMessage,
} from "./messages"

export type AgentStateTodoStatus = TodoStatusMirror
export type AgentStateTodo = TodoReadonlyMirror
export type AgentStatePlan = PlanReadonlyMirror
export type AgentStatePlanDeltaKind = PlanDeltaKindMirror
export type AgentStatePlanDelta = PlanDeltaReadonlyMirror

export const AGENT_STATE_OBSERVATION_EVENT_TYPES = [
  "plan_created",
  "plan_updated",
  "plan_snapshot",
  "plan_user_input_requested",
  "plan_user_input_resolved",
  "mode_changed",
  "tool_progress",
  "context_compacted",
  "ratelimit_snapshot",
] as const

export type AgentStateObservationType = (typeof AGENT_STATE_OBSERVATION_EVENT_TYPES)[number]

export const AGENT_STATE_TYPES: ReadonlySet<AgentStateObservationType> =
  new Set<AgentStateObservationType>(AGENT_STATE_OBSERVATION_EVENT_TYPES)

export const isAgentStateObservationType = (value: unknown): value is AgentStateObservationType =>
  typeof value === "string" &&
  (AGENT_STATE_OBSERVATION_EVENT_TYPES as readonly string[]).includes(value)

/** The 1:1 AgentEvent-subset observations (the original 9 tapped types). */
export type AgentStateEventObservation = Extract<AgentEvent, { type: AgentStateObservationType }>

/**
 * T01 — a SYNTHETIC observation carrying one {@link ItemStreamCore}. Unlike the
 * 9 event observations it is NOT a 1:1 projection of a single AgentEvent — the
 * stateful {@link ItemStreamProjector} (the SINGLE source) produces it from a
 * RUN of events. It rides the SAME agent-state channel so the daemon forwarder
 * (`agentStateObservationToMessage`) maps it onto an `item.*` message with no
 * forwarder change.
 */
export interface ItemStreamObservation {
  readonly type: "item_stream"
  readonly item: ItemStreamCore
}

/** UUX-2-17 — the `plan_user_input_requested` observation arm, widened with
 *  the OPTIONAL `choiceDetails` a rich producer (the web ask_user port) can
 *  attach. The AgentEvent-derived producer path never sets it (the event has
 *  no such field), so every pre-existing producer stays assignable unchanged. */
export type PlanUserInputRequestedObservation = Extract<
  AgentStateEventObservation,
  { type: "plan_user_input_requested" }
> & {
  readonly choiceDetails?: readonly PlanInputChoiceDetail[]
}

/** Every observation the agent-state channel carries. */
export type AgentStateObservation =
  | Exclude<AgentStateEventObservation, { type: "plan_user_input_requested" }>
  | PlanUserInputRequestedObservation
  | ItemStreamObservation

export interface AgentStateSink {
  capture(event: AgentStateObservation): void
}

export const AGENT_STATE_MESSAGE_KIND_BY_EVENT_TYPE = {
  plan_created: "plan.created",
  plan_updated: "plan.updated",
  plan_snapshot: "plan.snapshot",
  plan_user_input_requested: "plan.input.requested",
  plan_user_input_resolved: "plan.input.resolved",
  mode_changed: "mode.changed",
  tool_progress: "tool.progress",
  context_compacted: "context.compacted",
  ratelimit_snapshot: "ratelimit.snapshot",
} as const satisfies Record<AgentStateObservationType, AgentStateMessageKind>

type ObservationOf<K extends AgentStateObservationType> = Extract<
  AgentStateObservation,
  { type: K }
>
type MessageOf<K extends AgentStateObservationType> = Extract<
  AgentStateMessage,
  { kind: (typeof AGENT_STATE_MESSAGE_KIND_BY_EVENT_TYPE)[K] }
>

type ObservationProjector<K extends AgentStateObservationType> = (
  event: Extract<AgentEvent, { type: K }>,
) => ObservationOf<K>

type MessageProjector<K extends AgentStateObservationType> = (
  observation: ObservationOf<K>,
  emittedAt: number,
) => MessageOf<K>

const AGENT_STATE_OBSERVATION_PROJECTORS = {
  plan_created: (event) => ({ type: "plan_created", plan: event.plan }),
  plan_updated: (event) => ({
    type: "plan_updated",
    delta: event.delta,
    version: event.version,
  }),
  plan_snapshot: (event) => ({ type: "plan_snapshot", plan: event.plan }),
  plan_user_input_requested: (event) => ({
    type: "plan_user_input_requested",
    promptId: event.promptId,
    prompt: event.prompt,
    ...(event.choices !== undefined ? { choices: event.choices } : {}),
  }),
  plan_user_input_resolved: (event) => ({
    type: "plan_user_input_resolved",
    promptId: event.promptId,
    decision: event.decision,
    ...(event.text !== undefined ? { text: event.text } : {}),
  }),
  mode_changed: (event) => ({
    type: "mode_changed",
    from: event.from,
    to: event.to,
    ...(event.fromAgentMode !== undefined ? { fromAgentMode: event.fromAgentMode } : {}),
    ...(event.toAgentMode !== undefined ? { toAgentMode: event.toAgentMode } : {}),
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
  }),
  tool_progress: (event) => ({
    type: "tool_progress",
    id: event.id,
    name: event.name,
    message: event.message,
  }),
  context_compacted: (event) => ({
    type: "context_compacted",
    fromTurnId: event.fromTurnId,
    toTurnId: event.toTurnId,
    summary: event.summary,
    ts: event.ts,
    tokens: event.tokens,
  }),
  ratelimit_snapshot: (event) => ({
    type: "ratelimit_snapshot",
    ...(event.requestsRemaining !== undefined
      ? { requestsRemaining: event.requestsRemaining }
      : {}),
    ...(event.requestsResetMs !== undefined ? { requestsResetMs: event.requestsResetMs } : {}),
    ...(event.tokensRemaining !== undefined ? { tokensRemaining: event.tokensRemaining } : {}),
    ...(event.tokensResetMs !== undefined ? { tokensResetMs: event.tokensResetMs } : {}),
    observedAt: event.observedAt,
  }),
} satisfies {
  [K in AgentStateObservationType]: ObservationProjector<K>
}

const TEXT_CLAMP = 256

const clamp = (value: string): string =>
  value.length > TEXT_CLAMP ? value.slice(0, TEXT_CLAMP) : value

const AGENT_STATE_MESSAGE_PROJECTORS = {
  plan_created: (observation, emittedAt) => ({
    kind: "plan.created",
    plan: observation.plan,
    emittedAt,
  }),
  plan_updated: (observation, emittedAt) => ({
    kind: "plan.updated",
    delta: observation.delta,
    version: observation.version,
    emittedAt,
  }),
  plan_snapshot: (observation, emittedAt) => ({
    kind: "plan.snapshot",
    plan: observation.plan,
    emittedAt,
  }),
  plan_user_input_requested: (observation, emittedAt) => ({
    kind: "plan.input.requested",
    promptId: observation.promptId,
    prompt: observation.prompt,
    ...(observation.choices !== undefined ? { choices: observation.choices } : {}),
    // UUX-2-17 — optional rich chip detail; absent ⇒ wire byte-identical.
    ...(observation.choiceDetails !== undefined
      ? { choiceDetails: observation.choiceDetails }
      : {}),
    emittedAt,
  }),
  plan_user_input_resolved: (observation, emittedAt) => ({
    kind: "plan.input.resolved",
    promptId: observation.promptId,
    decision: observation.decision,
    ...(observation.text !== undefined ? { text: observation.text } : {}),
    emittedAt,
  }),
  mode_changed: (observation, emittedAt) => ({
    kind: "mode.changed",
    from: observation.from,
    to: observation.to,
    ...(observation.fromAgentMode !== undefined
      ? { fromAgentMode: observation.fromAgentMode }
      : {}),
    ...(observation.toAgentMode !== undefined ? { toAgentMode: observation.toAgentMode } : {}),
    ...(observation.reason !== undefined ? { reason: observation.reason } : {}),
    emittedAt,
  }),
  tool_progress: (observation, emittedAt) => ({
    kind: "tool.progress",
    toolCallId: observation.id,
    toolName: observation.name,
    message: clamp(observation.message),
    emittedAt,
  }),
  context_compacted: (observation, emittedAt) => ({
    kind: "context.compacted",
    fromTurnId: observation.fromTurnId,
    toTurnId: observation.toTurnId,
    summary: clamp(observation.summary),
    ts: observation.ts,
    tokens: observation.tokens,
    emittedAt,
  }),
  ratelimit_snapshot: (observation, emittedAt) => ({
    kind: "ratelimit.snapshot",
    ...(observation.requestsRemaining !== undefined
      ? { requestsRemaining: observation.requestsRemaining }
      : {}),
    ...(observation.requestsResetMs !== undefined
      ? { requestsResetMs: observation.requestsResetMs }
      : {}),
    ...(observation.tokensRemaining !== undefined
      ? { tokensRemaining: observation.tokensRemaining }
      : {}),
    ...(observation.tokensResetMs !== undefined
      ? { tokensResetMs: observation.tokensResetMs }
      : {}),
    observedAt: observation.observedAt,
    emittedAt,
  }),
} satisfies {
  plan_created: MessageProjector<"plan_created">
  plan_updated: MessageProjector<"plan_updated">
  plan_snapshot: MessageProjector<"plan_snapshot">
  plan_user_input_requested: MessageProjector<"plan_user_input_requested">
  plan_user_input_resolved: MessageProjector<"plan_user_input_resolved">
  mode_changed: MessageProjector<"mode_changed">
  tool_progress: MessageProjector<"tool_progress">
  context_compacted: MessageProjector<"context_compacted">
  ratelimit_snapshot: MessageProjector<"ratelimit_snapshot">
}

export interface AgentStateProjectionOptions {
  readonly emittedAt?: number
}

const emittedAtOf = (opts?: AgentStateProjectionOptions): number => opts?.emittedAt ?? Date.now()

export const projectAgentEventToAgentStateObservation = (
  event: AgentEvent,
): AgentStateObservation | null => {
  if (!isAgentStateObservationType(event.type)) return null
  switch (event.type) {
    case "plan_created":
      return AGENT_STATE_OBSERVATION_PROJECTORS.plan_created(event)
    case "plan_updated":
      return AGENT_STATE_OBSERVATION_PROJECTORS.plan_updated(event)
    case "plan_snapshot":
      return AGENT_STATE_OBSERVATION_PROJECTORS.plan_snapshot(event)
    case "plan_user_input_requested":
      return AGENT_STATE_OBSERVATION_PROJECTORS.plan_user_input_requested(event)
    case "plan_user_input_resolved":
      return AGENT_STATE_OBSERVATION_PROJECTORS.plan_user_input_resolved(event)
    case "mode_changed":
      return AGENT_STATE_OBSERVATION_PROJECTORS.mode_changed(event)
    case "tool_progress":
      return AGENT_STATE_OBSERVATION_PROJECTORS.tool_progress(event)
    case "context_compacted":
      return AGENT_STATE_OBSERVATION_PROJECTORS.context_compacted(event)
    case "ratelimit_snapshot":
      return AGENT_STATE_OBSERVATION_PROJECTORS.ratelimit_snapshot(event)
  }
}

/**
 * T01 — SSOT mapper: one {@link ItemStreamCore} → its `item.*` agent-state
 * message. This is the AGENT-STATE half of the dual-plane projection; the
 * SESSION-WIRE half lives in `@/kernel/session/session-host-turn-event-projection`
 * (`item.stream` case). The drift ratchet
 * (`tests/unit/item-stream-projection-drift-hellgate.test.ts`) feeds one core to
 * BOTH and asserts the carried fields are identical — the "single path" proof.
 */
export const itemCoreToAgentStateMessage = (
  item: ItemStreamCore,
  emittedAt: number,
): ItemStartedMessage | ItemDeltaMessage | ItemCompletedMessage => {
  if (item.phase === "started") {
    return {
      kind: "item.started",
      itemId: item.itemId,
      itemType: item.itemType,
      itemIndex: item.index,
      emittedAt,
    }
  }
  if (item.phase === "delta") {
    return {
      kind: "item.delta",
      itemId: item.itemId,
      itemType: item.itemType,
      deltaKind: item.deltaKind,
      delta: item.delta,
      emittedAt,
    }
  }
  return {
    kind: "item.completed",
    itemId: item.itemId,
    itemType: item.itemType,
    ...(item.text !== undefined ? { text: item.text } : {}),
    emittedAt,
  }
}

export const agentStateObservationToMessage = (
  observation: AgentStateObservation,
  opts?: AgentStateProjectionOptions,
): AgentStateMessage => {
  const emittedAt = emittedAtOf(opts)
  if (observation.type === "item_stream") {
    return itemCoreToAgentStateMessage(observation.item, emittedAt)
  }
  switch (observation.type) {
    case "plan_created":
      return AGENT_STATE_MESSAGE_PROJECTORS.plan_created(observation, emittedAt)
    case "plan_updated":
      return AGENT_STATE_MESSAGE_PROJECTORS.plan_updated(observation, emittedAt)
    case "plan_snapshot":
      return AGENT_STATE_MESSAGE_PROJECTORS.plan_snapshot(observation, emittedAt)
    case "plan_user_input_requested":
      return AGENT_STATE_MESSAGE_PROJECTORS.plan_user_input_requested(observation, emittedAt)
    case "plan_user_input_resolved":
      return AGENT_STATE_MESSAGE_PROJECTORS.plan_user_input_resolved(observation, emittedAt)
    case "mode_changed":
      return AGENT_STATE_MESSAGE_PROJECTORS.mode_changed(observation, emittedAt)
    case "tool_progress":
      return AGENT_STATE_MESSAGE_PROJECTORS.tool_progress(observation, emittedAt)
    case "context_compacted":
      return AGENT_STATE_MESSAGE_PROJECTORS.context_compacted(observation, emittedAt)
    case "ratelimit_snapshot":
      return AGENT_STATE_MESSAGE_PROJECTORS.ratelimit_snapshot(observation, emittedAt)
  }
}

export const projectAgentEventToAgentStateMessage = (
  event: AgentEvent,
  opts?: AgentStateProjectionOptions,
): AgentStateMessage | null => {
  const observation = projectAgentEventToAgentStateObservation(event)
  return observation === null ? null : agentStateObservationToMessage(observation, opts)
}

export const agentEventToMessage = (
  observation: AgentStateObservation,
  opts?: AgentStateProjectionOptions,
): AgentStateMessage => agentStateObservationToMessage(observation, opts)

export type {
  ContextCompactedMessage,
  ItemCompletedMessage,
  ItemDeltaMessage,
  ItemStartedMessage,
  ModeChangedMessage,
  PlanCreatedMessage,
  PlanInputRequestedMessage,
  PlanInputResolvedMessage,
  PlanSnapshotMessage,
  PlanUpdatedMessage,
  RatelimitSnapshotMessage,
  ToolProgressMessage,
}
