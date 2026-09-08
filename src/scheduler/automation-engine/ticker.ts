/**
 * ADR-0215 — Pure `tickScheduler` — the testable atomic.
 *
 * Single-row tick: pick the soonest-due via `engine.next(now)`, fire it via
 * the injected `handler`, then `engine.markRun(...)` with the next-fire
 * computed from `computeNextFire`. Returns a discriminated outcome so the
 * runtime (sibling `runtime.ts`) can render observability without re-running
 * the logic in a hot loop.
 *
 * Pure: no clock, no fs, no env. Caller passes `now`; the rrule-parser
 * sibling supplies `computeNextFire` (already pure).
 *
 * NO-THROW: handler throw → marked `errored` with the error message; the
 * outcome reports `kind:"errored"`. Engine port errors surface as
 * `kind:"engine-error"` carrying the engine's typed error.
 *
 * Default-OFF: this is a single pure step. The runtime decides whether to
 * call it on a timer.
 */

import { computeNextFire } from "../next-fire"
import type { RRule } from "../types"
import type { AutomationEnginePort, EngineAutomation, EngineErrorResult } from "./port"

/** Handler — the host-supplied fire callback. May be async; may throw.
 *  Receives the automation snapshot (NOT the live row) so a handler can't
 *  mutate engine state out of band. */
export type AutomationHandler = (a: EngineAutomation) => Promise<void> | void

/** Inbox surface builder — pure transform from the automation + outcome to
 *  the inbox `(title, summary)`. Default builder fills sensible values; tests
 *  inject overrides. */
export type InboxBuilder = (
  a: EngineAutomation,
  outcome: "fired" | "errored",
) => {
  title: string
  summary: string
}

const defaultInboxBuilder: InboxBuilder = (a, outcome) => ({
  title: `[${outcome}] ${a.title}`,
  summary:
    outcome === "errored" ? `automation '${a.id}' fired with error` : `automation '${a.id}' fired`,
})

/** ADR-0453 — autorun-eligibility verdict the (optional) gate returns. A
 *  structural type (NOT imported from `@/permission`) so the scheduler slice
 *  stays fenced; the composition root injects a resolver built over the pure
 *  `evaluateAutorunEligibility`. */
export interface TickEligibilityVerdict {
  readonly eligible: boolean
  readonly reason: string
}

/** Discriminated outcome — every arm is observable for telemetry. */
export type TickOutcome =
  | { readonly kind: "idle"; readonly at: number }
  | { readonly kind: "fired"; readonly at: number; readonly automationId: string }
  | {
      readonly kind: "errored"
      readonly at: number
      readonly automationId: string
      readonly errorMessage: string
    }
  | {
      readonly kind: "engine-error"
      readonly at: number
      readonly error: EngineErrorResult
    }
  /** ADR-0453 — the autorun-eligibility gate blocked this tick BEFORE any row
   *  was claimed: nothing fired, no claim taken, no anchor advanced (the due
   *  row stays `scheduled` and is re-evaluated next tick). `reason` is the
   *  closed eligibility-reason anchor (e.g. `policy-never`). */
  | { readonly kind: "skipped"; readonly at: number; readonly reason: string }
  | {
      readonly kind: "ownership-lost"
      readonly at: number
      readonly automationId: string
    }

export interface TickOpts {
  readonly engine: AutomationEnginePort
  readonly now: number
  readonly handler: AutomationHandler
  readonly inbox?: InboxBuilder
  readonly eligibility?: () => TickEligibilityVerdict
  /**
   * Stale `running` claims with `claimedAt <= now - reclaimStaleAfterMs` are
   * eligible for reclaim. Default 60s so the live ticker recovers crashed
   * workers without a composition-root change. `0` disables reclaim.
   * Reclaim is recovery-required: the handler may run again under a new
   * token. There is no attempt identity that makes reclaim a no-op replay.
   */
  readonly reclaimStaleAfterMs?: number
  /**
   * While the handler runs, bump `claimedAt` on the same token this often.
   * Default 20s. `0` disables renewal.
   */
  readonly renewEveryMs?: number
  /** Clock for renewal timestamps. Default `Date.now`. */
  readonly nowFn?: () => number
}

/** Default reclaim window — live ticker inherits this without agent-slot edits. */
export const DEFAULT_CLAIM_RECLAIM_MS = 60_000
export const DEFAULT_CLAIM_RENEW_MS = 20_000

