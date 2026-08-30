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
  | "blocked"

export type GoalReadoutValidationContract = "missing" | "manual-only" | "checked"
export type GoalReadoutWaitingOn = "user" | "tool" | "network" | "child_agent"
export type GoalReadoutLimitedBy = "user-budget" | "product-hard-cap" | "product-budget-ceiling"

export interface GoalReadoutBudgetView {
  readonly turnsUsed: number
  readonly tokensUsed: number
  readonly maxTurns?: number | undefined
  readonly maxTokens?: number | undefined
  readonly limitedBy?: GoalReadoutLimitedBy | undefined
}

export interface GoalReadoutBlockerView {
  readonly id: string
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
  readonly validationContract: GoalReadoutValidationContract
  readonly objective: GoalReadoutObjectiveView | null
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
  "blocked",
])
const VALIDATION = new Set<GoalReadoutValidationContract>(["missing", "manual-only", "checked"])
const WAITING_ON = new Set<GoalReadoutWaitingOn>(["user", "tool", "network", "child_agent"])
const LIMITED_BY = new Set<GoalReadoutLimitedBy>([
  "user-budget",
  "product-hard-cap",
  "product-budget-ceiling",
])

const optionalNonNegativeInteger = (value: unknown): value is number | undefined =>
  value === undefined || isNonNegativeInteger(value)

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
  if (
    typeof value.waitingOn !== "string" ||
    !WAITING_ON.has(value.waitingOn as GoalReadoutWaitingOn)
  ) {
    return null
  }
  return { id: value.id, reason: value.reason, waitingOn: value.waitingOn as GoalReadoutWaitingOn }
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

/** Total runtime boundary for untrusted HTTP JSON. */
export const decodeGoalReadoutData = (value: unknown): GoalReadoutData | null => {
  if (!isRecord(value) || value.kind !== "goal" || !isNonNegativeInteger(value.revision))
    return null
  if (
    typeof value.validationContract !== "string" ||
    !VALIDATION.has(value.validationContract as GoalReadoutValidationContract)
  ) {
    return null
  }
  const objective = value.objective === null ? null : decodeObjective(value.objective)
  if (value.objective !== null && objective === null) return null
  return {
    kind: "goal",
    revision: value.revision,
    validationContract: value.validationContract as GoalReadoutValidationContract,
    objective,
  }
}

/** Generated from the canonical objective check defaults. */
export const DEFAULT_OBJECTIVE_CHECK_TIMEOUT_MS = 120000
export const DEFAULT_OBJECTIVE_CHECK_SUCCESS_EXIT_CODES = [0] as const
