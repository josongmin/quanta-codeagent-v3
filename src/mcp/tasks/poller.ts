/** ADR-0196 — poll an `McpTasksPort` until terminal state or signal abort.
 *
 *  Single-purpose helper: loop `getInfo`, sleeping `intervalMs` between
 *  probes, returning the final `McpTaskInfo`. Aborting the signal resolves
 *  to `null` (no in-flight subscription left dangling). */

import type { McpTasksPort } from "./port"
import type { McpTaskInfo, TaskState } from "./types"
import { TERMINAL_TASK_STATES } from "./types"

const DEFAULT_INTERVAL_MS = 200

const isTerminal = (s: TaskState): boolean =>
  (TERMINAL_TASK_STATES as ReadonlyArray<TaskState>).includes(s)

export interface PollOpts {
  signal: AbortSignal
  intervalMs?: number
}

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
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
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  while (!opts.signal.aborted) {
    const info = await port.getInfo(taskId)
    if (info === null) return null
    if (isTerminal(info.state)) return info
    await wait(interval, opts.signal)
  }
  return null
}
