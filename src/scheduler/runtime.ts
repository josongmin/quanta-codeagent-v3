/**
 * ADR-0161 Phase E — Scheduler runtime + reactor wire.
 *
 * `SchedulerRuntime` is the single composition point — it holds the store,
 * availability port, clock, agent loop, optional sink, and the `tickIntervalMs`
 * cadence. `start()` / `stop()` toggle a `setInterval`-backed timer; `tickOnce()`
 * is the testable atomic — given a clock reading, evaluate all automations,
 * fire those due, persist results, emit sink events.
 *
 * Default-OFF: a runtime CONSTRUCTED but never `start()`-ed performs zero
 * automation firing. `tickOnce()` is the testable contract — host MAY call
 * it directly (e.g. via a `/automate tick` command) without starting the
 * timer. The composition root decides when to `start()`.
 *
 * Reactor seam: `enqueueUserMessage(prompt)` is called the same way reactor's
 * `manual_resume` does — no new trigger reason; the runtime is just another
 * caller of the same agent-loop port the reactor uses.
 *
 * NO-THROW: any single automation failure (parse / fire / save) MUST NOT
 * abort the tick — other automations still process. All failures surfaced
 * via the optional `sink`.
 */

import { markError, recordFire } from "./automation"
import { type ChooseModelResult, chooseModel } from "./model-reroute"
import { computeNextFire } from "./next-fire"
import type {
  AgentLoopPort,
  Automation,
  AutomationStorePort,
  AutorunEligibilityResolverPort,
  ClockPort,
  EnvPort,
  ModelAvailabilityPort,
  SchedulerSinkPort,
} from "./types"

/** Codex `automation-schedule-BpeIuMts.js` uses ONE_MINUTE refetch — same
 *  cadence default here. Exported so tests reference the SSOT. */
export const DEFAULT_TICK_INTERVAL_MS = 60_000

/** Env flag — when set to `"1"`, `start()` is allowed to spin the timer.
 *  When absent / any other value, `start()` is a NO-OP (default-OFF). */
export const SCHEDULER_ENV_FLAG = "QUANTA_SCHEDULER" as const

export interface SchedulerRuntimeOpts {
  readonly store: AutomationStorePort
  readonly availability: ModelAvailabilityPort
  readonly clock: ClockPort
  readonly env: EnvPort
  readonly agentLoop: AgentLoopPort
  readonly workspace: string
  readonly sink?: SchedulerSinkPort
  /** ADR-0453 — OPTIONAL per-thread autorun-eligibility gate. When injected,
   *  an active+due automation is consulted before dispatch; a NOT-eligible
   *  verdict skips the fire (emitting `not-eligible`) WITHOUT advancing the
   *  fire anchor. When ABSENT (default), `tickOnce()` is byte-identical to the
   *  RRULE-only fire path. The gate is additive: it can only BLOCK a fire the
   *  RRULE gate already permitted, never force one. */
  readonly eligibility?: AutorunEligibilityResolverPort
  /** Tick interval. Default {@link DEFAULT_TICK_INTERVAL_MS}. */
  readonly tickIntervalMs?: number
  /** Override `setInterval` (tests inject a fake to avoid wall-clock waits). */
  readonly setInterval?: (handler: () => void, ms: number) => unknown
  /** Override `clearInterval` (pair with `setInterval` injection). */
  readonly clearInterval?: (handle: unknown) => void
}

export interface SchedulerRuntime {
  /** Run a single tick — evaluate all automations against `clock.now()`, fire
   *  those due, persist results, emit sink events. NEVER throws. */
  tickOnce(): Promise<void>
  /** Begin periodic ticking. NO-OP when `env[SCHEDULER_ENV_FLAG] !== "1"`
   *  (default-OFF). Idempotent — calling twice is a no-op after the first. */
  start(): void
  /** Stop periodic ticking. Idempotent. */
  stop(): void
}

