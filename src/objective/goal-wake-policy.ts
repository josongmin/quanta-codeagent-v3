/**
 * GOAL-06 — goal wake POLICY: the one owner of the public defaults, clamps,
 * the hard-cap rule, the wake-eligibility fences and the delay ladder.
 *
 * Runtime config, the knob inventory, the renderer, the controller and the
 * catalog import these definitions; nothing re-declares them and there is no
 * NODE_ENV bypass, hidden dev flag or public unsafe override:
 *
 *   - minimum public quiet window: 15 s (a smaller configured value CLAMPS);
 *   - maximum backoff: 15 min;
 *   - product autonomous turn cap: 20 attempts per objective generation,
 *     counted on the durable GOAL-04 `autonomousTurnsStarted`; a caller may
 *     only LOWER it (tests), never raise it.
 *
 * Hard-cap rule (both counters are authority state):
 *
 *     userRemaining    = max(0, (userMaxTurns ?? ∞) - turnsUsed)
 *     productRemaining = max(0, productCap - autonomousTurnsStarted)
 *     autonomousWakeAllowed = min(userRemaining, productRemaining) > 0
 *
 * Slice fence: pure functions over `@/objective` data.
 */

import type { ObjectiveDomainSnapshot } from "./model"
import type { ProgressReceipt } from "./progress-receipt"

/** Public minimum quiet window (15 s, 15_000 ms). */
export const GOAL_WAKE_MIN_QUIET_MS = 15_000
/** Backoff ceiling (15 min, 900_000 ms). */
export const GOAL_WAKE_MAX_BACKOFF_MS = 900_000
/** Product autonomous attempts per objective generation. Cannot be raised. */
export const GOAL_PRODUCT_AUTONOMOUS_TURN_CAP = 20

/** Clamp a configured quiet window to the public minimum (non-finite ⇒ minimum). */
export const clampGoalQuietMs = (
  raw: number | undefined,
): { readonly quietMs: number; readonly clamped: boolean } => {
  if (raw === undefined || !Number.isFinite(raw))
    return { quietMs: GOAL_WAKE_MIN_QUIET_MS, clamped: raw !== undefined }
  if (raw < GOAL_WAKE_MIN_QUIET_MS) return { quietMs: GOAL_WAKE_MIN_QUIET_MS, clamped: true }
  return { quietMs: Math.floor(raw), clamped: false }
}

/** A caller-supplied cap may only LOWER the product cap. */
export const resolveProductAutonomousTurnCap = (requested: number | undefined): number => {
  if (requested === undefined || !Number.isFinite(requested) || requested < 0) {
    return GOAL_PRODUCT_AUTONOMOUS_TURN_CAP
  }
  return Math.min(Math.floor(requested), GOAL_PRODUCT_AUTONOMOUS_TURN_CAP)
}

// ── hard cap ─────────────────────────────────────────────────────────────────

export type BudgetLimitSource = "user-budget" | "product-hard-cap"

export interface AutonomousAllowanceInput {
  readonly userMaxTurns?: number | undefined
  readonly turnsUsed: number
  readonly autonomousTurnsStarted: number
  readonly productCap?: number | undefined
}

export interface AutonomousAllowance {
  readonly userRemaining: number
  readonly productRemaining: number
  readonly allowed: boolean
  /** Which counter forbids the next autonomous attempt (absent when allowed). */
  readonly limitingSource?: BudgetLimitSource
}

export const autonomousAllowance = (input: AutonomousAllowanceInput): AutonomousAllowance => {
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

// ── eligibility ──────────────────────────────────────────────────────────────

export type GoalWakeIneligibleReason =
  | "no-goal"
  | "validation-contract-missing"
  | "goal-not-active"
  | "hard-cap-exhausted"
  | "user-budget-exhausted"

export type GoalWakeEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: GoalWakeIneligibleReason }

/** Arm-time fences over the READ-PORT snapshot. `usage_limited` is NOT a
 *  refusal here — the controller schedules the exact expiry instead. */
