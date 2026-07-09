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
  EnqueueRejected,
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

/**
 * WS-D (jul-10, UUX-4-01/D-4) — max delivery ATTEMPTS per occurrence when the
 * enqueue resolves a typed {@link EnqueueRejected} soft-fail (definite
 * non-delivery, e.g. the CLI binder's `thread-not-found`). Attempts below the
 * cap roll the persisted fire anchor BACK (reserve→confirm compensation) so
 * the occurrence stays due and retries on the next tick; the final attempt
 * gives up terminally: `status:"error"` persisted ON the advanced anchor
 * (same terminal shape as the M7 hard-throw path — an operator resume never
 * re-arms this occurrence). Counted in process memory per automation id —
 * a restart re-attempts (the anchor on disk is still due), which is safe
 * because a soft-fail provably delivered nothing.
 */
export const MAX_ENQUEUE_SOFT_ATTEMPTS = 3

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

  // WS-D soft-fail retry ledger — per automation id, the number of enqueue
  // attempts that resolved `EnqueueRejected` for the CURRENT occurrence.
  // Cleared on delivery / on the terminal error transition. Process-memory
  // only (see MAX_ENQUEUE_SOFT_ATTEMPTS for why that is safe).
  const softAttempts = new Map<string, number>()

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
      await processAutomation(automation, now, opts, softAttempts)
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

/** Steps 1–2b of the tick body — status gate, RRULE due check, optional
 *  autorun-eligibility gate. Returns `false` (after emitting the appropriate
 *  skip event) when the automation must NOT fire this tick. Extracted
 *  verbatim from `processAutomation` (behavior-preserving). */
const passesFireGates = (
  automation: Automation,
  now: number,
  opts: SchedulerRuntimeOpts,
): boolean => {
  // 1. Status gate — only `active` fires. `paused` / `deleted` / `error`
  //    surface via skipped events so the host can render the right thing.
  if (automation.status !== "active") {
    opts.sink?.emit({
      type: "scheduler.skipped",
      automationId: automation.id,
      reason: skipReasonFromStatus(automation.status),
      at: now,
    })
    return false
  }

  // 2. Compute next-fire from the anchor point. `lastFiredAt ?? createdAt`
  //    is the "from" — what computeNextFire expands relative to. The strict
  //    `>` semantics inside computeNextFire mean we never re-fire the same
  //    instant.
  const anchor = automation.lastFiredAt ?? automation.createdAt
  const nextFire = computeNextFire(automation.rule, anchor, automation.fireCount)
  if (nextFire === "never" || nextFire > now) {
    // Not due — silent skip (no event; the sink would be too chatty per minute).
    return false
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
    return false
  }
  return true
}

