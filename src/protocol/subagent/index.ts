/**
 * Web/CLI subagent-observation protocol slice barrel.
 *
 * Sole import path for the multi-agent orchestration SUBSTRATE read-model shapes
 * + the `AgentEvent -> SubagentObservation` projection Wave 2 (CLI `/agents
 * --tree`, web Sub-Agents panel) taps. The projection owner lives in
 * `./projection`.
 */

export type {
  SubagentObservation,
  SubagentObservationStatus,
  SubagentObservationType,
  SubagentSink,
  SubagentSpawnObservation,
  SubagentStatusObservation,
} from "./projection"
export {
  isSubagentObservationType,
  projectToSubagentObservation,
  SUBAGENT_OBSERVATION_EVENT_TYPES,
  SUBAGENT_OBSERVATION_TYPES,
} from "./projection"
