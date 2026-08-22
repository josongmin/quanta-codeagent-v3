/**
 * ADR-0394 — Objective slice barrel.
 *
 * The ONLY allowed import path for the objective model + store. This wave is
 * MODEL ONLY: importing this barrel allocates nothing and mutates no process
 * state until a host calls `createObjectiveStore()`. It is NOT yet wired into
 * the agent loop, dispatch, features, prompt, or any tool.
 */

// RFC-03 C1 — the public store constructor now returns the revisioned authority
// (typed as `ObjectivePort`); the richer protocol is recovered via
// `asObjectiveAuthority`. There is no un-revisioned store constructor exported.
export {
  asObjectiveAuthority,
  createObjectiveAuthority,
  createObjectiveStore,
  isObjectiveAuthority,
  objectiveMutationDispatchKeys,
} from "./authority"
export type {
  ContinuationDecision,
  ContinuationDeps,
  ContinuationPermit,
  ContinuationRunResult,
  ContinuationSkipReason,
  GoalContinuationInput,
} from "./continuation"
export {
  ContinuationSemaphore,
  evaluateContinuation,
  runIdleContinuation,
} from "./continuation"
export type { ObjectiveDomainSnapshot, ObjectiveThreadSnapshot } from "./model"
export type { ObjectiveActor, ObjectiveMutation, ObjectiveOperationKind } from "./mutations"
export {
  isObjectiveActor,
  isObjectiveOperationKind,
  OBJECTIVE_ACTORS,
  OBJECTIVE_OPERATION_KINDS,
} from "./mutations"
export type {
  ApprovalReceipt,
  CommitRejection,
  CommitResult,
  ObjectiveAuthority,
  ObjectiveAuthorityOptions,
  ObjectiveMutationCommand,
  PreparedObjectiveMutation,
} from "./ports"
export { buildPursuitContinuationPrompt, GOAL_PURSUIT_DISCIPLINE } from "./pursuit-prompt"
export type { ObjectiveCore } from "./store"
export type {
  Blocker,
  Objective,
  ObjectiveBudget,
  ObjectivePort,
  ObjectiveSnapshot,
  ObjectiveStatus,
  SuccessCriterion,
  WaitingOn,
} from "./types"
export { applyMeasuredUsageLimit, type UsageLimitPort } from "./usage-limit-wire"
