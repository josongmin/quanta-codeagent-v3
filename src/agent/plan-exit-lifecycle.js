/**
 * Plan-exit lifecycle router (ADR-0095 P6, paired with ADR-0086 3-way exit).
 *
 * Pure-functional dispatch from a {@link PlanExitOutcome} (the 3-way decision
 * the operator made via the {@link PlanExitPort}) to a {@link PlanExitLifecycle}
 * action that callers (the loop, the side-conversation runner) must take on
 * the {@link PlanStore}.
 *
 * The 3 outcomes have CLEAR plan-state semantics:
 *
 *   - `approved`           → plan is FROZEN. We snapshot the store and return
 *                            a `freeze` action carrying the snapshot. The
 *                            store is NOT cleared here — the caller decides
 *                            whether to keep the live PlanStore alive
 *                            alongside the frozen-snapshot system-reminder
 *                            (e.g. for renderers that want a live view), or
 *                            to drop it. The pure router does not bind that
 *                            policy.
 *   - `rejected`           → plan is CLEARED. We call `store.clear()` here
 *                            (the ONLY side effect this router performs) and
 *                            return `clear`. After this, `store.current()`
 *                            is `null` and a follow-up `create()` works.
 *   - `changes_requested`  → plan is PRESERVED. The store is untouched. We
 *                            return `preserve_with_feedback` carrying the
 *                            exact feedback string (or `"(no feedback)"` if
 *                            absent — see invariant note below). The CALLER
 *                            seeds this feedback into the next user-turn
 *                            prompt.
 *
 * ## Invariant note on `changes_requested` + missing feedback
 *
 * Per {@link PlanExitOutcome} contract (`plan-exit.ts` `buildPlanExit`), a
 * `changes_requested` decision **must** carry non-empty feedback at the build
 * site. By the time we reach this router, the outcome has already passed
 * through `buildPlanExit` (either directly or via `runPlanExitFlow`'s
 * revalidation), so `feedback` is guaranteed present-and-non-empty.
 *
 * However, this router defends in depth: if `feedback` is somehow `undefined`
 * (e.g. an out-of-band construction skipped `buildPlanExit`), we substitute
 * the explicit sentinel string `"(no feedback)"` rather than throwing or
 * returning `undefined`. This keeps the consumer interface uniformly typed
 * (`feedback: string`, no `string | undefined`) and surfaces the omission
 * visibly in the user-turn prompt (`"(no feedback)"` is conspicuously
 * different from real operator text).
 *
 * Empty string `""` is preserved EXACTLY (not coerced to the sentinel) — the
 * sentinel substitution fires only on `undefined`. An empty string is a
 * legitimate (if unusual) operator choice and must round-trip unchanged.
 *
 * ## Loop integration is OUT OF SCOPE (P6)
 *
 * This module is the PURE LIFECYCLE ROUTER. The seam that reads the returned
 * `PlanExitLifecycle` and acts on it (injecting the frozen snapshot as a
 * system reminder, seeding feedback into the next prompt) is the LOOP's
 * responsibility — see `docs/plans/plan-mode-sota-plus-plus.md` §6 and §11.P6.
 *
 * ## Closed-shape guarantee
 *
 * The switch on `outcome.decision` has a `never` default arm so that adding
 * a 4th decision to {@link PlanExitDecision} forces a compile error here.
 * Drift between the decision enum and the lifecycle router is impossible at
 * type-check time.
 */
/**
 * Sentinel substituted for a missing feedback string on `changes_requested`.
 * Exported for tests + downstream consumers that may want to recognize/strip
 * the sentinel before rendering it to the operator.
 */
export const NO_FEEDBACK_SENTINEL = "(no feedback)";
// ===========================================================================
// Pure decision function
// ===========================================================================
/**
 * Apply a {@link PlanExitOutcome} to a {@link PlanStore} and return the
 * lifecycle action the caller must take.
 *
 * Side effects (the ONLY ones in this module):
 *   - `decision === "rejected"` ⇒ `store.clear()` is called exactly once
 *     before returning. The store is empty afterward.
 *   - For `approved` and `changes_requested`, the store is UNTOUCHED. For
 *     `approved`, the caller decides whether to drop the live store
 *     alongside the frozen snapshot (the snapshot is by-value and survives
 *     a later `store.clear()`).
 *
 * Pure dispatch: no text matching, no fuzzy logic, no heuristics. The
 * function branches solely on `outcome.decision` (a closed 3-arm enum) and
 * the `never` default arm guarantees compile-time drift detection.
 *
 * @param outcome The validated 3-way decision from the plan-exit port.
 * @param store   The live PlanStore the agent has been mutating in plan mode.
 *                Snapshot is captured via `store.snapshot()` BEFORE any clear.
 * @returns A {@link PlanExitLifecycle} action the caller must wire into the
 *          loop (inject frozen snapshot as system reminder / seed feedback /
 *          do nothing further).
 */
export const applyPlanExitOutcome = (outcome, store) => {
    switch (outcome.decision) {
        case "approved": {
            // Capture the plan state at the approval moment. May be null if the
            // operator approved with no plan in the store. The store is left
            // ALIVE — the caller may want to keep rendering it or drop it.
            const snapshot = store.snapshot();
            return { kind: "freeze", snapshot };
        }
        case "rejected": {
            // Idempotent: store.clear() on an empty store is a no-op (see
            // PlanStore.clear contract). No delta is emitted by clear, so this
            // is a silent reset from the observer's perspective.
            store.clear();
            return { kind: "clear" };
        }
        case "changes_requested": {
            // Preserve the plan + carry feedback forward. The CALLER (loop) seeds
            // the feedback into the next user-turn prompt. Empty string is
            // preserved exactly — only `undefined` falls back to the sentinel.
            const feedback = outcome.feedback === undefined ? NO_FEEDBACK_SENTINEL : outcome.feedback;
            return { kind: "preserve_with_feedback", feedback };
        }
        default: {
            // Compile-time exhaustiveness gate. Adding a 4th PlanExitDecision
            // without updating this switch will fail at type-check time. The
            // runtime throw exists ONLY to catch the bad-actor case where a
            // caller forges an outcome with `decision: "bogus" as any` past TS.
            const exhaustive = outcome.decision;
            throw new Error(`applyPlanExitOutcome: unreachable plan-exit decision ${JSON.stringify(exhaustive)} ` +
                `— closed 3-arm union violated (approved | rejected | changes_requested).`);
        }
    }
};
