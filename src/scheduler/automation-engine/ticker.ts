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

export interface TickOpts {
  readonly engine: AutomationEnginePort
  readonly now: number
  readonly handler: AutomationHandler
  /** Override the inbox surface — default produces `[fired]/[errored]` titles. */
  readonly inbox?: InboxBuilder
}

/**
 * Execute exactly one tick. Returns a typed outcome — never throws.
 *
 * Semantics:
 *   1. Find next due → if `null`, return `idle`.
 *   2. Compute `nextFire` from the rule + the row's anchor — `null` if
 *      rule is exhausted (UNTIL past, COUNT met).
 *   3. Invoke `handler(automation)` — synchronously or async.
 *   4. On handler return: `markRun(outcome:"fired", nextRunAt)`.
 *   5. On handler throw: `markRun(outcome:"errored", nextRunAt)`. The error
 *      is preserved in `lastError`; the row stays `scheduled` so it can
 *      retry next tick (unless rule exhausted, in which case it transitions
 *      to `errored`).
 */
export const tickScheduler = async (opts: TickOpts): Promise<TickOutcome> => {
  const { engine, now, handler, inbox = defaultInboxBuilder } = opts
  const nextRes = await engine.next(now)
  if (!nextRes.ok) {
    return { kind: "engine-error", at: now, error: nextRes }
  }
  const due = nextRes.value
  if (due === null) {
    return { kind: "idle", at: now }
  }

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

  const markRes = await engine.markRun({
    id: due.id,
    firedAt: now,
    outcome,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    nextRunAt,
    inboxTitle: built.title,
    inboxSummary: built.summary,
  })
  if (!markRes.ok) {
    return { kind: "engine-error", at: now, error: markRes }
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
