/**
 * Default delegation-runner slice barrel (ADR-0283).
 *
 * Closed surface for spec-validated, depth-bounded mode-typed delegation.
 * Default-OFF: the loop never constructs a runner; surfaces opt in.
 */

export {
  type DefaultDelegationRunnerOpts,
  defaultDelegationRunner,
} from "./default-runner"
export { type HeadlessStubOpts, headlessDelegationRunner } from "./headless-stub"
export type { DelegationRunnerPort } from "./port"
export {
  ALL_RUNNER_ERROR_KINDS,
  type DelegateMode,
  type DelegateSpec,
  MAX_DEPTH,
  type RunnerError,
  type RunnerErrorKind,
} from "./types"
