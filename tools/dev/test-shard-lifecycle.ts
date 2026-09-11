import { spawn } from "node:child_process"
import { rmSync } from "node:fs"
import {
  defaultProcessObserver,
  hasRunningMemberRows,
  type LeaderIdentity,
  leaderIdentityFromSnapshot,
  nextPollDelay,
  type PollSchedule,
  type ProcessObserver,
  type ProcessSnapshot,
  pollSchedule,
  renderProcessRow,
  rowsInGroup,
  type SnapshotUnavailableReason,
  seededObserver,
} from "./process-observer"

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
  /** First poll interval. Later polls back off geometrically toward `maxPollMs`. */
  readonly pollMs?: number
  readonly maxPollMs?: number
  /** Injection seam: observer, existence probe, signal sink, clock. */
  readonly deps?: Partial<ProcessLifecycleDeps>
  /** A snapshot already taken this tick, spent as the first observation. */
  readonly seedSnapshot?: ProcessSnapshot
}

/** A group this campaign could not finish accounting for. */
export interface AbandonedGroup {
  readonly pgid: number
  /**
   * `recycled`   — the leader is alive with a CONFIRMED different identity.
   * `unverified` — identity is unknown (at spawn, at kill, or both), so there
   *                is no evidence this group is ours.
   */
  readonly reason: "recycled" | "unverified"
  readonly detail: string
}

export interface DrainOutcome {
  readonly drained: boolean
  /** Groups still holding resources, plus every group we had to abandon. */
  readonly survivors: readonly number[]
  readonly abandoned: readonly AbandonedGroup[]
}

/**
 * Everything in this file that touches the OS, in one injectable bundle.
 *
 * `observer` is the only thing that spawns; `groupExists` is a syscall;
 * `now`/`sleep` are the clock. A test can therefore drive a 70-second survivor
 * in microseconds and still assert the REAL poll arithmetic and the REAL signal
 * sequence, rather than a mock of them.
 */
export interface ProcessLifecycleDeps {
  readonly observer: ProcessObserver
  readonly groupExists: (pgid: number) => boolean
  readonly signal: (pgid: number, signal: NodeJS.Signals) => void
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

const signalGroup = (pgid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pgid, signal)
  } catch {
    // The whole group already exited; nothing left to signal.
  }
}

/** Literal existence: does the kernel still know this group at all. */
export const processGroupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export const resolveProcessLifecycleDeps = (
  partial: Partial<ProcessLifecycleDeps> = {},
): ProcessLifecycleDeps => ({
  observer: partial.observer ?? defaultProcessObserver(),
  groupExists: partial.groupExists ?? processGroupAlive,
  signal: partial.signal ?? signalGroup,
  now: partial.now ?? (() => Date.now()),
  sleep: partial.sleep ?? ((ms: number) => Bun.sleep(ms)),
})

/**
 * Does this process group still HOLD anything — the question a drain asks.
 *
 * Three answers, not two. `unobservable` is NOT `holds` and NOT `empty`: the
 * drain loop fails it closed to "still there" (so a campaign is never blessed
 * on a probe that did not run), while the kill path reports it as a typed
 * failure rather than as a group that survived SIGKILL.
 */
export type GroupProbe =
  | { readonly kind: "empty" }
  | { readonly kind: "holds" }
  | {
      readonly kind: "unobservable"
      readonly reason: SnapshotUnavailableReason
      readonly detail: string
    }

export const probeGroupFromSnapshot = (snapshot: ProcessSnapshot, pgid: number): GroupProbe => {
  if (snapshot.kind === "unavailable") {
    return { kind: "unobservable", reason: snapshot.reason, detail: snapshot.detail }
  }
  return hasRunningMemberRows(snapshot.rows, pgid) ? { kind: "holds" } : { kind: "empty" }
}

/**
 * `kill(-pgid, 0)` stays the fast path: a group the kernel has forgotten costs
 * ZERO snapshots, which is the overwhelmingly common case on every tick of a
 * healthy campaign. Only when the kernel still knows the group is the table
 * read — and only then can a zombie-vs-running distinction matter.
 */
const probeGroup = (pgid: number, deps: ProcessLifecycleDeps): GroupProbe =>
  deps.groupExists(pgid)
    ? probeGroupFromSnapshot(deps.observer.snapshot(), pgid)
    : { kind: "empty" }

