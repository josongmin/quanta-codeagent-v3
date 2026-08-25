/**
 * RFC-03 C1 / GOAL-01 — the CLOSED objective mutation union.
 *
 * Every write to the objective domain is one of these typed variants. The
 * authority (`./authority`) is the ONLY writer and dispatches on `kind`; a
 * `Record<ObjectiveOperationKind, …>` dispatch table makes adding a variant to
 * this union without routing it a COMPILE error, and the two-way guard below
 * (mirroring the `src/tool/objective/index.ts` enum pattern) makes the runtime
 * floor exact — so the mutation-completeness ratchet
 * (`tests/unit/objective/mutation-completeness.test.ts`) fires if any operation
 * stops flowing through the authority.
 *
 * GOAL-01 removed `set` (⇒ `create` | `replace`), `updateStatus` (⇒
 * `setExplicitStatus`, `active | paused` only) and `recordUsage` (⇒
 * `settleAttempt`, HOST-measured). Kinds owned by later tickets
 * (`applyVerificationBatch` / `invalidateVerification` — GOAL-03;
 * `beginAttempt` — GOAL-04; `observeBlocker` — GOAL-09) are added by their
 * owners: the exhaustive tables make each addition a compile-checked change.
 *
 * SLICE FENCE: imports ONLY sibling modules. Pure data.
 *
 * exactOptionalPropertyTypes: optional fields are typed `x?: T | undefined`.
 */

import type { VerifierCompletionReceipt } from "./criteria/model"
import type { ObjectiveDomainSnapshot } from "./model"
import type { ProgressTurnOutcome } from "./progress-receipt"
import type {
  ExplicitObjectiveStatus,
  GoalDefinition,
  ObjectiveBudgetLimit,
  WaitingOn,
} from "./types"

export type { CriterionDeclaration } from "./criteria/model"
export type { ObjectiveActor } from "./provenance"
export { isObjectiveActor, OBJECTIVE_ACTORS } from "./provenance"

/**
 * GOAL-01 — the HOST-measured terminal settlement of one attributed attempt.
 * The authority (system actor only) debits the budget exactly once, computes
 * the criterion / verifier deltas from ITS OWN state (the `*Before` identity
 * sets are what the host captured when the attempt started) and appends one
 * bounded progress receipt. `attemptId` is the host's turn identity; a replay
 * is rejected. `objectiveId` binds the settlement to the generation it ran
 * against; a settlement for an older generation is rejected.
 */
export interface ObjectiveAttemptSettlement {
  readonly objectiveId: string
  readonly attemptId: string
  readonly startedRevision: number
  readonly tokensUsed: number
  readonly turnsUsed: 0 | 1
  readonly outcome: ProgressTurnOutcome
  readonly executionMode: "foreground" | "background"
  readonly criterionIdsBefore: readonly string[]
  readonly verifierReceiptIdsBefore: readonly string[]
  readonly sourceDigest?: string | undefined
  readonly recordedAt: number
}

/** The closed mutation union. */
export type ObjectiveMutation =
  | { kind: "create"; definition: GoalDefinition }
  | { kind: "replace"; definition: GoalDefinition }
  | { kind: "clear" }
  | { kind: "setExplicitStatus"; status: ExplicitObjectiveStatus }
  | { kind: "addBlocker"; reason: string; waitingOn: WaitingOn }
  | { kind: "clearBlocker"; blockerId: string }
  | { kind: "setNextActions"; actions: readonly string[] }
  | { kind: "markCriterion"; criterionId: string; met: boolean }
  /** RFC-03 C4 — the VERIFIER-ONLY checked-criterion completion. Carries the
   *  full verifier receipt; the authority admits it ONLY for a `verifier` actor
   *  against a `checked` criterion whose `check.id` matches the receipt. No tool
   *  input schema maps to this kind (forgery stop-rule). GOAL-03 replaces it
   *  with the batch commit. */
  | { kind: "markCriterionVerified"; criterionId: string; receipt: VerifierCompletionReceipt }
  | { kind: "amendBudget"; budget: ObjectiveBudgetLimit }
  | { kind: "settleAttempt"; settlement: ObjectiveAttemptSettlement }
  | { kind: "markUsageLimited"; untilEpochMs: number }
  | { kind: "restore"; snapshot: ObjectiveDomainSnapshot }

export type ObjectiveOperationKind = ObjectiveMutation["kind"]

/**
 * The exhaustive operation-kind floor. `satisfies` proves array ⊆ union; the
 * reverse assert below proves every union member appears (adding a variant
 * without listing it here fails compile). Non-zero floor pins the ratchet.
 */
export const OBJECTIVE_OPERATION_KINDS = [
  "create",
  "replace",
  "clear",
  "setExplicitStatus",
  "addBlocker",
  "clearBlocker",
  "setNextActions",
  "markCriterion",
  "markCriterionVerified",
  "amendBudget",
  "settleAttempt",
  "markUsageLimited",
  "restore",
] as const satisfies readonly ObjectiveOperationKind[]

// Two-way drift guard: prove every union member is in the array above. Without
// it, a new variant could be added to the union and silently escape the floor.
type _AssertKind<T extends true> = T
export type _ObjectiveOperationKindDriftGuard = _AssertKind<
  ObjectiveOperationKind extends (typeof OBJECTIVE_OPERATION_KINDS)[number] ? true : false
>

const OPERATION_KIND_SET: ReadonlySet<string> = new Set(OBJECTIVE_OPERATION_KINDS)

/** Runtime membership predicate for the closed operation union. */
export const isObjectiveOperationKind = (v: unknown): v is ObjectiveOperationKind =>
  typeof v === "string" && OPERATION_KIND_SET.has(v)

/** The mutations that START a new objective generation (or end one). The
 *  authority drops every evidence family for the thread when one applies. */
export const GENERATION_MUTATION_KINDS = [
  "create",
  "replace",
  "clear",
] as const satisfies readonly ObjectiveOperationKind[]

export const isGenerationMutationKind = (kind: ObjectiveOperationKind): boolean =>
  (GENERATION_MUTATION_KINDS as readonly string[]).includes(kind)