const processAutomation = async (
  automation: Automation,
  now: number,
  opts: SchedulerRuntimeOpts,
  softAttempts: Map<string, number>,
): Promise<void> => {
  // 1–2b. Status / due / eligibility gates (skip events emitted inside).
  if (!passesFireGates(automation, now, opts)) return

  // 3. Resolve model — fallback chain or `all-unavailable` → mark error.
  const chosen = await resolveFireModel(automation, now, opts)
  if (chosen === null) return

  // 4. PERSIST-BEFORE-DISPATCH (T10 M7) — the RESERVE half of the WS-D
  //    reserve→confirm protocol. The fire anchor (fireCount + 1,
  //    lastFiredAt = now) is committed to the store BEFORE the prompt is
  //    enqueued. A crash in the dispatch→return window therefore leaves the
  //    advanced anchor on disk, so the reloaded automation is no longer due
  //    and the mutating prompt is NOT re-dispatched. (Previously the order was
  //    dispatch-then-save: a crash between the two re-fired the prompt every
  //    tick — at-least-once on a mutating agent prompt with no idempotency.)
  //    CONFIRM = a delivery receipt from the enqueue (step 5): the reserved
  //    anchor simply stays. A typed soft-fail (provable non-delivery) instead
  //    COMPENSATES: the original anchor is persisted back so the occurrence
  //    retries next tick (bounded — see MAX_ENQUEUE_SOFT_ATTEMPTS).
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
  //    H8 — a `heartbeat` automation routes onto its target thread + re-applies
  //    the inherited posture; `cron` (absent kind) stays byte-identical (fresh).
  const heartbeat =
    automation.kind === "heartbeat" && automation.targetThreadId !== undefined
      ? {
          targetThreadId: automation.targetThreadId,
          ...(automation.inheritedPolicy !== undefined
            ? { inheritedPolicy: automation.inheritedPolicy }
            : {}),
        }
      : {}
  // biome-ignore lint/suspicious/noConfusingVoidType: matches AgentLoopPort.enqueueUserMessage's return union (see types.ts for why the port keeps `void`).
  let outcome: void | EnqueueRejected
  try {
    outcome = await opts.agentLoop.enqueueUserMessage(automation.prompt, {
      modelOverride: chosen.chosen,
      ...heartbeat,
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

  // 5b. WS-D (UUX-4-01) — HONOR a typed soft-fail receipt. The enqueue
  //     RESOLVED with `delivered:false` (provable non-delivery, e.g. binder
  //     `thread-not-found`): the prompt reached NO queue, so emitting
  //     `scheduler.fired` here would be a false success and the occurrence
  //     would be silently lost. Instead: no fired event, an observable
  //     `scheduler.error`, and a bounded retry via anchor compensation.
  if (outcome !== undefined && outcome.delivered === false) {
    await handleSoftFail(automation, fired, outcome, now, opts, softAttempts)
    return
  }

  // 6. CONFIRM + emit the fire event (delivery receipt observed).
  softAttempts.delete(automation.id)
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
 * Step 3 body — resolve the fire model through the fallback chain. Returns
 * `null` after persisting + emitting the error when no model is usable
 * (probe threw / all-unavailable); the caller aborts the fire. Extracted
 * verbatim from `processAutomation` (behavior-preserving).
 */
const resolveFireModel = async (
  automation: Automation,
  now: number,
  opts: SchedulerRuntimeOpts,
): Promise<ChooseModelResult | null> => {
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
    await emitFireModelError(automation, "model probe threw unexpectedly", now, opts)
    return null
  }
  if (chosen.reason === "all-unavailable") {
    await emitFireModelError(automation, "all models unavailable", now, opts)
    return null
  }
  return chosen
}

/** Shared error tail of {@link resolveFireModel}: persist the `error`
 *  transition + emit `scheduler.error` (+ the persist-failure skip). */
const emitFireModelError = async (
  automation: Automation,
  msg: string,
  now: number,
  opts: SchedulerRuntimeOpts,
): Promise<void> => {
  const persisted = await persistError(automation, msg, opts)
  opts.sink?.emit({
    type: "scheduler.error",
    automationId: automation.id,
    errorMessage: msg,
    at: now,
  })
  emitIfPersistFailed(persisted, automation.id, now, opts)
}

/**
 * WS-D soft-fail arm (see step 5b). Attempts below
 * {@link MAX_ENQUEUE_SOFT_ATTEMPTS}: persist the ORIGINAL (pre-fire) record
 * back — the reserve compensation — so the occurrence stays due and retries
 * next tick; emit `scheduler.error` with `willRetry:true`. The final attempt
 * is terminal: `markError` ON THE ADVANCED anchor (`fired`), identical to the
 * M7 hard-throw shape, so an operator resume never re-arms this occurrence.
 *
 * Crash windows (at-most-once preserved because a soft-fail delivered
 * NOTHING): a crash before the compensation lands leaves the advanced anchor
 * on disk — the occurrence is dropped, never double-fired. A compensation
 * save failure is surfaced as `store-save-failed` (observable drop).
 */
const handleSoftFail = async (
  automation: Automation,
  fired: Automation,
  outcome: EnqueueRejected,
  now: number,
  opts: SchedulerRuntimeOpts,
  softAttempts: Map<string, number>,
): Promise<void> => {
  const attempt = (softAttempts.get(automation.id) ?? 0) + 1
  if (attempt >= MAX_ENQUEUE_SOFT_ATTEMPTS) {
    // Terminal: give up on the advanced anchor (occurrence consumed).
    softAttempts.delete(automation.id)
    const msg = `enqueue rejected: ${outcome.reason} (gave up after ${attempt} attempts)`
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
  softAttempts.set(automation.id, attempt)
  // Compensate the reserve: restore the pre-fire anchor so the next tick
  // re-evaluates this SAME occurrence (nothing was delivered — safe).
  let rolledBack = true
  try {
    await opts.store.save(opts.workspace, automation)
  } catch {
    rolledBack = false
    // The occurrence is DROPPED (reserved anchor stays on disk) — clear the
    // counter so a LATER occurrence starts with a full retry budget.
    softAttempts.delete(automation.id)
  }
  opts.sink?.emit({
    type: "scheduler.error",
    automationId: automation.id,
    errorMessage: `enqueue rejected: ${outcome.reason} (attempt ${attempt}/${MAX_ENQUEUE_SOFT_ATTEMPTS}, retrying next tick)`,
    willRetry: rolledBack,
    at: now,
  })
  // A failed compensation leaves the ADVANCED anchor on disk: the occurrence
  // is dropped (at-most-once kept) — surface that, never swallow it.
  emitIfPersistFailed(rolledBack, automation.id, now, opts)
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
