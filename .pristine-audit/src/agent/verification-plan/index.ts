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
  PUBLIC_ISSUE_TEXT_PROVENANCE,
} from "./extract-issue-declared-expected"
export {
  extractIssueRepro,
  extractIssueReproSeed,
  type IssueRepro,
  type IssueReproSeed,
} from "./extract-issue-repro"
export type {
  SuccessPredicate,
  VerificationAuthority,
  VerificationPlan,
  VerificationPlanInput,
  VerificationStep,
  VerificationStepKind,
} from "./types"