/**
 * Does the group still hold resources? Deliberately weaker than existence: a
 * group of zombies exists and cannot be killed, but owns no fd, port or working
 * directory, so waiting for it is waiting forever and refusing the campaign
 * over it is refusing over nothing.
 */
export const processGroupHoldsResources = (
  pgid: number,
  deps: Partial<ProcessLifecycleDeps> = {},
): boolean => probeGroup(pgid, resolveProcessLifecycleDeps(deps)).kind !== "empty"

const scheduleFor = (options: KillProcessTreeOptions): PollSchedule =>
  pollSchedule({
    ...(options.pollMs === undefined ? {} : { initialMs: options.pollMs }),
    ...(options.maxPollMs === undefined ? {} : { maxMs: options.maxPollMs }),
  })

/**
 * Poll until the group empties or the deadline passes.
 *
 * The backoff is the whole point. A flat 50ms poll across the campaign's
 * 60s TERM + 10s KILL grace is up to ~1,400 `ps` spawns for ONE group, on a box
 * that is already unhealthy enough to need a 60s grace. Geometric 50ms→3s costs
 * ~35 for the same 70 seconds and still notices a normal death in 50ms.
 */
const waitForEmptyGroup = async (
  pgid: number,
  deadline: number,
  deps: ProcessLifecycleDeps,
  schedule: PollSchedule,
): Promise<GroupProbe> => {
  let attempt = 0
  for (;;) {
    const probe = probeGroup(pgid, deps)
    if (probe.kind === "empty") return probe
    const remaining = deadline - deps.now()
    if (remaining <= 0) return probe
    await deps.sleep(Math.min(nextPollDelay(attempt, schedule), remaining))
    attempt += 1
  }
}

/**
 * What a kill attempt is allowed to conclude.
 *
 * `unobservable` exists so "we could not see whether it died" never renders as
 * either success or "survived SIGKILL": it is its own outcome, it keeps
 * `drained` false, and it names the reason the observer gave.
 */
export type KillTreeOutcome =
  | { readonly kind: "emptied" }
  | { readonly kind: "survived" }
  | {
      readonly kind: "unobservable"
      readonly reason: SnapshotUnavailableReason
      readonly detail: string
    }

/**
 * SIGTERM the group, escalate to SIGKILL, and report a typed outcome.
 *
 * Bounded twice over: by wall clock (termGraceMs + killGraceMs, on the injected
 * clock) AND by observation budget (the backoff schedule). An observer that
 * never answers can no longer stall this — it answers `unavailable` at its own
 * timeout and the loop keeps its deadline.
 */
export const killProcessTreeOutcome = async (
  pgid: number,
  options: KillProcessTreeOptions = {},
): Promise<KillTreeOutcome> => {
  const base = resolveProcessLifecycleDeps(options.deps)
  const deps: ProcessLifecycleDeps =
    options.seedSnapshot === undefined
      ? base
      : { ...base, observer: seededObserver(base.observer, options.seedSnapshot) }
  const schedule = scheduleFor(options)
  if (probeGroup(pgid, deps).kind === "empty") return { kind: "emptied" }
  deps.signal(pgid, "SIGTERM")
  const termDeadline = deps.now() + (options.termGraceMs ?? 2_000)
  if ((await waitForEmptyGroup(pgid, termDeadline, deps, schedule)).kind === "empty") {
    return { kind: "emptied" }
  }
  deps.signal(pgid, "SIGKILL")
  const killDeadline = deps.now() + (options.killGraceMs ?? 5_000)
  const afterKill = await waitForEmptyGroup(pgid, killDeadline, deps, schedule)
  if (afterKill.kind === "empty") return { kind: "emptied" }
  return afterKill.kind === "unobservable"
    ? { kind: "unobservable", reason: afterKill.reason, detail: afterKill.detail }
    : { kind: "survived" }
}

/** Boolean form: did the group actually empty. */
export const killProcessTree = async (
  pgid: number,
  options: KillProcessTreeOptions = {},
): Promise<boolean> => (await killProcessTreeOutcome(pgid, options)).kind === "emptied"

