/**
 * T-301 — VerificationPlan public barrel. Re-exports the builder + types so
 * callers import `@/agent/verification-plan` (consistent with sibling artifact
 * modules) without reaching into `./build` / `./types`.
 */
export { buildVerificationPlan } from "./build"
export {
  extractIssueDeclaredExpected,
  type IssueDeclaredExpected,
  type IssueDeclaredKind,
} from "./extract-issue-declared-expected"
export type {
  SuccessPredicate,
  VerificationAuthority,
  VerificationPlan,
  VerificationPlanInput,
  VerificationStep,
  VerificationStepKind,
} from "./types"