export const createSchedulerRuntime = (opts: SchedulerRuntimeOpts): SchedulerRuntime => {
  const tickInterval = Math.max(1, opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS)
  const setIntervalImpl = opts.setInterval ?? ((h, ms) => globalThis.setInterval(h, ms))
  const clearIntervalImpl =
    opts.clearInterval ??
    ((handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>))
  let timerHandle: unknown

  const tickOnce = async (): Promise<void> => {
    const now = opts.clock.now()
    let automations: ReadonlyArray<Automation>
    try {
      automations = await opts.store.load(opts.workspace)
    } catch (e) {
      // T10 M9 — a load fault (EACCES / partial-IO) is now a FIRST-CLASS error
      // surfaced by the store (not collapsed to `[]`). It must be observable:
      // a silent return makes a broken store indistinguishable from "no
      // automations" — every automation silently stops firing. Emit a skip so
      // an operator can see the tick aborted on a store fault.
      opts.sink?.emit({
        type: "scheduler.skipped",
        automationId: `__store__:${stringifyError(e)}`,
        reason: "store-load-failed",
        at: now,
      })
      return
    }
    for (const automation of automations) {
      await processAutomation(automation, now, opts)
    }
  }

  return {
    tickOnce,
    start: () => {
      if (timerHandle !== undefined) return // idempotent
      if (opts.env.get(SCHEDULER_ENV_FLAG) !== "1") return // default-OFF
      timerHandle = setIntervalImpl(() => {
        void tickOnce()
      }, tickInterval)
    },
    stop: () => {
      if (timerHandle === undefined) return
      clearIntervalImpl(timerHandle)
      timerHandle = undefined
    },
  }
}

// ============================================================================
// Per-automation tick body
// ============================================================================

const processAutomation = async (
  automation: Automation,
  now: number,
  opts: SchedulerRuntimeOpts,
): Promise<void> => {
  // 1. Status gate — only `active` fires. `paused` / `deleted` / `error`
  //    surface via skipped events so the host can render the right thing.
  if (automation.status !== "active") {
    opts.sink?.emit({
      type: "scheduler.skipped",
      automationId: automation.id,
      reason: skipReasonFromStatus(automation.status),
      at: now,
    })
    return
  }

  // 2. Compute next-fire from the anchor point. `lastFiredAt ?? createdAt`
  //    is the "from" — what computeNextFire expands relative to. The strict
  //    `>` semantics inside computeNextFire mean we never re-fire the same
  //    instant.
  const anchor = automation.lastFiredAt ?? automation.createdAt
  const nextFire = computeNextFire(automation.rule, anchor, automation.fireCount)
  if (nextFire === "never" || nextFire > now) {
    // Not due — silent skip (no event; the sink would be too chatty per minute).
    return
  }

  // 2b. ADR-0453 — per-thread autorun-eligibility gate (OPTIONAL, default-OFF).
  //     Only consulted when an eligibility resolver is injected AND it returns
  //     a verdict for this automation. A NOT-eligible verdict blocks the fire
  //     WITHOUT advancing the fire anchor (no persist, no dispatch), so the
  //     automation remains due and re-evaluates next tick once its thread
  //     policy / prior outcome changes. `undefined` ⇒ no opinion ⇒ proceed as
  //     if no resolver were injected (byte-identical RRULE-only behavior).
  const verdict = opts.eligibility?.resolve(automation)
  if (verdict !== undefined && !verdict.eligible) {
    opts.sink?.emit({
      type: "scheduler.skipped",
      automationId: automation.id,
      reason: "not-eligible",
      eligibilityReason: verdict.reason,
      at: now,
    })
    return
  }

  // 3. Resolve model — fallback chain or `all-unavailable` → mark error.
  let chosen: ChooseModelResult
  try {
    chosen = await chooseModel({
      preference: automation.modelPreference,
      fallbacks: automation.modelFallbacks,
      availability: opts.availability,
    })
  } catch {
    // chooseModel's contract is non-throwing (it swallows port throws). This
    // catch is defense-in-depth.
    const msg = "model probe threw unexpectedly"
    const persisted = await persistError(automation, msg, opts)
    opts.sink?.emit({
      type: "scheduler.error",
      automationId: automation.id,
      errorMessage: msg,
      at: now,
    })
    emitIfPersistFailed(persisted, automation.id, now, opts)
    return
  }

  if (chosen.reason === "all-unavailable") {
    const msg = "all models unavailable"
    const persisted = await persistError(automation, msg, opts)
    opts.sink?.emit({
      type: "scheduler.error",
      automationId: automation.id,
      errorMessage: msg,
      at: now,
    })
    emitIfPersistFailed(persisted, automation.id, now, opts)
    return
  }

  // 4. PERSIST-BEFORE-DISPATCH (T10 M7). The fire anchor (fireCount + 1,
  //    lastFiredAt = now) is committed to the store BEFORE the prompt is
  //    enqueued. A crash in the dispatch→return window therefore leaves the
  //    advanced anchor on disk, so the reloaded automation is no longer due
  //    and the mutating prompt is NOT re-dispatched. (Previously the order was
  //    dispatch-then-save: a crash between the two re-fired the prompt every
  //    tick — at-least-once on a mutating agent prompt with no idempotency.)
  const fired = recordFire(automation, now)
  try {
    await opts.store.save(opts.workspace, fired)
  } catch {
    // The anchor did not advance. We do NOT dispatch — dispatching without a
    // persisted anchor is the exact double-dispatch hazard M7 closes. Surface
    // the failure so it cannot silently mark the fire complete.
    opts.sink?.emit({
      type: "scheduler.skipped",
      automationId: automation.id,
      reason: "store-save-failed",
      at: now,
    })
    return
  }

  // 5. Enqueue the prompt onto the agent loop. The reactor uses the same
  //    port for `manual_resume` — we reuse the exact seam, not a new trigger.
  try {
    await opts.agentLoop.enqueueUserMessage(automation.prompt, {
      modelOverride: chosen.chosen,
    })
  } catch (e) {
    const msg = `enqueue failed: ${stringifyError(e)}`
    // T10 M7 — the fire anchor was ALREADY advanced AND persisted at step 4
    // (fireCount + 1, lastFiredAt = now). Record the error on the ADVANCED
    // record (`fired`), NOT the original `automation`: `markError({...fired})`
    // keeps the anchor advanced so the occurrence is never re-dispatched.
    // Passing `automation` here would roll the anchor BACK on disk, and an
    // operator resume (error → active) would re-arm a DUPLICATE mutating
    // dispatch — the exact at-least-once hazard M7 closes. Persist-before-
    // dispatch is honored: the dispatch was attempted after the anchor landed,
    // so a failed dispatch must not undo the anchor.
    const persisted = await persistError(fired, msg, opts)
    opts.sink?.emit({
      type: "scheduler.error",
      automationId: automation.id,
      errorMessage: msg,
      at: now,
    })
    emitIfPersistFailed(persisted, automation.id, now, opts)
    return
  }

  // 6. Emit the fire event.
  opts.sink?.emit({
    type: "scheduler.fired",
    automationId: automation.id,
    chosenModel: chosen.chosen,
    rerouteReason: chosen.reason,
    ...(chosen.fallbackIndex !== undefined ? { fallbackIndex: chosen.fallbackIndex } : {}),
    at: now,
  })
}

