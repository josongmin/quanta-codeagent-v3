/**
 * ADR-0394 — Objective slice barrel.
 *
 * The ONLY allowed import path for the objective model + authority. Importing
 * this barrel allocates nothing and mutates no process state until a host
 * calls `createObjectiveStore()` / `createObjectiveAuthority()`.
 */

// GOAL-04 — attributed attempts (host-minted, two-phase durable accounting).
export type {
  ObjectiveAttemptContext,
  ObjectiveAttemptProvenance,
  ObjectiveAttemptSlot,
  ObjectiveAttemptSlotStatus,
  ObjectiveAttemptStart,
  ObjectiveAttemptState,
  StartedObjectiveAttempt,
} from "./attempt"
export { createObjectiveAttemptSlot, isObjectiveAttemptProvenance } from "./attempt"
// RFC-03 C1 — the public store constructor returns the revisioned authority
// (typed as `ObjectivePort`); the richer protocol is recovered via
// `asObjectiveAuthority`. There is no un-revisioned store constructor exported.
export {
  asObjectiveAuthority,
  createObjectiveAuthority,
  createObjectiveStore,
  isObjectiveAuthority,
  objectiveMutationDispatchKeys,
} from "./authority"
export { clampBudgetLimit, PRODUCT_BUDGET_CEILING } from "./budget-limits"
export type {
  CommitOptions,
  ContinuationObjectiveMutation,
  ModelObjectiveMutation,
  ObjectiveCapabilities,
  ObjectiveCommands,
  PreparedCommand,
  SystemObjectiveCommands,
  UserObjectiveMutation,
  VerifierObjectiveMutation,
} from "./capabilities"
export { asObjectiveReadPort, createObjectiveCapabilities } from "./capabilities"
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
  CheckRunInput,
  CheckRunResult,
  ObjectiveCheckRunner,
  ObjectiveVerificationPort,
  ReconcileOutcome,
  VerificationBatch,
  VerificationBatchResult,
  VerificationInvalidationReason,
  VerificationOutcome,
  WorkspaceEvidence,
  WorkspaceEvidenceFailure,
  WorkspaceEvidencePort,
} from "./criteria/ports"
export {
  checkPassed,
  isEvidenceFailure,
  MAX_BATCH_DEADLINE_MS,
  MAX_CHECK_TIMEOUT_MS,
  MAX_CHECKS_PER_BATCH,
} from "./criteria/ports"
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
  GoalBusyReason,
  GoalQuiescence,
  GoalWakeArm,
  GoalWakeAttempt,
  GoalWakeAttemptRegistry,
  GoalWakeAttemptReservation,
  GoalWakeController,
  GoalWakeControllerDeps,
  GoalWakeDecision,
  GoalWakeDecisionEvent,
  GoalWakeFireInput,
  GoalWakeSkipReason,
  GoalWakeStatus,
  GoalWakeTimer,
  GoalWakeTimerHandle,
} from "./goal-wake-controller"
export {
  createGoalWakeController,
  createInMemoryGoalWakeAttemptRegistry,
  evaluateGoalWakeArm,
  evaluateGoalWakeFire,
} from "./goal-wake-controller"
export type {
  AutonomousAllowance,
  AutonomousAllowanceInput,
  BudgetLimitSource,
  GoalWakeDelay,
  GoalWakeDelayReason,
  GoalWakeEligibility,
  GoalWakeIneligibleReason,
  GoalWakeSignal,
} from "./goal-wake-policy"
export {
  autonomousAllowance,
  clampGoalQuietMs,
  computeGoalWakeDelay,
  deriveWakeSignal,
  evaluateWakeEligibility,
  GOAL_PRODUCT_AUTONOMOUS_TURN_CAP,
  GOAL_WAKE_MAX_BACKOFF_MS,
  GOAL_WAKE_MIN_QUIET_MS,
  resolveProductAutonomousTurnCap,
} from "./goal-wake-policy"
// GOAL-01 — generation identity + the domain-owned goal-text ceiling.
export type { ObjectiveIdFactory } from "./identity"
export {
  defaultObjectiveIdFactory,
  isObjectiveIdLike,
  LEGACY_OBJECTIVE_ID_PREFIX,
  legacyObjectiveId,
  MAX_GOAL_CHARS,
  normalizeGoalText,
} from "./identity"
export type {
  ExplicitStatus,
  ObjectiveDomainSnapshot,
  ObjectiveThreadSnapshot,
  ValidationContract,
} from "./model"
export type {
  ObjectiveActor,
  ObjectiveAttemptSettlement,
  ObjectiveMutation,
  ObjectiveOperationKind,
} from "./mutations"
export {
  GENERATION_MUTATION_KINDS,
  isGenerationMutationKind,
  isObjectiveActor,
  isObjectiveOperationKind,
  OBJECTIVE_ACTORS,
  OBJECTIVE_OPERATION_KINDS,
} from "./mutations"
// GOAL-02 — the ONE policy (actor × mutation table, completion contract,
// transitions) and the actor-fixed capabilities composition mints over it.
export type { MutationPolicyTable, MutationVerdict } from "./policy"
export {
  assertMutationPolicyComplete,
  authorizeMutation,
  completionSatisfied,
  criterionSatisfied,
  MUTATION_POLICY,
  validationContractOf,
} from "./policy"
export type {
  ApprovalReceipt,
  CommitRejection,
  CommitResult,
  ObjectiveAuthority,
  ObjectiveAuthorityOptions,
  ObjectiveMutationCommand,
  ObjectiveReadPort,
  PreparedObjectiveMutation,
} from "./ports"
export type { ProgressReceipt, ProgressTurnOutcome } from "./progress-receipt"
export {
  appendProgressReceipt,
  isProgressTurnOutcome,
  MAX_PROGRESS_RECEIPTS,
  MAX_PROGRESS_REF_LENGTH,
  MAX_PROGRESS_REFS,
  normalizeProgressReceipt,
  PROGRESS_TURN_OUTCOMES,
  verifierReceiptRef,
} from "./progress-receipt"
export type { ObjectiveMigrationSource } from "./provenance"
export {
  buildPursuitContinuationPrompt,
  GOAL_PURSUIT_DISCIPLINE,
  type GoalPursuitCheckpoint,
} from "./pursuit-prompt"
export type { ObjectiveCore } from "./store"
export type {
  Blocker,
  CheckedCriterion,
  ExplicitObjectiveStatus,
  GoalDefinition,
  ManualCriterion,
  Objective,
  ObjectiveBudget,
  ObjectiveBudgetLimit,
  ObjectivePort,
  ObjectiveSnapshot,
  ObjectiveStatus,
  SuccessCriterion,
  WaitingOn,
} from "./types"
export { applyMeasuredUsageLimit, type UsageLimitPort } from "./usage-limit-wire"
