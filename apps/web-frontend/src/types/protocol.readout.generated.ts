/**
 * GENERATED — DO NOT EDIT.
 * Source of truth: `src/protocol/readout/goal.ts`.
 * Regenerate with `bun run build:protocol`.
 */

/**
 * Canonical structured payload for `GET /readout/goal`.
 *
 * `output` remains a human-readable compatibility surface. Browser controls
 * MUST consume this payload instead: rendered text is not an identity or CAS
 * carrier and cannot distinguish a genuinely absent goal from parser drift.
 *
 * Browser-safe by construction: no imports, no Node values. The deterministic
 * web generator copies this module verbatim into the standalone frontend.
 */

export type GoalReadoutStatus =
  | "active"
  | "paused"
  | "usage_limited"
  | "budget_limited"
  | "completed"
  | "completion_unconfirmed"
  | "blocked"

export type GoalReadoutValidationContract = "missing" | "manual-only" | "checked"
export type GoalReadoutWaitingOn = "user" | "tool" | "network" | "child_agent"
export type GoalReadoutLimitedBy = "user-budget" | "product-hard-cap" | "product-budget-ceiling"
export type GoalReadoutFreshness =
  | "fresh"
  | "invalidated"
  | "source-unavailable"
  | "cap-exceeded"
  | "freshness-unresolved"

export type GoalReadoutWakeView =
  | { readonly kind: "armed"; readonly delayMs: number; readonly wakeAt: number }
  | { readonly kind: "pending"; readonly delayMs: number; readonly retryAt: number }
  | {
      readonly kind: "idle"
      readonly skipReason: string
      readonly detail?: string | undefined
      readonly retryAt?: number | undefined
      readonly limitedBy?: GoalReadoutLimitedBy | undefined
    }
  | { readonly kind: "stopped" }

export interface GoalReadoutSettlementView {
  readonly turnOutcome:
    | "completed"
    | "max_turns"
    | "aborted"
    | "error"
    | "budget_exhausted"
    | "refusal"
    | "awaiting_approval"
    | "backgrounded"
  readonly objectiveRevisionBefore: number
  readonly objectiveRevisionAfter: number
  readonly recordedAt: number
  readonly criterionTransitions: number
  readonly remainingCriteria: number
}

export interface GoalReadoutBudgetView {
  readonly turnsUsed: number
  readonly tokensUsed: number
  readonly maxTurns?: number | undefined
  readonly maxTokens?: number | undefined
  readonly limitedBy?: GoalReadoutLimitedBy | undefined
}

export interface GoalReadoutBlockerView {
  readonly id: string
  readonly dependencyId?: string | undefined
  readonly reason: string
  readonly waitingOn: GoalReadoutWaitingOn
}

export interface GoalReadoutCheckView {
  readonly id: string
  readonly kind: "command"
  readonly argv: readonly string[]
  readonly timeoutMs: number
  readonly successExitCodes: readonly number[]
  readonly cwdPolicy: "thread"
}

export interface GoalReadoutManualCriterionView {
  readonly id: string
  readonly kind: "manual"
  readonly text: string
  readonly met: boolean
}

export interface GoalReadoutCheckedCriterionView {
  readonly id: string
  readonly kind: "checked"
  readonly text: string
  readonly met: boolean
  readonly check: GoalReadoutCheckView
}

export type GoalReadoutCriterionView =
  | GoalReadoutManualCriterionView
  | GoalReadoutCheckedCriterionView

export interface GoalReadoutObjectiveView {
  readonly objectiveId: string
  readonly goal: string
  readonly status: GoalReadoutStatus
  readonly budget: GoalReadoutBudgetView
  readonly startedAttemptId?: string | undefined
  readonly blockers: readonly GoalReadoutBlockerView[]
  readonly criteria: readonly GoalReadoutCriterionView[]
}

export interface GoalReadoutData {
  readonly kind: "goal"
  readonly revision: number
  readonly freshness: GoalReadoutFreshness
  readonly validationContract: GoalReadoutValidationContract
  readonly wake: GoalReadoutWakeView | null
  readonly latestSettlement: GoalReadoutSettlementView | null
  readonly objective: GoalReadoutObjectiveView | null
}

