import { spawn } from "node:child_process"
import { rmSync } from "node:fs"

/**
 * Process lifecycle for the full-suite shard runner.
 *
 * The runner overlaps two Bun test workers, and each worker spawns its own
 * descendants (real browsers, language servers, git worktrees). Three
 * invariants live here, because losing any of them lets a dead campaign leak
 * live processes into the next one:
 *
 * 1. Every worker starts as the leader of a NEW process group, so one signal
 *    (`kill(-pgid)`) reaches the whole descendant tree. `Bun.spawn` cannot do
 *    this — its children share the runner's group (measured on Bun 1.3.14) —
 *    so workers are spawned through `node:child_process` with `detached`.
 * 2. A campaign never abandons a worker: the first failure cancels every peer
 *    group and the batch is reaped with `allSettled` before the failure
 *    propagates.
 * 3. The run root is deleted and the repository lease released only after
 *    every tracked group is confirmed empty (descendants drained), so a new
 *    campaign can never overlap the corpse of this one.
 */

export interface ShardWorkerExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export interface ShardWorkerHandle {
  readonly pid: number
  /** Resolves when the direct child exits; rejects only on a spawn failure. */
  readonly exited: Promise<ShardWorkerExit>
  /** True once this worker's group was killed by cancel/cancelAll. */
  readonly cancelled: boolean
  /** Kill the worker's whole process group; resolves when the group is empty. */
  cancel(): Promise<boolean>
}

export interface SpawnShardWorkerOptions {
  readonly cmd: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stdoutFd: number
  readonly stderrFd: number
  /**
   * Test workers get no stdin (the default): a suite that reads it is hung,
   * not interactive. The campaign wrapper, whose child is the gate runner an
   * operator actually talks to, passes "inherit".
   */
  readonly stdin?: "ignore" | "inherit"
}

export interface KillProcessTreeOptions {
  readonly termGraceMs?: number
  readonly killGraceMs?: number
  readonly pollMs?: number
}

export interface DrainOutcome {
  readonly drained: boolean
  readonly survivors: readonly number[]
}

/** kill(-pgid, 0) — EPERM still means "someone is alive in that group". */
export const processGroupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const signalGroup = (pgid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pgid, signal)
  } catch {
    // The whole group already exited; nothing left to signal.
  }
}

const waitForEmptyGroup = async (
  pgid: number,
  deadline: number,
  pollMs: number,
): Promise<boolean> => {
  while (processGroupAlive(pgid)) {
    if (Date.now() >= deadline) return false
    await Bun.sleep(pollMs)
  }
  return true
}

/**
 * SIGTERM the group, escalate to SIGKILL, and report whether it emptied.
 * Bounded: worst case termGraceMs + killGraceMs, never an unbounded wait.
 */
export const killProcessTree = async (
  pgid: number,
  options: KillProcessTreeOptions = {},
): Promise<boolean> => {
  const termGraceMs = options.termGraceMs ?? 2_000
  const killGraceMs = options.killGraceMs ?? 5_000
  const pollMs = options.pollMs ?? 50
  if (!processGroupAlive(pgid)) return true
  signalGroup(pgid, "SIGTERM")
  if (await waitForEmptyGroup(pgid, Date.now() + termGraceMs, pollMs)) return true
  signalGroup(pgid, "SIGKILL")
  return waitForEmptyGroup(pgid, Date.now() + killGraceMs, pollMs)
}

interface TrackedWorker {
  readonly pgid: number
  cancelled: boolean
}

/**
 * Tracks every live worker process GROUP for one campaign. A group stays
 * tracked past the direct child's exit while descendants survive, and is
 * unregistered only once the group is observed empty — that observation is
 * what gates run-root deletion and lease release.
 */
export class ShardProcessRegistry {
  private readonly tracked = new Set<TrackedWorker>()
  private readonly killOptions: KillProcessTreeOptions

  constructor(killOptions: KillProcessTreeOptions = {}) {
    this.killOptions = killOptions
  }

  liveGroups(): readonly number[] {
    this.sweep()
    return [...this.tracked].map((worker) => worker.pgid)
  }

