/**
 * N-phase HITL slice barrel (ADR-0243).
 *
 * Sibling of `plan-exit{,-flow}` — does NOT import them and does NOT modify
 * them. Plan-exit's pre-existing 3-way decision behavior is byte-identical
 * (no caller currently consumes this barrel; default-OFF).
 *
 * Wiring (call-site responsibility):
 *   1. Build a `PhaseSpec[]` describing the host's phase sequence
 *      (e.g. Cursor `["init","clarify","plan","feedback","breakdown",...]`).
 *   2. `const driver = createDefaultNPhaseDriver(specs)` — or inject a custom
 *      {@link NPhaseDriver} via `AgentConfig.nPhaseDriver?` (NOT WIRED yet).
 *   3. After each LLM/operator interaction, call `driver.transition(nextId)`
 *      or `driver.feedback({ phase, positive, context })`.
 *
 * No `AgentConfig` field is added in this slice — the wire-up is deferred
 * until at least one host (CLI repl or IDE) consumes the driver.
 */

export { createDefaultNPhaseDriver, NPhaseDriverConfigError } from "./default-driver"
export type { NPhaseDriver } from "./port"
export {
  ALL_FEEDBACK_ERROR_CODES,
  ALL_TRANSITION_DIRECTIONS,
  ALL_TRANSITION_ERROR_CODES,
  FeedbackError,
  type FeedbackErrorCode,
  type FeedbackResult,
  isFeedbackError,
  isTransitionError,
  type PhaseId,
  type PhaseSpec,
  type PhaseTransition,
  TransitionError,
  type TransitionErrorCode,
  UnknownPhaseError,
} from "./types"
