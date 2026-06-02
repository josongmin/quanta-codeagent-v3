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

export interface TickOpts {
  readonly engine: AutomationEnginePort
  readonly now: number
  readonly handler: AutomationHandler
  /** Override the inbox surface — default produces `[fired]/[errored]` titles. */
  readonly inbox?: InboxBuilder
  /** ADR-0453 — OPTIONAL autorun-eligibility gate (the scheduler-path 4th
   *  guard). Consulted ONCE at the top of the tick, BEFORE `engine.claim`, so a
   *  block takes no claim and advances no anchor. ABSENT (default) ⇒ the tick
   *  is byte-identical to the pre-ADR-0453 path (no consult). The gate is
   *  additive: it can only BLOCK a fire the schedule already permitted. The
   *  policy is global (the verdict does not depend on the row), so a block
   *  suppresses ALL fires this tick. */
  readonly eligibility?: () => TickEligibilityVerdict
}

/**
 * Execute exactly one tick. Returns a typed outcome — never throws.
 *
 * T10 `claim -> execute -> finalize` run model:
 *   1. `claim(now)` atomically picks the soonest-due row, flips it to
 *      `running`, and returns a claim token → if `null`, return `idle`. The
 *      claim flip is engine-atomic so two overlapping ticks NEVER receive the
 *      same row (no double-execution; L9 M11).
 *   2. Compute `nextFire` from the rule + the row's anchor — `null` if the
 *      rule is exhausted (UNTIL past, COUNT met).
 *   3. Invoke `handler(automation)` — synchronously or async.
 *   4. `finalize(claimToken, outcome, nextRunAt)` records the run + inbox and
 *      advances: a live future fire stays `scheduled` (retries next tick) even
 *      when the handler threw (L9 H5); only a rule-exhausted error retires to
 *      `errored`. The claim token guards against a stale worker finalizing a
 *      row another worker now owns.
 */
export const tickScheduler = async (opts: TickOpts): Promise<TickOutcome> => {
  const { engine, now, handler, inbox = defaultInboxBuilder } = opts
  // ADR-0453 — autorun-eligibility gate. Consulted BEFORE the claim so a block
  // takes no claim and advances no anchor (the row stays scheduled). Absent ⇒
  // no consult ⇒ byte-identical.
  const verdict = opts.eligibility?.()
  if (verdict !== undefined && !verdict.eligible) {
    return { kind: "skipped", at: now, reason: verdict.reason }
  }
  const claimRes = await engine.claim(now)
  if (!claimRes.ok) {
    return { kind: "engine-error", at: now, error: claimRes }
  }
  const claimed = claimRes.value
  if (claimed === null) {
    return { kind: "idle", at: now }
  }
  const due = claimed.automation

  const nextRunAt = computeNextFireAfter(due.rule, now, due.fireCount + 1)
  let handlerThrew: unknown
  try {
    await handler(due)
  } catch (e) {
    handlerThrew = e
  }

  const outcome: "fired" | "errored" = handlerThrew === undefined ? "fired" : "errored"
  const errorMessage =
    handlerThrew === undefined
      ? undefined
      : handlerThrew instanceof Error
        ? handlerThrew.message
        : typeof handlerThrew === "string"
          ? handlerThrew
          : "handler threw non-Error"
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

/** Wrap `computeNextFire` — translate the rule-evaluator's `"never"` sentinel
 *  to `null` (the engine's "row is exhausted" marker). */
const computeNextFireAfter = (rule: RRule, from: number, newFireCount: number): number | null => {
  const r = computeNextFire(rule, from, newFireCount)
  return r === "never" ? null : r
}
