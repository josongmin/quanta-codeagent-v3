/**
 * Closure engine — public barrel (jun-17 closure-driven runner).
 *
 * The closure engine is the GENERAL "how an agent verifies and closes an edit"
 * capability. Callers import `@/agent/closure` (not the leaf files). Existing
 * core fragments (verification-plan, owner-admission, fault-evidence,
 * gate-decision, primary-rail) are re-exported here as they are consolidated, so
 * the engine surface is one import. Adapters (bench/chat) supply inputs; the core
 * returns verdicts.
 */

export type { ExecObservation, PredicateResult, PrimaryRailStep, SuccessPredicate } from "./types"
export { evaluateSuccessPredicate } from "./evaluate-success-predicate"
export { buildPrimaryRailStep } from "./primary-rail-step"
