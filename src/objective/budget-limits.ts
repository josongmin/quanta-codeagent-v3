/**
 * GOAL-05A — product ceiling for the user-configurable objective budget.
 *
 * These are ABSOLUTE input ceilings (like `MAX_GOAL_CHARS`): a same-ID
 * `amendBudget` and a `create` / `replace` definition are clamped to them by
 * the core store, so the CLI, the model tool and the web share one rule and
 * no surface can mint an unbounded cap. They are NOT the autonomous hard cap
 * (GOAL-06 owns that: product default 20 attempts, counted on the durable
 * `autonomousTurnsStarted`) — a user turn budget may exceed the hard cap; the
 * EFFECTIVE autonomous allowance is the minimum of the two.
 *
 * Slice fence: pure data.
 */

import type { ObjectiveBudgetLimit } from "./types"

export const PRODUCT_BUDGET_CEILING = Object.freeze({
  /** Attributed turns (user goal work + autonomous) one objective may be given. */
  maxTurns: 10_000,
  /** Measured tokens (input + output) one objective may be given. */
  maxTokens: 1_000_000_000,
})

const finiteNonNegInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined

/** Drop malformed caps and clamp the rest to the product ceiling. Omitted
 *  fields stay omitted (exactOptional). */
export const clampBudgetLimit = (limit: ObjectiveBudgetLimit): ObjectiveBudgetLimit => {
  const maxTurns = finiteNonNegInt(limit.maxTurns)
  const maxTokens = finiteNonNegInt(limit.maxTokens)
  return {
    ...(maxTurns !== undefined
      ? { maxTurns: Math.min(maxTurns, PRODUCT_BUDGET_CEILING.maxTurns) }
      : {}),
    ...(maxTokens !== undefined
      ? { maxTokens: Math.min(maxTokens, PRODUCT_BUDGET_CEILING.maxTokens) }
      : {}),
  }
}
