/**
 * Web agent-state protocol slice barrel.
 *
 * Sole import path for the agent-state WS protocol types + codec helpers +
 * projection helpers. Wire schema lives in `./messages`; the central
 * AgentEvent->read-model projection owner lives in `./projection`.
 */

export type {
  AgentStateMessage,
  AgentStateMessageKind,
  AgentStateWireEnvelope,
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
export {
  AGENT_STATE_MESSAGE_KINDS,
  AGENT_STATE_PROTOCOL_VERSION,
  decodeAgentStateFrame,
  encodeAgentStateFrame,
  isAgentStateMessage,
  isAgentStateMessageKind,
} from "./messages"
export type {
  AgentStateEventObservation,
  AgentStateObservation,
  AgentStateObservationType,
  AgentStatePlan,
  AgentStatePlanDelta,
  AgentStatePlanDeltaKind,
  AgentStateSink,
  AgentStateTodo,
  AgentStateTodoStatus,
  ItemStreamObservation,
  PlanUserInputRequestedObservation,
} from "./projection"
export {
  AGENT_STATE_MESSAGE_KIND_BY_EVENT_TYPE,
  AGENT_STATE_OBSERVATION_EVENT_TYPES,
  AGENT_STATE_TYPES,
  agentEventToMessage,
  agentStateObservationToMessage,
  isAgentStateObservationType,
  itemCoreToAgentStateMessage,
  projectAgentEventToAgentStateMessage,
  projectAgentEventToAgentStateObservation,
} from "./projection"
