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
// RFC-03 C4 — criterion declaration/provenance (manual/checked union + receipts)
// and the verifier-only checked-completion transition.
export type {
  CheckSpec,
  CheckSpecDeclaration,
  CompletionReceipt,
  CriterionDeclaration,
  CriterionKind,
  ManualCompletionReceipt,
  VerifierCompletionReceipt,
  VerifierResult,
} from "./criteria/model"
export {
  isManualReceipt,
  isVerifierReceipt,
  normalizeCheckDeclaration,
} from "./criteria/model"
export type {
  CheckExecutionContext,
  CheckExecutionPort,
  VerifierCompletionInput,
  VerifierCompletionPort,
} from "./criteria/verifier"
export {
  createVerifierCompletion,
  UNSUPPORTED_CHECK_EXECUTION,
  unsupportedCheckExecutionPort,
} from "./criteria/verifier"
export type {
  GoalWakeArm,
  GoalWakeAttempt,
  GoalWakeAttemptRegistry,
  GoalWakeAttemptReservation,
  GoalWakeController,
  GoalWakeControllerDeps,
  GoalWakeDecision,
  GoalWakeFireInput,
  GoalWakeSkipReason,
  GoalWakeTimer,
  GoalWakeTimerHandle,
} from "./goal-wake-controller"
export {
  createGoalWakeController,
  createInMemoryGoalWakeAttemptRegistry,
  evaluateGoalWakeArm,
  evaluateGoalWakeFire,
} from "./goal-wake-controller"
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
export type { ProgressReceipt, ProgressTurnOutcome } from "./progress-receipt"
export {
  appendProgressReceipt,
  MAX_PROGRESS_RECEIPTS,
  MAX_PROGRESS_REF_LENGTH,
  MAX_PROGRESS_REFS,
  normalizeProgressReceipt,
} from "./progress-receipt"
export {
  buildPursuitContinuationPrompt,
  GOAL_PURSUIT_DISCIPLINE,
  type GoalPursuitCheckpoint,
} from "./pursuit-prompt"
export type { ObjectiveCore } from "./store"
export type {
  Blocker,
  CheckedCriterion,
  ManualCriterion,
  Objective,
  ObjectiveBudget,
  ObjectivePort,
  ObjectiveSnapshot,
  ObjectiveStatus,
  SuccessCriterion,
  WaitingOn,
} from "./types"
export { applyMeasuredUsageLimit, type UsageLimitPort } from "./usage-limit-wire"