export const GOAL_STATE_PROTOCOL_VERSION = "goal-state.v1" as const

export interface GoalStateMessage {
  readonly kind: "goal.state"
  readonly emittedAt: number
  readonly state: GoalReadoutData
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const STATUS = new Set<GoalReadoutStatus>([
  "active",
  "paused",
  "usage_limited",
  "budget_limited",
  "completed",
  "completion_unconfirmed",
  "blocked",
])
const VALIDATION = new Set<GoalReadoutValidationContract>(["missing", "manual-only", "checked"])
const WAITING_ON = new Set<GoalReadoutWaitingOn>(["user", "tool", "network", "child_agent"])
const LIMITED_BY = new Set<GoalReadoutLimitedBy>([
  "user-budget",
  "product-hard-cap",
  "product-budget-ceiling",
])
const FRESHNESS = new Set<GoalReadoutFreshness>([
  "fresh",
  "invalidated",
  "source-unavailable",
  "cap-exceeded",
  "freshness-unresolved",
])

const optionalNonNegativeInteger = (value: unknown): value is number | undefined =>
  value === undefined || isNonNegativeInteger(value)

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0

const decodeBudget = (value: unknown): GoalReadoutBudgetView | null => {
  if (!isRecord(value)) return null
  if (!isNonNegativeInteger(value.turnsUsed) || !isNonNegativeInteger(value.tokensUsed)) return null
  if (!optionalNonNegativeInteger(value.maxTurns) || !optionalNonNegativeInteger(value.maxTokens)) {
    return null
  }
  if (
    value.limitedBy !== undefined &&
    (typeof value.limitedBy !== "string" ||
      !LIMITED_BY.has(value.limitedBy as GoalReadoutLimitedBy))
  ) {
    return null
  }
  return {
    turnsUsed: value.turnsUsed,
    tokensUsed: value.tokensUsed,
    ...(value.maxTurns !== undefined ? { maxTurns: value.maxTurns } : {}),
    ...(value.maxTokens !== undefined ? { maxTokens: value.maxTokens } : {}),
    ...(value.limitedBy !== undefined
      ? { limitedBy: value.limitedBy as GoalReadoutLimitedBy }
      : {}),
  }
}

const decodeBlocker = (value: unknown): GoalReadoutBlockerView | null => {
  if (!isRecord(value)) return null
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.reason)) return null
  if (value.dependencyId !== undefined && !isNonEmptyString(value.dependencyId)) return null
  if (
    typeof value.waitingOn !== "string" ||
    !WAITING_ON.has(value.waitingOn as GoalReadoutWaitingOn)
  ) {
    return null
  }
  return {
    id: value.id,
    ...(value.dependencyId !== undefined ? { dependencyId: value.dependencyId } : {}),
    reason: value.reason,
    waitingOn: value.waitingOn as GoalReadoutWaitingOn,
  }
}

const decodeCheck = (value: unknown): GoalReadoutCheckView | null => {
  if (!isRecord(value) || !isNonEmptyString(value.id)) return null
  if (value.kind !== "command" || value.cwdPolicy !== "thread") return null
  if (!Array.isArray(value.argv) || !value.argv.every((arg) => typeof arg === "string")) return null
  if (!isNonNegativeInteger(value.timeoutMs) || value.timeoutMs === 0) return null
  if (
    !Array.isArray(value.successExitCodes) ||
    !value.successExitCodes.every(Number.isSafeInteger)
  ) {
    return null
  }
  return {
    id: value.id,
    ...(isNonEmptyString(value.dependencyId) ? { dependencyId: value.dependencyId } : {}),
    kind: "command",
    argv: value.argv,
    timeoutMs: value.timeoutMs,
    successExitCodes: value.successExitCodes as number[],
    cwdPolicy: "thread",
  }
}

