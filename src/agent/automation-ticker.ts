import { type TickOutcome, tickScheduler } from "@/scheduler/automation-engine"
import type { AgentConfig } from "./types"

/**
 * Automation-engine TICK WIRE (ADR-0240 §B).
 *
 * ONE responsibility: own the background drain that pumps the automation
 * engine while a session is alive — the incomplete-wire gate that keeps it
 * default-OFF (absent slot / handler / non-positive interval ⇒ no timer at
 * all), the `setInterval`/`clearInterval` injection seam tests drive with
 * fakes, the per-tick `tickScheduler` call with its throw absorption, and the
 * idempotent `stop()` handle the session lifecycle calls exactly once.
 *
 * It is the only place a timer is armed for the loop, which is why the handle,
 * the deps seam and the tick body live together.
 *
 * Split out of `loop-helpers.ts` (god-module ratchet) — pure move, no logic
 * change; every name stays re-exported from there.
 */

// ─── ADR-0240 §B — Automation engine tick wire ─────────────────────────

/** Handle returned by `startAutomationEngineTicker`. Idempotent stop. */
export interface AutomationEngineTickerHandle {
  stop: () => void
}

/** Injection seam for `setInterval` / `clearInterval`. Tests pass fakes; the
 *  composition root defaults to `globalThis.setInterval` / `clearInterval`. */
export interface AutomationTickerDeps {
  readonly setInterval: (cb: () => void, ms: number) => unknown
  readonly clearInterval: (handle: unknown) => void
}

const defaultTickerDeps: AutomationTickerDeps = {
  setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
}

/** Arm a `setInterval`-backed background drain for `automationEngine`.
 *
 *  Returns `undefined` when wire is incomplete (default-OFF byte-identical):
 *   - slot absent
 *   - `handler` absent
 *   - `tickIntervalMs` absent / 0 / negative / NaN
 *
 *  Each tick invokes `tickScheduler({ engine, now, handler })`. The optional
 *  `onTick` observer is consulted AFTER each tick; throws from the observer
 *  AND from the handler are absorbed — the timer keeps ticking. */
export const startAutomationEngineTicker = (
  cfg: AgentConfig,
  deps: AutomationTickerDeps = defaultTickerDeps,
): AutomationEngineTickerHandle | undefined => {
  const slot = cfg.automationEngine
  if (slot === undefined) return undefined
  const { engine, handler, tickIntervalMs, onTick, now, eligibility } = slot
  if (handler === undefined) return undefined
  if (tickIntervalMs === undefined || !Number.isFinite(tickIntervalMs) || tickIntervalMs <= 0) {
    return undefined
  }
  const clock: () => number = now ?? Date.now

  let stopped = false
  let handle: unknown = null

  const tick = (): void => {
    if (stopped) return
    tickScheduler({
      engine,
      now: clock(),
      handler,
      // ADR-0453 — forward the optional autorun-eligibility gate (absent ⇒ no
      // consult ⇒ byte-identical tick).
      ...(eligibility !== undefined ? { eligibility } : {}),
    })
      .then((outcome: TickOutcome) => {
        if (onTick !== undefined) {
          try {
            onTick(outcome)
          } catch {
            // observer throw absorbed — timer keeps ticking
          }
        }
      })
      .catch(() => {
        // tickScheduler is no-throw by contract; this is defense in depth
      })
  }

  handle = deps.setInterval(tick, tickIntervalMs)

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      if (handle !== null) {
        try {
          deps.clearInterval(handle)
        } catch {
          // already cleared by host shutdown
        }
        handle = null
      }
    },
  }
}
