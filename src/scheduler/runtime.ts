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
    } catch {
      // Load errors are NO-THROW per the port contract; defensive double-guard.
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
    await persistError(automation, "model probe threw unexpectedly", opts)
    opts.sink?.emit({
      type: "scheduler.error",
      automationId: automation.id,
      errorMessage: "model probe threw unexpectedly",
      at: now,
    })
    return
  }

  if (chosen.reason === "all-unavailable") {
    const msg = "all models unavailable"
    await persistError(automation, msg, opts)
    opts.sink?.emit({
      type: "scheduler.error",
      automationId: automation.id,
      errorMessage: msg,
      at: now,
    })
    return
  }

  // 4. Enqueue the prompt onto the agent loop. The reactor uses the same
  //    port for `manual_resume` — we reuse the exact seam, not a new trigger.
  try {
    await opts.agentLoop.enqueueUserMessage(automation.prompt, {
      modelOverride: chosen.chosen,
    })
  } catch (e) {
    const msg = `enqueue failed: ${stringifyError(e)}`
    await persistError(automation, msg, opts)
    opts.sink?.emit({
      type: "scheduler.error",
      automationId: automation.id,
      errorMessage: msg,
      at: now,
    })
    return
  }

  // 5. Persist the success (fireCount + 1, lastFiredAt = now).
  const fired = recordFire(automation, now)
  try {
    await opts.store.save(opts.workspace, fired)
  } catch {
    opts.sink?.emit({
      type: "scheduler.skipped",
      automationId: automation.id,
      reason: "store-save-failed",
      at: now,
    })
    // The agent loop already received the prompt; we lost the persistence
    // round-trip. Next tick will re-fire (the recorded state is the previous
    // anchor — runtime is at-least-once for now, by design + a deliberate
    // limitation documented in the ADR).
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

const persistError = async (
  automation: Automation,
  message: string,
  opts: SchedulerRuntimeOpts,
): Promise<void> => {
  const errored = markError(automation, message)
  try {
    await opts.store.save(opts.workspace, errored)
  } catch {
    // Swallow — `error` arm is observable in next load attempt's failure.
  }
}

const skipReasonFromStatus = (s: Automation["status"]): "paused" | "deleted" | "status-error" => {
  if (s === "paused") return "paused"
  if (s === "deleted") return "deleted"
  return "status-error"
}

const stringifyError = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : "unknown"