  private sweep(): void {
    for (const worker of [...this.tracked]) {
      if (!processGroupAlive(worker.pgid)) this.tracked.delete(worker)
    }
  }

  spawnWorker(options: SpawnShardWorkerOptions): ShardWorkerHandle {
    const [command, ...args] = options.cmd
    if (command === undefined) throw new Error("[test:shards] empty worker command")
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      // Own process group: one kill(-pgid) reaches every descendant.
      detached: true,
      stdio: [options.stdin ?? "ignore", options.stdoutFd, options.stderrFd],
    })
    const exited = new Promise<ShardWorkerExit>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => {
        // The direct child is gone, but grandchildren may not be. Only an
        // observed-empty group leaves the registry.
        this.sweep()
        resolve({ code, signal })
      })
    })
    const pid = child.pid
    if (pid === undefined) {
      // Spawn failed synchronously; `exited` rejects with the spawn error.
      return {
        pid: -1,
        exited,
        cancelled: false,
        cancel: () => Promise.resolve(true),
      }
    }
    const worker: TrackedWorker = { pgid: pid, cancelled: false }
    this.tracked.add(worker)
    const registry = this
    return {
      pid,
      exited,
      get cancelled() {
        return worker.cancelled
      },
      async cancel(): Promise<boolean> {
        worker.cancelled = true
        const emptied = await killProcessTree(worker.pgid, registry.killOptions)
        if (emptied) registry.tracked.delete(worker)
        return emptied
      },
    }
  }

  /**
   * Kill every tracked live group and wait (bounded) for each to empty.
   * Returns the groups that survived even SIGKILL; those keep the campaign's
   * run root on disk so a live descendant never has its cwd deleted.
   */
  async cancelAll(): Promise<DrainOutcome> {
    this.sweep()
    await Promise.all(
      [...this.tracked].map(async (worker) => {
        worker.cancelled = true
        const emptied = await killProcessTree(worker.pgid, this.killOptions)
        if (emptied) this.tracked.delete(worker)
      }),
    )
    this.sweep()
    const survivors = [...this.tracked].map((worker) => worker.pgid)
    return { drained: survivors.length === 0, survivors }
  }
}

export interface ScheduledTask<T> {
  readonly key: number
  readonly resourceClass: string
  run(): Promise<T>
}

export interface ResourceScheduleOptions<T> {
  /** Start-preference order (typically longest predicted first). */
  readonly tasks: readonly ScheduledTask<T>[]
  overlap(left: string, right: string): boolean
  /**
   * Measured before EVERY start (memory/load re-sampled), given the current
   * live worker count. A return below 1 while nothing runs is treated as 1 —
   * the schedule always makes progress.
   */
  desiredConcurrency(runningCount: number): Promise<number>
  cancelAll(): Promise<unknown>
  onStart?(task: ScheduledTask<T>): void
  /** Bound on waiting for peers to settle AFTER a failure cancelled them. */
  readonly reapTimeoutMs?: number
  onReapTimeout?(pending: number): void
}

type SettledTask<T> =
  | { readonly key: number; readonly ok: true; readonly value: T }
  | { readonly key: number; readonly ok: false; readonly error: unknown }

/**
 * Resource-aware scheduler for shard chunks.
 *
 * - Two chunks overlap only when their resource classes are compatible.
 * - Concurrency is re-measured before every start, so a host that got busy
 *   mid-campaign stops taking a second worker instead of merely inflating
 *   timeouts.
 * - The first failure cancels every live peer's process group, the schedule
 *   starts nothing more, and every in-flight task is reaped (bounded) before
 *   the PRIMARY failure propagates — no task is ever abandoned mid-flight.
 */
interface ScheduleState<T> {
  readonly queue: ScheduledTask<T>[]
  readonly running: Map<number, { promise: Promise<SettledTask<T>>; resourceClass: string }>
  readonly results: Map<number, T>
  failed: boolean
  primary: unknown
}

