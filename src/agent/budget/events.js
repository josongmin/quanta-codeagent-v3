/**
 * Discriminated-union event shapes emitted from `BudgetMeter` for trajectory
 * recording. Pure data — no I/O, no clock. The meter does NOT emit these
 * itself (it has no stream port by design); instead consumers (loop, tests)
 * can construct them from `snapshot()` / `checkExhausted()` at well-known
 * sites.
 */
/** Type guard helper (callers may want this for filtering). */
export const isBudgetEvent = (e) => e.type === "budget_tick" || e.type === "budget_exhausted" || e.type === "budget_clamp";
/** Construct a `BudgetClampEvent`. Pure factory — no I/O. */
export const makeClampEvent = (dial, requested, cap) => ({
    type: "budget_clamp",
    dial,
    requested,
    cap,
});
/** Sentinel type-narrowing helper: a `BudgetCaps` is structurally a
 *  `BudgetDials` — assertion documents the relationship. */
export const asDials = (caps) => caps;
