/**
 * `tools/dev/shard-output-budget` — output growth is not proof of life, and a
 * spool is not something to load into memory.
 *
 * # Two defects in one interval
 *
 * The chunk watchdog decided liveness with:
 *
 *     if (tick.spoolBytes !== tick.lastSpoolBytes) return "progressed"
 *
 * so ANY byte written resets the 12-minute inactivity timer. A worker stuck in a
 * `console.log` loop — a retry that logs, a readiness poll that prints, a test
 * that dumps a diff every iteration — is maximally "alive" by that measure and
 * runs until the JOB timeout, which is the outer boundary the watchdog exists to
 * stay inside. There was also no total wall deadline at all: a chunk that keeps
 * producing can hold the lane indefinitely.
 *
 * And both the timeout diagnostic and the normal completion path did
 * `readFileSync(spoolPath, "utf8")` over the whole file. The spool is the
 * complete stdout+stderr of up to 160 test files; the runner's own RSS is the
 * thing being protected, and the reaction to a pathological producer was to load
 * everything it produced.
 *
 * # What replaces it
 *
 * Three bounds instead of one, each with its own typed outcome so a kill says
 * WHY:
 *
 *   inactivity   — nothing written for N ms. Unchanged in spirit.
 *   total wall   — the chunk has been running longer than any chunk should,
 *                  regardless of how chatty it is.
 *   output cap   — the chunk has written more than a plausible suite can. This
 *                  is the one that closes the hole: past the cap, growth stops
 *                  counting as progress.
 *
 * The cap is deliberately generous. It is not a style rule about logging; it is
 * the point past which "still writing" has stopped being evidence.
 */

export type ShardWatchdogAction =
  | "progressed"
  | "waiting"
  | "already-killing"
  | "kill-inactive"
  | "kill-total-wall"
  | "kill-output-cap"

export interface ShardWatchdogTick {
  readonly spoolBytes: number
  readonly lastSpoolBytes: number
  /** Since the last observed write. */
  readonly idleMs: number
  /** Since the chunk started, regardless of output. */
  readonly elapsedMs: number
  readonly inactivityTimeoutMs: number
  readonly totalWallTimeoutMs: number
  readonly outputCapBytes: number
  readonly alreadyKilling: boolean
}

/**
 * Decide what the watchdog should do this tick.
 *
 * Order matters: the two ABSOLUTE bounds are checked before the progress
 * heuristic, because the whole defect was a heuristic that could veto them.
 */
export const shardWatchdogAction = (tick: ShardWatchdogTick): ShardWatchdogAction => {
  if (tick.alreadyKilling) return "already-killing"
  if (tick.spoolBytes > tick.outputCapBytes) return "kill-output-cap"
  if (tick.elapsedMs >= tick.totalWallTimeoutMs) return "kill-total-wall"
  if (tick.spoolBytes !== tick.lastSpoolBytes) return "progressed"
  if (tick.idleMs < tick.inactivityTimeoutMs) return "waiting"
  return "kill-inactive"
}

export const isKill = (action: ShardWatchdogAction): boolean => action.startsWith("kill-")

/** One line saying which bound was crossed, for the kill notice. */
export const describeWatchdogKill = (
  action: ShardWatchdogAction,
  tick: ShardWatchdogTick,
): string => {
  if (action === "kill-output-cap") {
    return (
      `output cap: wrote ${tick.spoolBytes} bytes, over the ${tick.outputCapBytes}-byte ceiling. ` +
      "Past this point continued output is not evidence the chunk is making progress"
    )
  }
  if (action === "kill-total-wall") {
    return `total wall: running ${tick.elapsedMs}ms, over the ${tick.totalWallTimeoutMs}ms ceiling`
  }
  return `inactive: nothing written for ${tick.idleMs}ms (ceiling ${tick.inactivityTimeoutMs}ms)`
}

/**
 * Byte window to read from the END of a spool for a tail.
 *
 * Returned as an offset/length rather than reading here so the caller owns the
 * file handle, and so the arithmetic is testable without a file. A window larger
 * than the file starts at 0.
 */
export const spoolTailWindow = (
  fileBytes: number,
  windowBytes: number,
): { readonly start: number; readonly length: number } => {
  const size = Math.max(0, fileBytes)
  const want = Math.max(0, windowBytes)
  if (want >= size) return { start: 0, length: size }
  return { start: size - want, length: want }
}