const decodeCriterion = (value: unknown): GoalReadoutCriterionView | null => {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.text)) return null
  if (typeof value.met !== "boolean") return null
  if (value.kind === "manual") {
    return { id: value.id, kind: "manual", text: value.text, met: value.met }
  }
  if (value.kind !== "checked") return null
  const check = decodeCheck(value.check)
  return check === null
    ? null
    : { id: value.id, kind: "checked", text: value.text, met: value.met, check }
}

const decodeObjective = (value: unknown): GoalReadoutObjectiveView | null => {
  if (!isRecord(value) || !isNonEmptyString(value.objectiveId)) return null
  if (!isNonEmptyString(value.goal)) return null
  if (typeof value.status !== "string" || !STATUS.has(value.status as GoalReadoutStatus))
    return null
  const budget = decodeBudget(value.budget)
  if (budget === null) return null
  if (value.startedAttemptId !== undefined && !isNonEmptyString(value.startedAttemptId)) return null
  if (!Array.isArray(value.blockers) || !Array.isArray(value.criteria)) return null
  const blockers = value.blockers.map(decodeBlocker)
  const criteria = value.criteria.map(decodeCriterion)
  if (blockers.some((entry) => entry === null) || criteria.some((entry) => entry === null))
    return null
  const blockerIds = blockers.map((entry) => entry?.id)
  const criterionIds = criteria.map((entry) => entry?.id)
  const checkIds = criteria.flatMap((entry) => (entry?.kind === "checked" ? [entry.check.id] : []))
  if (
    new Set(blockerIds).size !== blockerIds.length ||
    new Set(criterionIds).size !== criterionIds.length ||
    new Set(checkIds).size !== checkIds.length
  ) {
    return null
  }
  return {
    objectiveId: value.objectiveId,
    goal: value.goal,
    status: value.status as GoalReadoutStatus,
    budget,
    ...(value.startedAttemptId !== undefined ? { startedAttemptId: value.startedAttemptId } : {}),
    blockers: blockers as GoalReadoutBlockerView[],
    criteria: criteria as GoalReadoutCriterionView[],
  }
}

const decodeIdleWake = (value: Record<string, unknown>): GoalReadoutWakeView | null => {
  if (!isNonEmptyString(value.skipReason)) return null
  if (value.detail !== undefined && typeof value.detail !== "string") return null
  if (value.retryAt !== undefined && !isFiniteNonNegative(value.retryAt)) return null
  if (
    value.limitedBy !== undefined &&
    (typeof value.limitedBy !== "string" ||
      !LIMITED_BY.has(value.limitedBy as GoalReadoutLimitedBy))
  ) {
    return null
  }
  return {
    kind: "idle",
    skipReason: value.skipReason,
    ...(value.detail !== undefined ? { detail: value.detail } : {}),
    ...(value.retryAt !== undefined ? { retryAt: value.retryAt } : {}),
    ...(value.limitedBy !== undefined
      ? { limitedBy: value.limitedBy as GoalReadoutLimitedBy }
      : {}),
  }
}

const decodeWake = (value: unknown): GoalReadoutWakeView | null => {
  if (!isRecord(value) || typeof value.kind !== "string") return null
  switch (value.kind) {
    case "stopped":
      return { kind: "stopped" }
    case "armed":
      return isFiniteNonNegative(value.delayMs) && isFiniteNonNegative(value.wakeAt)
        ? { kind: "armed", delayMs: value.delayMs, wakeAt: value.wakeAt }
        : null
    case "pending":
      return isFiniteNonNegative(value.delayMs) && isFiniteNonNegative(value.retryAt)
        ? { kind: "pending", delayMs: value.delayMs, retryAt: value.retryAt }
        : null
    case "idle":
      return decodeIdleWake(value)
    default:
      return null
  }
}

const SETTLEMENT_OUTCOMES = new Set<GoalReadoutSettlementView["turnOutcome"]>([
  "completed",
  "max_turns",
  "aborted",
  "error",
  "budget_exhausted",
  "refusal",
  "awaiting_approval",
  "backgrounded",
])

