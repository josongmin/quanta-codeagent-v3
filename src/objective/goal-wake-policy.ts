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
  | "autonomous-turn-cap"
  | "usage-limited"
  | "infra-cooldown"

export type GoalWakeDelayDecision =
  | { readonly delayMs: number; readonly reason: "base" | "no-progress-backoff" }
  | { readonly skip: GoalWakeDelaySkip; readonly retryAt?: number | undefined }

export interface GoalWakeSettlementHint {
  readonly infraUnavailableAtRevision?: number | undefined
  readonly observedAt?: number | undefined
}

const madeProgress = (receipt: ProgressReceipt): boolean =>
  receipt.criterionTransitions.length > 0 || receipt.verifierReceiptRefs.length > 0

const consecutiveNoProgress = (receipts: readonly ProgressReceipt[]): number => {
  let count = 0
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const receipt = receipts[index]
    if (receipt === undefined || madeProgress(receipt)) break
    count += 1
  }
  return count
}

const safePolicy = (policy: GoalWakePolicy): GoalWakePolicy => ({
  minQuietMs: Math.max(1, Math.floor(policy.minQuietMs)),
  maxBackoffMs: Math.max(
    Math.max(1, Math.floor(policy.minQuietMs)),
    Math.floor(policy.maxBackoffMs),
  ),
  maxAutonomousTurns: Math.max(0, Math.floor(policy.maxAutonomousTurns)),
  cooldownMs: Math.max(1, Math.floor(policy.cooldownMs)),
})

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
  const normalized = safePolicy(policy)
  const turnCap = objective.budget.maxTurns ?? normalized.maxAutonomousTurns
  if (objective.budget.turnsUsed >= turnCap) return { skip: "autonomous-turn-cap" }
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