const startablePosition = <T>(
  state: ScheduleState<T>,
  overlap: ResourceScheduleOptions<T>["overlap"],
): number =>
  state.queue.findIndex((task) =>
    [...state.running.values()].every(({ resourceClass }) =>
      overlap(resourceClass, task.resourceClass),
    ),
  )

/** Start every queued task the measured concurrency and class matrix allow. */
const startEligibleTasks = async <T>(
  state: ScheduleState<T>,
  options: ResourceScheduleOptions<T>,
): Promise<void> => {
  while (!state.failed && state.queue.length > 0) {
    const desired = await options.desiredConcurrency(state.running.size)
    if (state.running.size > 0 && state.running.size >= Math.max(1, desired)) return
    const position = startablePosition(state, options.overlap)
    if (position === -1) return
    const [task] = state.queue.splice(position, 1)
    if (task === undefined) return
    options.onStart?.(task)
    const promise = task.run().then(
      (value): SettledTask<T> => ({ key: task.key, ok: true, value }),
      (error): SettledTask<T> => ({ key: task.key, ok: false, error }),
    )
    state.running.set(task.key, { promise, resourceClass: task.resourceClass })
  }
}

/** Race the in-flight tasks; after a failure, bound the reap wait. */
const settleNextTask = <T>(
  state: ScheduleState<T>,
  options: ResourceScheduleOptions<T>,
): Promise<SettledTask<T> | "reap-timeout"> => {
  const racers: Promise<SettledTask<T> | "reap-timeout">[] = [...state.running.values()].map(
    ({ promise }) => promise,
  )
  if (state.failed) {
    racers.push(Bun.sleep(options.reapTimeoutMs ?? 60_000).then(() => "reap-timeout" as const))
  }
  return Promise.race(racers)
}

export const runResourceAwareSchedule = async <T>(
  options: ResourceScheduleOptions<T>,
): Promise<Map<number, T>> => {
  const state: ScheduleState<T> = {
    queue: [...options.tasks],
    running: new Map(),
    results: new Map(),
    failed: false,
    primary: undefined,
  }
  while (state.queue.length > 0 || state.running.size > 0) {
    await startEligibleTasks(state, options)
    if (state.running.size === 0) break
    const settled = await settleNextTask(state, options)
    if (settled === "reap-timeout") {
      options.onReapTimeout?.(state.running.size)
      break
    }
    state.running.delete(settled.key)
    if (settled.ok) {
      state.results.set(settled.key, settled.value)
      continue
    }
    if (!state.failed) {
      state.failed = true
      state.primary = settled.error
      await options.cancelAll()
    }
  }
  if (state.failed) throw state.primary
  return state.results
}

export interface CampaignCleanupInput {
  readonly registry: Pick<ShardProcessRegistry, "cancelAll">
  readonly runRoot: string
  log(line: string): void
}

/**
 * Drain every tracked worker group, then delete the campaign's run root —
 * but ONLY once no descendant remains. A surviving group keeps the run root
 * (its cwd/TMPDIR) on disk and is reported instead of being ripped out from
 * under a live process.
 */
export const drainCampaign = async (input: CampaignCleanupInput): Promise<DrainOutcome> => {
  const outcome = await input.registry.cancelAll()
  if (outcome.drained) {
    rmSync(input.runRoot, { recursive: true, force: true })
  } else {
    input.log(
      `[test:shards] WARN worker group(s) survived SIGKILL: ${outcome.survivors.join(", ")}; ` +
        `leaving ${input.runRoot} in place\n`,
    )
  }
  return outcome
}

export const terminationExitCode = (signal: NodeJS.Signals): number =>
  signal === "SIGINT" ? 130 : 143

export interface CampaignTerminationInput extends CampaignCleanupInput {
  readonly signal: NodeJS.Signals
  releaseLease(): void
}

/** Signal path: cancel every group, drain, release the lease, pick the exit code. */
export const terminateCampaignOnSignal = async (
  input: CampaignTerminationInput,
): Promise<number> => {
  input.log(`[test:shards] SIGNAL ${input.signal}; cancelling worker group(s)\n`)
  await drainCampaign(input)
  input.releaseLease()
  return terminationExitCode(input.signal)
}
