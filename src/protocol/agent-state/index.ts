/**
 * Web agent-state protocol slice barrel.
 *
 * Sole import path for the agent-state WS protocol types + codec helpers + the
 * pure `agentEventToMessage` mapper. Slice fence: this module re-exports from
 * `./messages`, which is SELF-CONTAINED (no `@/agent` / `@/stream` runtime, no
 * CLI surface import).
 */

export type {
  AgentStateMessage,
  AgentStateMessageKind,
  AgentStateObservation,
  AgentStatePlan,
  AgentStatePlanDelta,
  AgentStatePlanDeltaKind,
  AgentStateSink,
  AgentStateTodo,
  AgentStateTodoStatus,
  AgentStateWireEnvelope,
  ContextCompactedMessage,
  ModeChangedMessage,
  PlanCreatedMessage,
  PlanInputRequestedMessage,
  PlanInputResolvedMessage,
  PlanSnapshotMessage,
  PlanUpdatedMessage,
  RatelimitSnapshotMessage,
  ToolProgressMessage,
} from "./messages"
export {
  AGENT_STATE_MESSAGE_KINDS,
  AGENT_STATE_PROTOCOL_VERSION,
  AGENT_STATE_TYPES,
  agentEventToMessage,
  decodeAgentStateFrame,
  encodeAgentStateFrame,
  isAgentStateMessage,
  isAgentStateMessageKind,
} from "./messages"
