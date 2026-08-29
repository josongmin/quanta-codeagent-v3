/**
 * GOAL P2-1 — the PRODUCT ceiling on a user-configurable objective budget.
 *
 * History worth keeping: a `budget-limits.ts` shipped once with a silent
 * `clampBudgetLimit` (a `Math.min` applied to the STORED value) and died in
 * merge `9b21d2fd2`. It does not come back in that shape. This campaign had
 * already removed the same idea from the policy layer in `90ad48022` — the
 * product cap was being written into the operator's own budget, so `/goal`
 * reported a number the operator never typed. An input ceiling that rewrites
 * the input is a lie at the exact moment the operator is trying to reason
 * about spend.
 *
 * So: the number is stored VERBATIM, and the ceiling is enforced the way every
 * other limit in this domain is — DERIVED at read time, and named as the
 * limiting source (`product-budget-ceiling`) so a surface can say which bound
 * stopped the work and whether raising the budget could ever help.
 *
 * This is NOT the autonomous hard cap. That one (`GOAL_MAX_AUTONOMOUS_TURNS`,
 * 20 attempts, counted on the durable `autonomousTurnsStarted`) bounds
 * unattended work. This bounds how large an operator may declare their own
 * budget to be, autonomous or not.
 *
 * Slice fence: pure data + pure functions.
 */

/** Absolute ceilings on a user-declared objective budget. */
export const PRODUCT_BUDGET_CEILING = Object.freeze({
  /** Attributed turns (user goal work + autonomous) one objective may spend. */
  maxTurns: 10_000,
  /** Measured tokens (input + output) one objective may spend. */
  maxTokens: 1_000_000_000,
})

/** The bound that actually applies: the operator's own number when it is lower
 *  than the product ceiling, the ceiling otherwise. `undefined` (no declared
 *  budget) still yields the ceiling — an undeclared budget is not an unbounded
 *  one. */
export const effectiveBudgetLimit = (
  declared: number | undefined,
  ceiling: number,
): { readonly limit: number; readonly boundBy: "user-budget" | "product-budget-ceiling" } =>
  declared !== undefined && Number.isFinite(declared) && declared < ceiling
    ? { limit: Math.floor(declared), boundBy: "user-budget" }
    : { limit: ceiling, boundBy: "product-budget-ceiling" }
