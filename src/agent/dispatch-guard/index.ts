/**
 * Dispatch-guard slice barrel (ADR-0229).
 *
 * Sibling composer over three already-shipped pure detectors
 * (`gitWriteProtectReason` / `decideBranchOnly` / `isHostAllowed`).
 * Default-OFF — wired by passing `config.dispatchGuard` into `@/agent`.
 */

export type { DefaultDispatchGuardOptions } from "./default-guard"
export { defaultDispatchGuard } from "./default-guard"
export { noOpDispatchGuard } from "./no-op-guard"
export type { DispatchGuard } from "./port"
export type { GuardDecision } from "./types"
export { ALL_GUARD_DECISION_KINDS } from "./types"
