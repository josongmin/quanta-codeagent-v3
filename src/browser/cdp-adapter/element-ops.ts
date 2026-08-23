/**
 * CDP adapter — element/timing helpers shared by the operation groups.
 *
 * These were already at module scope in `cdp-adapter.ts`, deliberately: keeping
 * the polling loop and the resolve-then-normalize shape OUT of the port methods
 * is what holds those methods under the cognitive-complexity ceiling. They move
 * here unchanged so the interaction and page groups can both reach them.
 */

import { err, ok, type Result } from "@/shared"
import type { Clock, Scheduler } from "../cdp/ports"
import type { BrowserError, ScrollOpts, WaitOpts } from "../types"
import type { Pt } from "./input-events"
import { rectJs, selectorPresentJs } from "./page-scripts"
import { activeTab, type EvalFn, type SessionState } from "./session-state"

/** Sleep `ms` on the injected scheduler, racing an optional abort and cancelling
 *  the timer on settle (same deterministic pattern as readDevToolsEndpoint). */
export const sleep = (
  scheduler: Scheduler,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> =>
  new Promise<void>((resolve) => {
    const cancel = scheduler.schedule(ms, () => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    })
    const onAbort = (): void => {
      cancel()
      resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })

interface PollDeps {
  eval(expr: string, signal?: AbortSignal): Promise<Result<unknown, BrowserError>>
  readonly scheduler: Scheduler
  readonly clock: Clock
}

/** Default `waitForSelector` deadline when the caller omits `opts.timeoutMs`.
 *  5s matches the CDP/Puppeteer convention for a single selector wait. */
export const DEFAULT_WAIT_SELECTOR_MS = 5_000

/** Poll the page for `opts.selector` until present, timeout, or abort. Kept at
 *  module scope (out of the adapter object) so the loop's branching does not
 *  inflate the adapter method's cognitive complexity. */
export const pollForSelector = async (
  d: PollDeps,
  opts: WaitOpts,
  signal: AbortSignal | undefined,
): Promise<Result<void, BrowserError>> => {
  const isAborted = (): boolean => signal?.aborted === true
  if (isAborted()) return err({ kind: "cancelled" })
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_SELECTOR_MS
  const pollMs = 100
  const start = d.clock.now()
  const js = selectorPresentJs(opts.selector)
  for (;;) {
    if (isAborted()) return err({ kind: "cancelled" })
    const r = await d.eval(js, signal)
    if (!r.ok) return r
    if (r.value === true) return ok(undefined)
    if (d.clock.now() - start >= timeoutMs) return err({ kind: "timeout", ms: timeoutMs })
    await sleep(d.scheduler, pollMs, signal)
  }
}

export const scrollDelta = (opts: ScrollOpts): [number, number] => {
  const amt = opts.amount ?? 400
  switch (opts.direction) {
    case "up":
      return [0, -amt]
    case "left":
      return [-amt, 0]
    case "right":
      return [amt, 0]
    default:
      return [0, amt]
  }
}

/** Resolve a ref, run the per-element JS, and normalize the `false`/not-found
 *  result — the shared shape for click/fill/select/scroll-to-ref. */
export const evalAction = async (
  s: SessionState,
  ref: string,
  buildJs: (path: string) => string,
  signal: AbortSignal | undefined,
  evalFn: EvalFn,
): Promise<Result<void, BrowserError>> => {
  const path = activeTab(s).refMap.resolve(ref)
  if (path === null) return err({ kind: "element-not-found", ref })
  const r = await evalFn(s, buildJs(path), signal)
  if (!r.ok) return r
  if (r.value === false) return err({ kind: "element-not-found", ref })
  return ok(undefined)
}

/** Resolve a ref to its element-center viewport point (for drag endpoints). */
export const refPoint = async (
  s: SessionState,
  ref: string,
  signal: AbortSignal | undefined,
  evalFn: EvalFn,
): Promise<Result<Pt, BrowserError>> => {
  const path = activeTab(s).refMap.resolve(ref)
  if (path === null) return err({ kind: "element-not-found", ref })
  const r = await evalFn(s, rectJs(path), signal)
  if (!r.ok) return r
  const pt = r.value as { x?: unknown; y?: unknown } | null
  if (pt === null || typeof pt.x !== "number" || typeof pt.y !== "number") {
    return err({ kind: "element-not-found", ref })
  }
  return ok({ x: pt.x, y: pt.y })
}
