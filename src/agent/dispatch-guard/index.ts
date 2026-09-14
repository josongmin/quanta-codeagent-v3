/**
 * Dispatch-guard slice barrel (ADR-0229).
 *
 * Sibling composer over three already-shipped pure detectors
 * (`gitWriteProtectReason` / `decideBranchOnly` / `isHostAllowed`).
 * Default-OFF — wired by passing `config.dispatchGuard` into `@/agent`.
 */

export type { DefaultDispatchGuardOptions } from "./default-guard"
export { defaultDispatchGuard } from "./default-guard"
export { DENY_ALL_PERMITTED_TOOLS, isPermittedUnderDenyAll } from "./deny-all-permitted"
export type { NetworkGuardSpec, NetworkPosture } from "./network-guard"
export { buildNetworkDispatchGuard } from "./network-guard"
export { noOpDispatchGuard } from "./no-op-guard"
export type { DispatchGuard, GuardCallFacts } from "./port"
export type { QuestionAvailabilityReader } from "./question-availability"
export {
  livePostureQuestionReader,
  questionAvailability,
  turnModeFromCollab,
} from "./question-availability"
export type { GuardDecision } from "./types"
export { ALL_GUARD_DECISION_KINDS } from "./types"
