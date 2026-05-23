/**
 * Turn-exit guard chain (RCA: recovery.ts + closeout-guard.ts책임 분할정리).
 *
 * Both verify-guard and closeout-guard intercept the SAME control point
 * (`applyAction` → "the model is about to finish") and emit the SAME action
 * (block finish, append `metaUser(...)` nudge, return `CONTINUE`). They differ
 * only in
 *   (a) the predicate that fires (unverified-edit vs. finish-intent), and
 *   (b) the per-session state they own (verifyGuardState / closeoutGuardState),
 *   (c) the tool_choice arming bit they set for the next turn.
 * Before this refactor each guard had its own bespoke step-function in
 * `loop.ts` (`verifyGuardStep` + `closeoutGuardStep`) with copy-pasted shape:
 * isFinishAttempt → decide → emitRecovery → arm flag → wm.append(message) →
 * wm.append(metaUser(text)) → return CONTINUE. This module collapses the shape
 * into a single chain framework so adding a third guard becomes ONE small file
 * (`MyGuard.decide`) + ONE line in `buildGuardChain` — no new hot-path branch
 * in `applyAction`.
 *
 * **Invariants** (must hold or the refactor is wrong):
 * - Empty chain (no `verifyGuard` AND no `closeoutGuard.enabled`) ⇒
 *   `runGuardChain` returns `undefined` after iterating zero guards. The
 *   caller's `if (step)` branch then falls through to the legacy completed /
 *   nudge / proceed path BYTE-IDENTICAL to the pre-refactor loop.
 * - Order is preserved by array index. VerifyGuard is registered before
 *   CloseoutGuard so verify trips FIRST on a co-firing turn (matches the
 *   pre-refactor ordering documented in `closeout-guard.ts` and in the loop
 *   block comment "verify trips first on the same finish, closeout fires the
 *   NEXT finish-attempt").
 * - The guard body (`decideVerifyGuard` / `decideCloseoutGuard`) is NOT
 *   touched — adapters wrap it verbatim. ADR-0011 (verify) / ADR-0017
 *   (closeout) / ADR-0079 (tool_choice arming) semantics are byte-identical.
 *
 * This is a pure framework: no I/O, no LLM, no allocation when the chain is
 * empty. Each guard is responsible for its own pre-checks (config absence,
 * isFinishAttempt, etc.) so the chain itself stays predicate-free.
 */
const CONTINUE_RESULT = Object.freeze({ continue: true });
/** Exported helper so adapters can return the same frozen sentinel — the
 *  chain treats `continue: true` as the only blocking outcome. */
export const guardBlocked = () => CONTINUE_RESULT;
/** Iterate the chain in order; the FIRST guard that returns a non-undefined
 *  result wins. With an empty array this returns `undefined` immediately (no
 *  allocation, no work) — that is the default-OFF byte-identical path the
 *  loop relies on. */
export const runGuardChain = (guards, ctx) => {
    for (const g of guards) {
        const r = g.decide(ctx);
        if (r !== undefined)
            return r;
    }
    return undefined;
};