const decodeSettlement = (value: unknown): GoalReadoutSettlementView | null => {
  if (!isRecord(value)) return null
  if (
    typeof value.turnOutcome !== "string" ||
    !SETTLEMENT_OUTCOMES.has(value.turnOutcome as GoalReadoutSettlementView["turnOutcome"])
  ) {
    return null
  }
  if (
    !isNonNegativeInteger(value.objectiveRevisionBefore) ||
    !isNonNegativeInteger(value.objectiveRevisionAfter) ||
    !isFiniteNonNegative(value.recordedAt) ||
    !isNonNegativeInteger(value.criterionTransitions) ||
    !isNonNegativeInteger(value.remainingCriteria)
  ) {
    return null
  }
  return {
    turnOutcome: value.turnOutcome as GoalReadoutSettlementView["turnOutcome"],
    objectiveRevisionBefore: value.objectiveRevisionBefore,
    objectiveRevisionAfter: value.objectiveRevisionAfter,
    recordedAt: value.recordedAt,
    criterionTransitions: value.criterionTransitions,
    remainingCriteria: value.remainingCriteria,
  }
}

const decodeGoalReadoutMetadata = (
  value: Record<string, unknown>,
): Pick<GoalReadoutData, "revision" | "freshness" | "validationContract"> | null => {
  if (!isNonNegativeInteger(value.revision)) return null
  if (
    typeof value.freshness !== "string" ||
    !FRESHNESS.has(value.freshness as GoalReadoutFreshness)
  ) {
    return null
  }
  if (
    typeof value.validationContract !== "string" ||
    !VALIDATION.has(value.validationContract as GoalReadoutValidationContract)
  ) {
    return null
  }
  return {
    revision: value.revision,
    freshness: value.freshness as GoalReadoutFreshness,
    validationContract: value.validationContract as GoalReadoutValidationContract,
  }
}

const decodeGoalReadoutRecord = (value: Record<string, unknown>): GoalReadoutData | null => {
  const metadata = decodeGoalReadoutMetadata(value)
  if (metadata === null) return null
  const objective = value.objective === null ? null : decodeObjective(value.objective)
  if (value.objective !== null && objective === null) return null
  const wake = value.wake === null || value.wake === undefined ? null : decodeWake(value.wake)
  if (value.wake !== null && value.wake !== undefined && wake === null) return null
  const latestSettlement =
    value.latestSettlement === null || value.latestSettlement === undefined
      ? null
      : decodeSettlement(value.latestSettlement)
  if (
    value.latestSettlement !== null &&
    value.latestSettlement !== undefined &&
    latestSettlement === null
  ) {
    return null
  }
  return {
    kind: "goal",
    ...metadata,
    wake,
    latestSettlement,
    objective,
  }
}

/** Total runtime boundary for untrusted HTTP JSON. */
export const decodeGoalReadoutData = (value: unknown): GoalReadoutData | null => {
  if (!isRecord(value) || value.kind !== "goal" || !isNonNegativeInteger(value.revision)) {
    return null
  }
  return decodeGoalReadoutRecord(value)
}

/** Goal state envelope codec for the default-ON browser channel. */
export const encodeGoalStateFrame = (message: GoalStateMessage): string =>
  JSON.stringify({
    version: GOAL_STATE_PROTOCOL_VERSION,
    kind: "goalState",
    payload: message,
  })

export const decodeGoalStateMessage = (value: unknown): GoalStateMessage | null => {
  if (!isRecord(value) || value.kind !== "goal.state" || !isFiniteNonNegative(value.emittedAt)) {
    return null
  }
  if (!isRecord(value.state) || !("wake" in value.state) || !("latestSettlement" in value.state)) {
    return null
  }
  const state = decodeGoalReadoutData(value.state)
  return state === null ? null : { kind: "goal.state", emittedAt: value.emittedAt, state }
}

/** Generated from the canonical objective check defaults. */
export const DEFAULT_OBJECTIVE_CHECK_TIMEOUT_MS = 120000
export const DEFAULT_OBJECTIVE_CHECK_SUCCESS_EXIT_CODES = [0] as const