/**
 * May this group be signalled, given what we knew at spawn and what we can see
 * now? The single decision the pid-recycle guard turns on, pure and total.
 *
 * The rule that changed: `unknown` is NEVER safe. The old code compared
 * `string | undefined` and read `undefined` as "leader exited, go ahead", so a
 * `ps` that failed — at spawn OR at kill time — silently disabled the guard
 * entirely, precisely on the boxes sick enough to make pid recycling plausible.
 * Unknown now means "no evidence this group is ours", which is a refusal.
 *
 * `leader-exited` on BOTH sides stays safe-to-kill and that is deliberate:
 * anything still in a leaderless group is our own descendant, and a recycled
 * pid that had claimed this group number would itself be alive and so be caught
 * by the identity comparison instead.
 */
export type KillTargetVerdict =
  | { readonly kind: "ours" }
  | { readonly kind: "leader-exited" }
  | { readonly kind: "recycled"; readonly detail: string }
  | { readonly kind: "unverified"; readonly detail: string }

export const classifyKillTarget = (
  recorded: LeaderIdentity,
  current: LeaderIdentity,
): KillTargetVerdict => {
  if (current.kind === "unknown") {
    return { kind: "unverified", detail: `identity unreadable at kill time (${current.reason})` }
  }
  if (recorded.kind === "unknown") {
    return { kind: "unverified", detail: `identity unreadable at spawn time (${recorded.reason})` }
  }
  if (current.kind === "leader-exited") {
    return recorded.kind === "leader-exited" || recorded.kind === "identity"
      ? { kind: "leader-exited" }
      : { kind: "unverified", detail: "no recorded identity to compare" }
  }
  if (recorded.kind === "leader-exited") {
    // We recorded "no leader" and now a leader is alive: that is a process we
    // have never identified, so it is not ours to signal.
    return { kind: "unverified", detail: "a leader appeared that was absent at spawn" }
  }
  return recorded.value === current.value
    ? { kind: "ours" }
    : { kind: "recycled", detail: `leader identity changed: ${recorded.value} -> ${current.value}` }
}

/** Verdicts that permit a signal. Exhaustive by construction, so a new verdict
 *  must be classified here rather than defaulting into "go ahead and kill". */
export const KILL_TARGET_PERMITS_SIGNAL: Readonly<Record<KillTargetVerdict["kind"], boolean>> = {
  ours: true,
  "leader-exited": true,
  recycled: false,
  unverified: false,
}

interface TrackedWorker {
  readonly pgid: number
  /** Leader identity at spawn — typed, so "we could not look" survives. */
  readonly leader: LeaderIdentity
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
  /** Groups this campaign could not finish accounting for, and why. */
  private readonly abandoned = new Map<number, AbandonedGroup>()
  private readonly killOptions: KillProcessTreeOptions
  private readonly deps: ProcessLifecycleDeps

  constructor(killOptions: KillProcessTreeOptions = {}) {
    this.killOptions = killOptions
    this.deps = resolveProcessLifecycleDeps(killOptions.deps)
  }

  /** How many times this registry has read the process table. Asserted. */
  observerCalls(): number {
    return this.deps.observer.calls
  }

  liveGroups(): readonly number[] {
    this.sweep()
    return [...this.tracked].map((worker) => worker.pgid)
  }