/**
 * Execute exactly one tick. Returns a typed outcome — never throws.
 *
 * T10 `claim -> execute -> finalize` run model:
 *   1. `claim(now)` atomically picks the soonest-due row, flips it to
 *      `running`, and returns a claim token → if `null`, return `idle`. The
 *      claim flip is engine-atomic so two overlapping LIVE ticks never receive
 *      the same row. Stale reclaim is a NEW claimToken and a NEW handler
 *      invocation (at-least-once / recovery-required — not exactly-once).
 *   2. Compute `nextFire` from the rule + the row's anchor — `null` if the
 *      rule is exhausted (UNTIL past, COUNT met).
 *   3. Invoke `handler(automation)` — synchronously or async.
 *   4. `finalize(claimToken, outcome, nextRunAt)` records the run + inbox and
 *      advances: a live future fire stays `scheduled` (retries next tick) even
 *      when the handler threw (L9 H5); only a rule-exhausted error retires to
 *      `errored`. The claim token guards against a stale worker finalizing a
 *      row another worker now owns.
 */
const runClaimedTick = async (
  opts: TickOpts,
  claimed: { readonly automation: EngineAutomation; readonly claimToken: string },
): Promise<TickOutcome> => {
  const { engine, now, handler, inbox = defaultInboxBuilder } = opts
  const due = claimed.automation
  const nextRunAt = computeNextFireAfter(due.rule, now, due.fireCount + 1)
  const renewEveryMs = opts.renewEveryMs ?? DEFAULT_CLAIM_RENEW_MS
  const nowFn = opts.nowFn ?? Date.now
  let handlerThrew: unknown
  let ownershipLost = false
  const renewTimer =
    renewEveryMs > 0
      ? setInterval(() => {
          void engine.renewClaim(due.id, claimed.claimToken, nowFn()).then((r) => {
            if (!r.ok) ownershipLost = true
          })
        }, renewEveryMs)
      : undefined
  try {
    await handler(due)
  } catch (e) {
    handlerThrew = e
  } finally {
    if (renewTimer !== undefined) clearInterval(renewTimer)
  }
  if (ownershipLost) {
    return { kind: "ownership-lost", at: now, automationId: due.id }
  }
  const outcome: "fired" | "errored" = handlerThrew === undefined ? "fired" : "errored"
  const errorMessage = handlerErrorMessage(handlerThrew)
  const built = inbox(due, outcome)
  const finRes = await engine.finalize({
    id: due.id,
    claimToken: claimed.claimToken,
    firedAt: now,
    outcome,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    nextRunAt,
    inboxTitle: built.title,
    inboxSummary: built.summary,
  })
  if (!finRes.ok) {
    return { kind: "engine-error", at: now, error: finRes }
  }
  if (outcome === "errored") {
    return {
      kind: "errored",
      at: now,
      automationId: due.id,
      errorMessage: errorMessage ?? "handler threw",
    }
  }
  return { kind: "fired", at: now, automationId: due.id }
}

export const tickScheduler = async (opts: TickOpts): Promise<TickOutcome> => {
  const { engine, now } = opts
  const verdict = opts.eligibility?.()
  if (verdict !== undefined && !verdict.eligible) {
    return { kind: "skipped", at: now, reason: verdict.reason }
  }
  const reclaimStaleAfterMs = opts.reclaimStaleAfterMs ?? DEFAULT_CLAIM_RECLAIM_MS
  const claimRes = await engine.claim(
    now,
    reclaimStaleAfterMs > 0 ? { reclaimBefore: now - reclaimStaleAfterMs } : undefined,
  )
  if (!claimRes.ok) {
    return { kind: "engine-error", at: now, error: claimRes }
  }
  if (claimRes.value === null) {
    return { kind: "idle", at: now }
  }
  return runClaimedTick(opts, claimRes.value)
}

/** Render whatever the handler threw, or `undefined` when it completed.
 *
 *  A unit because `undefined` is load-bearing here: it is the SAME signal the
 *  `fired`/`errored` outcome is read from, so the "did it throw" sentinel and
 *  the naming of the three non-`Error` shapes have to be decided in one place.
 *  Note a handler that throws `undefined` counts as a clean fire, as before. */
const handlerErrorMessage = (thrown: unknown): string | undefined => {
  if (thrown === undefined) return undefined
  if (thrown instanceof Error) return thrown.message
  return typeof thrown === "string" ? thrown : "handler threw non-Error"
}

/** Wrap `computeNextFire` — translate the rule-evaluator's `"never"` sentinel
 *  to `null` (the engine's "row is exhausted" marker). */
const computeNextFireAfter = (rule: RRule, from: number, newFireCount: number): number | null => {
  const r = computeNextFire(rule, from, newFireCount)
  return r === "never" ? null : r
}
