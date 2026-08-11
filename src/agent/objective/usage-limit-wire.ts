/**
 * RFC-06 A4.3 — the `usage_limited` PRODUCER (measured-signal → objective).
 *
 * The objective 6-state machine has `markUsageLimited(threadId, untilEpochMs)`
 * (store.ts) but its ONLY prior feeder was the model's SELF-REPORT tool. A real
 * provider 429 already tells us WHEN capacity returns (`retry-after`), parsed at
 * the `LLMError.fromSdkError` boundary into `LLMError.retryAfterMs` (a ms DELTA).
 * This pure adapter converts that measured delta into the objective's transient,
 * AUTO-RESETTING usage window — the missing production caller of
 * `markUsageLimited`.
 *
 * SLICE FENCE (ADR-0394): imports ONLY `./types` (the closed `ObjectivePort`).
 * NOTHING from `@/agent` core, `@/shared`, `@/apps`. It takes the ALREADY-parsed
 * `retryAfterMs` DELTA + an injected clock, so it is decoupled from `LLMError`
 * (the host extracts `error.retryAfterMs` at the loop seam and calls this).
 *
 * DEFAULT-OFF is the HOST's job (the loop seam gates on
 * `runtimeConfig().objectiveBudgetEnforce`, the same gate `objectiveBudgetExhausted`
 * reads — so when the gate is off this function is NEVER invoked and NO mutation
 * happens: byte-identical). The INFORMATIONAL store additionally renders any
 * window inert (`deriveStatus` never emits `usage_limited` without `enforce`).
 *
 * NO-DOUBLE-COUNT: this touches ONLY the usage WINDOW (`markUsageLimited`); it
 * NEVER calls `recordUsage`, so the self-report token/turn ledger is untouched.
 * The two signals feed DISJOINT cell fields.
 *
 * NO-RESURRECT: a 429 marks the window ONLY when the objective is currently
 * `active` or already `usage_limited` (a re-arm / extend). A `paused` /
 * `completed` / `blocked` / `budget_limited` objective is LEFT ALONE — a
 * transient rate limit must never resurrect a goal the user paused or that is
 * done (the derive priority would otherwise show `usage_limited` OVER
 * `completed`, mis-reporting a finished goal as merely throttled).
 */

import type { ObjectivePort } from "./types"

/** The read+write subset this adapter needs — a NARROW view of the port so a
 *  caller can pass any `ObjectivePort` (or a test double) without exposing the
 *  full mutator surface. `get` supplies the no-resurrect status guard; the whole
 *  thing is NO-THROW (both port methods are). */
export type UsageLimitPort = Pick<ObjectivePort, "get" | "markUsageLimited">

/**
 * Feed a MEASURED provider rate-limit (a 429's `retry-after` delta) into the
 * objective as a transient usage window ending at `now() + retryAfterMs`.
 *
 * Returns `true` iff a window was actually set (the objective existed, was in an
 * eligible state, and the delta was a finite positive number). Returns `false`
 * (a no-op) otherwise — so a caller can attribute the decision.
 *
 * TOTAL / NO-THROW: any malformed input or throwing port degrades to `false`.
 *
 * @param objective   the objective store (narrow read+mark view).
 * @param threadId    the thread whose objective to limit.
 * @param retryAfterMs the SERVER-instructed delay in ms (a DELTA, already parsed
 *                    from the 429 by `LLMError.fromSdkError`). `undefined` (no
 *                    parsable header) or a non-positive/non-finite value ⇒ no-op.
 * @param now         injected clock (epoch ms). Default `Date.now`.
 */
export const applyMeasuredUsageLimit = (
  objective: UsageLimitPort,
  threadId: string,
  retryAfterMs: number | undefined,
  now: () => number = Date.now,
): boolean => {
  try {
    // A 429 WITHOUT a parsable retry-after carries NO epoch — there is nothing
    // to bound the window by, so we do NOT limit (blind-exponential backoff owns
    // that case; inventing an arbitrary window would be a magic threshold).
    if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
      return false
    }
    if (typeof threadId !== "string" || threadId.length === 0) return false

    // NO-RESURRECT: read the CURRENT derived status. Only an `active` (or an
    // already `usage_limited`, i.e. re-arm/extend) objective may be limited.
    // Unknown thread ⇒ null ⇒ no-op. `blocked` / `budget_limited` / `paused` /
    // `completed` are left untouched.
    const current = objective.get(threadId)
    if (current === null) return false
    if (current.status !== "active" && current.status !== "usage_limited") return false

    const until = now() + retryAfterMs
    // Overflow guard: a hostile/near-`MAX` clock + delta could overflow to a
    // non-finite epoch; markUsageLimited would then CLEAR the window (its
    // contract). Bail rather than accidentally clear.
    if (!Number.isFinite(until) || until <= 0) return false

    objective.markUsageLimited(threadId, until)
    return true
  } catch {
    return false
  }
}