  /**
   * Drop every group the kernel has forgotten — using at most ONE snapshot for
   * the whole set, not one per worker. `groupExists` is a syscall, so a sweep
   * over groups that are all gone (the normal case) still costs zero spawns.
   */
  private sweep(): void {
    const live = [...this.tracked].filter((worker) => this.deps.groupExists(worker.pgid))
    for (const worker of this.tracked) {
      if (!live.includes(worker)) this.tracked.delete(worker)
    }
    if (live.length === 0) return
    const snapshot = this.deps.observer.snapshot()
    // An unreadable table is not evidence of a drain: keep every group tracked.
    if (snapshot.kind !== "ok") return
    for (const worker of live) {
      if (!hasRunningMemberRows(snapshot.rows, worker.pgid)) this.tracked.delete(worker)
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
    const worker: TrackedWorker = {
      pgid: pid,
      // A TARGETED probe, not a whole-table read: this is the one identity
      // question with no other consumer to share a snapshot with, and it runs
      // synchronously on the spawn path. MEASURED, the difference is ~41ms vs
      // ~77ms of blocked event loop per worker — enough, on this host, to move
      // a campaign driver's SIGTERM-handler installation past the point where
      // its first worker is already running.
      leader: this.deps.observer.identity(pid),
      cancelled: false,
    }
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
        return registry.killTracked(worker)
      },
    }
  }

  /**
   * Kill one tracked group, but only after confirming it is still OURS.
   *
   * Two ways to fail that confirmation, and NEITHER may send a signal:
   *
   *  - `recycled`   — the leader is alive with a confirmed different identity.
   *                   The pid was reused; this tree belongs to a stranger, and
   *                   SIGKILLing it is the worst bug this file can have.
   *  - `unverified` — identity is unknown (the `ps` that would have answered
   *                   failed, at spawn or now). There is no evidence the group
   *                   is ours, and "no evidence" is not permission.
   *
   * Either way the worker leaves tracking untouched and is recorded as
   * abandoned, so the campaign reports `drained: false` rather than deleting a
   * run root out from under processes it can no longer identify.
   */
  private async killTracked(worker: TrackedWorker): Promise<boolean> {
    const snapshot = this.deps.observer.snapshot()
    const verdict = classifyKillTarget(
      worker.leader,
      leaderIdentityFromSnapshot(snapshot, worker.pgid),
    )
    if (!KILL_TARGET_PERMITS_SIGNAL[verdict.kind]) {
      this.tracked.delete(worker)
      this.abandoned.set(worker.pgid, {
        pgid: worker.pgid,
        reason: verdict.kind === "recycled" ? "recycled" : "unverified",
        detail: verdict.kind === "ours" || verdict.kind === "leader-exited" ? "" : verdict.detail,
      })
      return false
    }
    const outcome = await killProcessTreeOutcome(worker.pgid, {
      ...this.killOptions,
      deps: this.deps,
      // The identity snapshot above is this tick's observation; spend it as the
      // kill path's first probe instead of asking the kernel the same question
      // a microsecond later.
      seedSnapshot: snapshot,
    })
    if (outcome.kind === "emptied") {
      this.tracked.delete(worker)
      return true
    }
    if (outcome.kind === "unobservable") {
      this.tracked.delete(worker)
      this.abandoned.set(worker.pgid, {
        pgid: worker.pgid,
        reason: "unverified",
        detail: `drain unobservable (${outcome.reason}): ${outcome.detail}`,
      })
    }
    return false
  }

  /**
   * Kill every tracked live group and wait (bounded) for each to empty.
   * Survivors and abandoned groups both keep the campaign's run root on disk,
   * so a live descendant never has its cwd deleted.
   */
  async cancelAll(): Promise<DrainOutcome> {
    this.sweep()
    await Promise.all(
      [...this.tracked].map(async (worker) => {
        worker.cancelled = true
        await this.killTracked(worker)
      }),
    )
    this.sweep()
    const survivors = [...this.tracked].map((worker) => worker.pgid)
    // An abandoned group was never observed empty, so the campaign cannot claim
    // a clean drain — it can only report which groups it had to abandon.
    const abandoned = [...this.abandoned.values()]
    return {
      drained: survivors.length === 0 && abandoned.length === 0,
      survivors: [...survivors, ...abandoned.map((group) => group.pgid)],
      abandoned,
    }
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

/**
 * The worker's process tree, for a watchdog kill.
 *
 * The one hang this watchdog has caught was diagnosed by hand, and the two
 * facts that did it were not in any log: the worker sat at 100% CPU inside
 * `kevent64` — spinning in its event loop, not blocked on IO — while holding
 * ONE `<defunct>` child. That is a worker awaiting a subprocess that has
 * already exited, which narrows ~150 candidate files to the ones that spawn.
 *
 * Printing it costs one `ps` at the moment of death and saves that hour.
 */
export const describeProcessGroup = (
  pgid: number,
  snapshot: ProcessSnapshot = defaultProcessObserver().snapshot(),
): string => {
  if (snapshot.kind === "unavailable") return `  <ps unavailable: ${snapshot.reason}>`
  const rows = rowsInGroup(snapshot.rows, pgid)
  return rows.length === 0
    ? "  <no members>"
    : rows.map((row) => `  ${renderProcessRow(row)}`).join("\n")
}
