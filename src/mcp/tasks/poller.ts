/** ADR-0196 — poll an `McpTasksPort` until terminal state, signal abort, or
 *  (TICKET-21) the server-advertised TTL elapses.
 *
 *  Single-purpose helper: loop `getInfo`, sleeping `intervalMs` between probes,
 *  returning the final `McpTaskInfo`. Aborting the signal resolves to `null`
 *  (no in-flight subscription left dangling). A TTL expiry returns the LAST
 *  observed info (NOT null) so the caller can distinguish "ran out of time,
 *  here is the final state + related ids" from "aborted". */

import type { McpTasksPort } from "./port"
import type { McpTaskInfo, TaskState } from "./types"
import { TERMINAL_TASK_STATES } from "./types"

const DEFAULT_INTERVAL_MS = 200

/** Cadence clamp (robustness, NOT a tuning heuristic): a server-advertised
 *  `pollIntervalMs` is bounded so a hostile/buggy value cannot busy-spin the
 *  loop (floor) or stall the model for hours (ceiling). The floor is the
 *  smallest sleep that still yields the event loop; the ceiling is a generous
 *  upper bound on any sane poll cadence. */
const MIN_CADENCE_MS = 1
const MAX_CADENCE_MS = 60_000

const isTerminal = (s: TaskState): boolean =>
  (TERMINAL_TASK_STATES as ReadonlyArray<TaskState>).includes(s)

/** Injectable timer surface — defaults to the real `setTimeout`-based wait.
 *  Tests pass a recording stub so cadence/TTL are asserted exactly (no real
 *  timers, no wall-clock flake). */
export type WaitFn = (ms: number, signal: AbortSignal) => Promise<void>

export interface PollOpts {
  signal: AbortSignal
  intervalMs?: number
  /** Injected clock (default `Date.now`) — drives TTL expiry. Pattern mirrors
   *  supervisor.ts / errors.ts: a bare `() => number`, no Clock abstraction. */
  now?: () => number
  /** Injected sleep (default {@link defaultWait}) — recorded by tests. */
  wait?: WaitFn
}

const defaultWait: WaitFn = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })

export const pollTask = async (
  port: McpTasksPort,
  taskId: string,
  opts: PollOpts,
): Promise<McpTaskInfo | null> => {
  const now = opts.now ?? Date.now
  const wait = opts.wait ?? defaultWait
  const start = now()
  while (!opts.signal.aborted) {
    const info = await port.getInfo(taskId)
    if (info === null) return null
    if (isTerminal(info.state)) return info
    // TTL: only when the server advertised one. Return the LAST observed info
    // (distinguishable from abort → null) so the model sees the final state.
    if (info.ttlMs !== undefined && now() - start >= info.ttlMs) return info
    // Cadence: server-advertised pollIntervalMs (clamped) overrides the
    // caller/default cadence.
    const cadence = Math.min(
      MAX_CADENCE_MS,
      Math.max(MIN_CADENCE_MS, info.pollIntervalMs ?? opts.intervalMs ?? DEFAULT_INTERVAL_MS),
    )
    await wait(cadence, opts.signal)
  }
  return null
}
