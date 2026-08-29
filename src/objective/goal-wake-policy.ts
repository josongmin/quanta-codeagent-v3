import type { ObjectiveDomainSnapshot } from "./model"
import type { ProgressReceipt } from "./progress-receipt"

export const GOAL_QUIET_MIN_MS = 15_000
export const GOAL_MAX_BACKOFF_MS = 900_000
export const GOAL_MAX_AUTONOMOUS_TURNS = 20
export const GOAL_INFRA_COOLDOWN_MS = 300_000

export interface GoalWakePolicy {
  readonly minQuietMs: number
  readonly maxBackoffMs: number
  readonly maxAutonomousTurns: number
  readonly cooldownMs: number
}

export const DEFAULT_GOAL_WAKE_POLICY: GoalWakePolicy = Object.freeze({
  minQuietMs: GOAL_QUIET_MIN_MS,
  maxBackoffMs: GOAL_MAX_BACKOFF_MS,
  maxAutonomousTurns: GOAL_MAX_AUTONOMOUS_TURNS,
  cooldownMs: GOAL_INFRA_COOLDOWN_MS,
})

export type GoalWakeDelaySkip =
  | "no-goal"
  | "not-active"
  | "validation-contract-missing"
  | "autonomous-turn-cap"
  | "usage-limited"
  | "infra-cooldown"

/** GOAL-06 — which counter forbids the next autonomous attempt. */
export type BudgetLimitSource = "user-budget" | "product-hard-cap" | "product-budget-ceiling"

/** A caller-supplied cap may only LOWER the product cap (never raise it). */
export const resolveProductAutonomousTurnCap = (requested: number | undefined): number =>
  requested === undefined || !Number.isFinite(requested) || requested < 0
    ? GOAL_MAX_AUTONOMOUS_TURNS
    : Math.min(Math.floor(requested), GOAL_MAX_AUTONOMOUS_TURNS)

export interface AutonomousAllowance {
  readonly userRemaining: number
  readonly productRemaining: number
  readonly allowed: boolean
  readonly limitingSource?: BudgetLimitSource
}

/**
 * Hard-cap rule (both counters are authority state):
 *   userRemaining    = max(0, (userMaxTurns ?? ∞) - turnsUsed)
 *   productRemaining = max(0, productCap - autonomousTurnsStarted)
 *   allowed          = min(userRemaining, productRemaining) > 0
 * The product counter is the durable GOAL-04 `autonomousTurnsStarted`: a
 * user-requested goal turn moves `turnsUsed` but never the product counter.
 */
export const autonomousAllowance = (input: {
  readonly userMaxTurns?: number | undefined
  readonly turnsUsed: number
  readonly autonomousTurnsStarted: number
  readonly productCap?: number | undefined
}): AutonomousAllowance => {
  const cap = resolveProductAutonomousTurnCap(input.productCap)
  const userRemaining =
    input.userMaxTurns === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, input.userMaxTurns - input.turnsUsed)
  const productRemaining = Math.max(0, cap - input.autonomousTurnsStarted)
  const allowed = Math.min(userRemaining, productRemaining) > 0
  return {
    userRemaining,
    productRemaining,
    allowed,
    ...(allowed
      ? {}
      : { limitingSource: productRemaining <= 0 ? "product-hard-cap" : "user-budget" }),
  }
}

export type GoalWakeDelayDecision =
  | { readonly delayMs: number; readonly reason: "base" | "no-progress-backoff" }
  | {
      readonly skip: GoalWakeDelaySkip
      readonly retryAt?: number | undefined
      readonly limitedBy?: BudgetLimitSource | undefined
    }

export interface GoalWakeSettlementHint {
  readonly infraUnavailableAtRevision?: number | undefined
  readonly observedAt?: number | undefined
}

/** GOAL P0-1 — an `awaiting_approval` settlement is a PAUSE, not a stall: the
 *  body stopped to ask the operator, and the resumed body carries the progress.
 *  Counting it as no-progress doubled the quiet window on every approval and
 *  walked an approval-gated goal into its hard cap. */
const madeProgress = (receipt: ProgressReceipt): boolean =>
  receipt.turnOutcome === "awaiting_approval" ||
  receipt.criterionTransitions.length > 0 ||
  receipt.verifierReceiptRefs.length > 0

const consecutiveNoProgress = (receipts: readonly ProgressReceipt[]): number => {
  let count = 0
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const receipt = receipts[index]
    if (receipt === undefined || madeProgress(receipt)) break
    count += 1
  }
  return count
}

/** GOAL-06 — the public clamps: quiet ≥ 15 s, backoff ≤ 15 min, product cap
 *  ≤ 20. No NODE_ENV bypass, hidden dev flag, or public unsafe override. */
export const safePolicy = (policy: GoalWakePolicy): GoalWakePolicy => {
  const minQuietMs = Number.isFinite(policy.minQuietMs)
    ? Math.max(GOAL_QUIET_MIN_MS, Math.floor(policy.minQuietMs))
    : GOAL_QUIET_MIN_MS
  return {
    minQuietMs,
    maxBackoffMs: Number.isFinite(policy.maxBackoffMs)
      ? Math.min(GOAL_MAX_BACKOFF_MS, Math.max(minQuietMs, Math.floor(policy.maxBackoffMs)))
      : GOAL_MAX_BACKOFF_MS,
    maxAutonomousTurns: resolveProductAutonomousTurnCap(policy.maxAutonomousTurns),
    cooldownMs: Math.max(1, Math.floor(policy.cooldownMs)),
  }
}

export const computeGoalWakeDelay = (
  domain: ObjectiveDomainSnapshot,
  policy: GoalWakePolicy = DEFAULT_GOAL_WAKE_POLICY,
  hint: GoalWakeSettlementHint = {},
  now = Date.now(),
): GoalWakeDelayDecision => {
  const state = domain.state
  if (state === null) return { skip: "no-goal" }
  const objective = state.objective
  if (objective.status === "usage_limited") {
    const retryAt = state.usageLimitedUntil
    return retryAt !== undefined && retryAt > now
      ? { skip: "usage-limited", retryAt }
      : { skip: "not-active" }
  }
  if (objective.status !== "active") return { skip: "not-active" }
  // GOAL-06 rail 16 — no stopping contract ⇒ no autonomous wake (and no cap consumed).
  if ((domain.validationContract ?? "missing") === "missing") {
    return { skip: "validation-contract-missing" }
  }
  const normalized = safePolicy(policy)
  const allowance = autonomousAllowance({
    userMaxTurns: objective.budget.maxTurns,
    turnsUsed: objective.budget.turnsUsed,
    autonomousTurnsStarted: objective.attempts.autonomousTurnsStarted,
    productCap: normalized.maxAutonomousTurns,
  })
  if (!allowance.allowed) {
    return { skip: "autonomous-turn-cap", limitedBy: allowance.limitingSource }
  }
  if (
    hint.infraUnavailableAtRevision === domain.revision &&
    hint.observedAt !== undefined &&
    hint.observedAt + normalized.cooldownMs > now
  ) {
    return { skip: "infra-cooldown", retryAt: hint.observedAt + normalized.cooldownMs }
  }
  const misses = consecutiveNoProgress(domain.progressReceipts ?? [])
  if (misses === 0) return { delayMs: normalized.minQuietMs, reason: "base" }
  const multiplier = 2 ** Math.min(misses, 30)
  return {
    delayMs: Math.min(normalized.minQuietMs * multiplier, normalized.maxBackoffMs),
    reason: "no-progress-backoff",
  }
}