/**
 * Persist the `error` transition. Returns `true` when the error state landed
 * on disk, `false` when the save itself failed.
 *
 * T10 M10 — a failed error-state save used to be swallowed with a comment
 * claiming "observable in next load attempt's failure"; that was false (load
 * faults were ALSO swallowed, see M9, and even now a load fault surfaces as a
 * DIFFERENT signal). A swallow here leaves the row `active` on disk so a
 * permanently-failing model probe re-fires every tick with NO observability.
 * We now return the failure so the caller emits an observable event.
 */
const persistError = async (
  automation: Automation,
  message: string,
  opts: SchedulerRuntimeOpts,
): Promise<boolean> => {
  const errored = markError(automation, message)
  try {
    await opts.store.save(opts.workspace, errored)
    return true
  } catch {
    return false
  }
}

/** Emit a `store-save-failed` skip event when an error-state persist failed,
 *  so the failure is observable rather than silently dropped (T10 M10). */
const emitIfPersistFailed = (
  persisted: boolean,
  automationId: string,
  now: number,
  opts: SchedulerRuntimeOpts,
): void => {
  if (persisted) return
  opts.sink?.emit({
    type: "scheduler.skipped",
    automationId,
    reason: "store-save-failed",
    at: now,
  })
}

const skipReasonFromStatus = (s: Automation["status"]): "paused" | "deleted" | "status-error" => {
  if (s === "paused") return "paused"
  if (s === "deleted") return "deleted"
  return "status-error"
}

const stringifyError = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : "unknown"