export const evaluateWakeEligibility = (
  domain: ObjectiveDomainSnapshot | null,
  productCap?: number,
): GoalWakeEligibility => {
  if (domain === null || domain.state === null) return { eligible: false, reason: "no-goal" }
  const o = domain.state.objective
  if ((domain.validationContract ?? "missing") === "missing") {
    return { eligible: false, reason: "validation-contract-missing" }
  }
  const allowance = autonomousAllowance({
    userMaxTurns: o.budget.maxTurns,
    turnsUsed: o.budget.turnsUsed,
    autonomousTurnsStarted: o.attempts.autonomousTurnsStarted,
    productCap,
  })
  if (!allowance.allowed) {
    return {
      eligible: false,
      reason:
        allowance.limitingSource === "product-hard-cap"
          ? "hard-cap-exhausted"
          : "user-budget-exhausted",
    }
  }
  if (o.status !== "active" && o.status !== "usage_limited") {
    return { eligible: false, reason: "goal-not-active" }
  }
  return { eligible: true }
}

// ── delay ladder ─────────────────────────────────────────────────────────────

export type GoalWakeSignal = "progress" | "no-progress" | "failure"

const FAILURE_OUTCOMES = new Set<ProgressReceipt["turnOutcome"]>([
  "error",
  "refusal",
  "aborted",
  "budget_exhausted",
])

const madeProgress = (r: ProgressReceipt): boolean =>
  r.criterionTransitions.length > 0 || r.verifierReceiptRefs.length > 0

/**
 * Derive the wake signal from the ATTRIBUTED receipts (no second counter):
 * the trailing streak of receipts since the last progress; `failure` when the
 * latest receipt is a failure outcome. `streak` is 0 after progress or when
 * there is no receipt yet.
 */
export const deriveWakeSignal = (
  receipts: readonly ProgressReceipt[] | undefined,
): { readonly signal: GoalWakeSignal; readonly streak: number } => {
  const list = receipts ?? []
  const last = list.at(-1)
  if (last === undefined) return { signal: "progress", streak: 0 }
  let streak = 0
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const r = list[i] as ProgressReceipt
    if (madeProgress(r)) break
    streak += 1
  }
  if (streak === 0) return { signal: "progress", streak: 0 }
  return { signal: FAILURE_OUTCOMES.has(last.turnOutcome) ? "failure" : "no-progress", streak }
}

export type GoalWakeDelayReason = "quiet" | "backoff" | "cooldown" | "usage-limit"

export interface GoalWakeDelay {
  readonly delayMs: number
  readonly reason: GoalWakeDelayReason
}

/**
 * The typed delay for the NEXT wake:
 *   progress            → base quiet
 *   no-progress streak n→ min(base · 2^n, max)   (backoff)
 *   failure streak n    → min(base · 2^n, max)   (cooldown)
 *   usage-limited       → exact remaining expiry (at least the base quiet)
 * A user revision change resets the ladder by construction: a new generation
 * has no receipts (streak 0).
 */
export const computeGoalWakeDelay = (input: {
  readonly baseQuietMs: number
  readonly signal: GoalWakeSignal
  readonly streak: number
  readonly usageLimitedUntil?: number | undefined
  readonly now: number
}): GoalWakeDelay => {
  const base = clampGoalQuietMs(input.baseQuietMs).quietMs
  if (input.usageLimitedUntil !== undefined && input.usageLimitedUntil > input.now) {
    return { delayMs: Math.max(base, input.usageLimitedUntil - input.now), reason: "usage-limit" }
  }
  if (input.signal === "progress" || input.streak <= 0) return { delayMs: base, reason: "quiet" }
  const exponent = Math.min(input.streak, 30)
  const delayMs = Math.min(base * 2 ** exponent, GOAL_WAKE_MAX_BACKOFF_MS)
  return { delayMs, reason: input.signal === "failure" ? "cooldown" : "backoff" }
}
