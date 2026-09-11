/**
 * `tools/dev/bounded-child` — the ONE bounded way this repository starts a
 * child process (TVH-07).
 *
 * # What it replaces
 *
 * ```ts
 * const proc = Bun.spawn(["bun", "test", ...args], { stdout: "pipe", stderr: "pipe" })
 * const [out, err] = await Promise.all([
 *   new Response(proc.stdout).text(),
 *   new Response(proc.stderr).text(),
 * ])
 * const exitCode = await proc.exited
 * ```
 *
 * …and its synchronous twin, `Bun.spawnSync(["sh", "-c", command])` with no
 * `timeout`, which is how every top-level gate, the worktree-pollution guard
 * and the unit-speed-budget confirmation currently run.
 *
 * Four defects, all reachable from one wedged child. MEASURED against that
 * exact primitive on darwin 24.6, with fixtures that fork a grandchild and
 * record both pids:
 *
 *  1. **No total deadline.** A child that wedges wedges the caller forever —
 *     measured: `returned=false` after 8,043ms, and it would not have returned.
 *  2. **No inactivity deadline.** A child that prints one byte a minute never
 *     trips a total deadline generous enough to be useful.
 *  3. **No process group.** `Bun.spawn` puts the child in OUR group, so there
 *     is nothing to kill but the direct child — measured: 2 of 2 recorded
 *     descendants still RUNNING after the call was abandoned, in both the hung
 *     and the infinite-output case, and removed only by a manual SIGKILL of
 *     each pid. `bun test` and the gates spawn language servers, shells and
 *     browsers; those orphans hold ports and working directories, and the NEXT
 *     run blames the flake on them.
 *  4. **Unbounded memory.** `new Response(stream).text()` buffers everything.
 *     MEASURED: the driver's RSS reached 1,936 MB in 8 seconds against a child
 *     doing nothing but `echo` in a loop. OOM in the diagnosis tool reads as
 *     "the suite is broken".
 *
 * The same fixtures under this module: `stop=inactivity-deadline` in 3,285ms
 * and `stop=total-deadline` in 4,249ms, both inside their declared budgets,
 * `kill=emptied`, 0 of 2 descendants surviving, retained output capped at
 * exactly the byte cap, driver RSS 38 MB and 49 MB.
 *
 * # Why the drain is concurrent and capped, not sequential
 *
 * `Promise.all` above LOOKS concurrent, and is — but only because both sides
 * are `.text()` over the whole stream. The moment a cap is introduced the naive
 * shape becomes "read stdout until cap, then read stderr", and a child that
 * fills the stderr pipe BLOCKS IN `write(2)` while we wait on stdout. That is a
 * deadlock indistinguishable from a hang. So both streams are drained by
 * independent handlers that keep consuming after the cap and simply stop
 * appending.
 *
 * # Why the deadline does not wait for `exit`
 *
 * A group that refuses to empty — a child ignoring signals, an EPERM, a
 * container with a frozen cgroup — means the `exit` event NEVER fires. Awaiting
 * it unconditionally makes the declared deadline a lie; MEASURED as a 60s test
 * timeout on the paired control in
 * `tests/unit/tools/test-resilience-bounded-child-hellgate.test.ts`, where the
 * only change is that the group signal is a no-op. So the call races `exit`
 * against the completion of its own kill sequence and reports the child as
 * unexited (`exitCode: null`, `survivors > 0`) rather than waiting on a process
 * it has already given up on.
 *
 * # Why the drain loop is here and not imported
 *
 * `tools/dev/test-shard-lifecycle.killProcessTreeOutcome` implements the same
 * TERM→KILL sequence and this module deliberately shares its RESULT vocabulary
 * (`KillTreeOutcome`) and its observation adapter (`tools/dev/process-observer`,
 * the repo's single bounded `ps`, with its 50ms→3s backoff). What it does not
 * do is delegate the LOOP. A primitive that every top-level gate runs through
 * cannot make its own liveness depend on a poll loop it does not own: during
 * this work a neighbouring lane had an uncommitted one-character mutation in
 * that loop's deadline test (`remaining <= -1e12`), which turns it into an
 * unbounded spin — and a caller with a 120s declared deadline inherited an
 * infinite hang. The bound a module DECLARES, it must ENFORCE.
 */

import { spawn } from "node:child_process"
import {
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  defaultProcessObserver,
  nextPollDelay,
  type ProcessObserver,
  pollSchedule,
  rowsInGroup,
} from "./process-observer"
import {
  type KillTreeOutcome,
  probeGroupFromSnapshot,
  processGroupAlive,
} from "./test-shard-lifecycle"

export interface BoundedChildLimits {
  /** Hard wall bound on the child's RUN, before the kill sequence starts. */
  readonly totalMs: number
  /** Kill if neither stream produced a byte for this long. */
  readonly inactivityMs: number
  /** Per-stream retained bytes. Draining continues past this; appending stops. */
  readonly maxStreamBytes: number
  /** SIGTERM → SIGKILL grace. */
  readonly termGraceMs: number
  /** How long to wait for the GROUP to empty after SIGKILL. */
  readonly killGraceMs: number
  /** Deadline-detection interval. */
  readonly watchdogPollMs: number
  /** Largest interval the kill-drain backoff is allowed to reach. */
  readonly maxPollMs: number
}

export const DEFAULT_CHILD_LIMITS: BoundedChildLimits = {
  totalMs: 120_000,
  inactivityMs: 30_000,
  maxStreamBytes: 4 * 1024 * 1024,
  termGraceMs: 2_000,
  killGraceMs: 5_000,
  watchdogPollMs: 100,
  maxPollMs: 250,
}

/**
 * The DECLARED ceiling on the whole call, derived from the limits rather than
 * chosen.
 *
 * `totalMs` is the child's run. After it, in the worst case: one watchdog tick
 * to notice, then two drain stages, each of which can overshoot its own
 * deadline by at most one poll delay plus one bounded `ps` (the poll checks the
 * deadline at the top of the loop, so the last observation always straddles
 * it). Nothing here is a fudge factor — remove a term and there is a real
 * execution that exceeds the result.
 */
export const deadlineBudgetMs = (limits: BoundedChildLimits): number =>
  limits.totalMs +
  limits.watchdogPollMs +
  limits.termGraceMs +
  limits.killGraceMs +
  2 * (limits.maxPollMs + DEFAULT_SNAPSHOT_TIMEOUT_MS)

/**
 * How the call ended.
 *
 * `passed` and `failed` are the child's own verdict; `timed-out` and
 * `cancelled` are OURS and say the child never got to give one. Collapsing them
 * — which `{ output, exitCode }` forced — is how "we killed it for being slow"
 * and "it failed" become the same fact.
 */
export type BoundedChildStatus = "passed" | "failed" | "timed-out" | "cancelled" | "spawn-error"

/** Which bound fired, for a `timed-out`. A silent child and a slow one are
 *  different diagnoses and the caller usually needs to know which. */
export type BoundedChildDeadline = "total" | "inactivity"

export interface BoundedChildOutcome {
  readonly status: BoundedChildStatus
  readonly deadline: BoundedChildDeadline | undefined
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  /** True when either stream produced more than its cap. */
  readonly truncated: boolean
  readonly elapsedMs: number
  /** The ceiling this call declared before it started. */
  readonly deadlineBudgetMs: number
  /** Typed group-kill result, or `undefined` when no kill was needed. */
  readonly kill: KillTreeOutcome | undefined
  /**
   * Non-zombie descendants still in the child's process group. `undefined`
   * means the process table could not be read — never assume 0.
   */
  readonly survivors: number | undefined
  readonly spawnError?: string
}

export interface BoundedChildRequest {
  /** argv form. Exactly one of `cmd` / `shell`. */
  readonly cmd?: readonly string[]
  /**
   * Shell form: the string is handed to `sh -c` UNPARSED.
   *
   * This is not a convenience. `tools/dev/gate.ts` stores each gate as a
   * command STRING, several of which carry a `--` pass-through whose quoting
   * only the shell resolves correctly; re-tokenising it here would silently
   * change what the gate runs. A caller that has a string keeps a string.
   */
  readonly shell?: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly limits?: Partial<BoundedChildLimits>
  /** External cancellation — reported as `cancelled`, never as `timed-out`. */
  readonly signal?: AbortSignal
  readonly observer?: ProcessObserver
  /** Seam for the lifecycle tests; defaults to `process.kill`. */
  readonly signalGroup?: (pgid: number, signal: NodeJS.Signals) => void
  /** Seam for the lifecycle tests; defaults to `processGroupAlive`. */
  readonly groupAlive?: (pgid: number) => boolean
  /**
   * Live pass-through, in addition to retention.
   *
   * `gate.ts` inherits stdio today so an operator watches a 45-minute campaign
   * as it runs; piping without forwarding would trade that for the bounds.
   * These get every chunk, uncapped, while the retained copy stays capped for
   * the failure replay.
   */
  readonly onStdout?: (text: string) => void
  readonly onStderr?: (text: string) => void
}

interface StreamDrain {
  readonly text: () => string
  readonly truncated: () => boolean
}

/**
 * Consume a stream to its end, retaining at most `cap` bytes.
 *
 * The `data` handler always runs — dropping the listener at the cap would let
 * the pipe fill and block the child in `write(2)`, the deadlock this module
 * exists to avoid. `onByte` feeds the inactivity clock, so a child producing
 * output it will never be allowed to keep still counts as alive.
 */
const drainStream = (
  stream: NodeJS.ReadableStream | null,
  cap: number,
  onByte: () => void,
  forward?: (text: string) => void,
): StreamDrain => {
  const chunks: string[] = []
  let retained = 0
  let total = 0
  stream?.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
    total += text.length
    onByte()
    // Forwarded UNCAPPED and unbuffered: the cap bounds what this process
    // RETAINS for a failure replay, not what an operator is allowed to watch.
    // Capping the live view too would make a long gate look hung.
    forward?.(text)
    if (retained >= cap) return
    const room = cap - retained
    chunks.push(text.length <= room ? text : text.slice(0, room))
    retained += Math.min(room, text.length)
  })
  return { text: () => chunks.join(""), truncated: () => total > retained }
}

/** Non-zombie members of `pgid`. A zombie holds no fd, port or cwd, so it is
 *  not a survivor — waiting on one is waiting forever. */
export const countGroupSurvivors = (
  observer: ProcessObserver,
  pgid: number,
): number | undefined => {
  const snapshot = observer.snapshot()
  if (snapshot.kind !== "ok") return undefined
  return rowsInGroup(snapshot.rows, pgid).filter((row) => !row.stat.startsWith("Z")).length
}

export interface ReapResult {
  readonly kill: KillTreeOutcome | undefined
  readonly survivors: number | undefined
}

interface ReaperContext {
  readonly limits: BoundedChildLimits
  readonly observer: ProcessObserver
  readonly groupAlive: (pgid: number) => boolean
  readonly signalGroup: (pgid: number, signal: NodeJS.Signals) => void
}

const defaultSignalGroup = (pgid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pgid, signal)
  } catch {
    // The whole group is already gone; nothing to signal.
  }
}

/**
 * Poll until the group holds nothing, or the deadline passes.
 *
 * Two bounds, both owned here: the wall deadline AND the observation budget
 * (50ms→3s geometric, capped by `maxPollMs`). The cheap `kill(-pgid, 0)`
 * syscall gates every table read, so a group the kernel has already forgotten —
 * the overwhelmingly common case — costs ZERO `ps` spawns.
 */
const waitForEmptyGroup = async (
  pgid: number,
  deadline: number,
  context: ReaperContext,
): Promise<KillTreeOutcome> => {
  const schedule = pollSchedule({ maxMs: context.limits.maxPollMs })
  for (let attempt = 0; ; attempt += 1) {
    if (!context.groupAlive(pgid)) return { kind: "emptied" }
    const probe = probeGroupFromSnapshot(context.observer.snapshot(), pgid)
    if (probe.kind === "empty") return { kind: "emptied" }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return probe.kind === "unobservable"
        ? { kind: "unobservable", reason: probe.reason, detail: probe.detail }
        : { kind: "survived" }
    }
    await Bun.sleep(Math.max(1, Math.min(nextPollDelay(attempt, schedule), remaining)))
  }
}

/**
 * Kill the group and count what is left.
 *
 * Ordering matters: the cheap syscall gates BOTH the kill and the survivor
 * count, so the normal case (child exited, group empty) spawns no `ps` at all.
 */
export const reapGroup = async (pgid: number, context: ReaperContext): Promise<ReapResult> => {
  if (!context.groupAlive(pgid)) return { kill: undefined, survivors: 0 }
  context.signalGroup(pgid, "SIGTERM")
  const afterTerm = await waitForEmptyGroup(pgid, Date.now() + context.limits.termGraceMs, context)
  if (afterTerm.kind === "emptied") return { kill: afterTerm, survivors: 0 }
  context.signalGroup(pgid, "SIGKILL")
  const afterKill = await waitForEmptyGroup(pgid, Date.now() + context.limits.killGraceMs, context)
  if (afterKill.kind === "emptied" || !context.groupAlive(pgid)) {
    return { kill: afterKill, survivors: 0 }
  }
  return { kill: afterKill, survivors: countGroupSurvivors(context.observer, pgid) }
}

const argvOf = (request: BoundedChildRequest): readonly string[] => {
  if (request.shell !== undefined && request.cmd !== undefined) {
    throw new Error("[bounded-child] pass exactly one of `cmd` and `shell`")
  }
  if (request.shell !== undefined) return ["sh", "-c", request.shell]
  if (request.cmd !== undefined && request.cmd.length > 0) return request.cmd
  throw new Error("[bounded-child] empty child command")
}

const statusOf = (
  deadline: BoundedChildDeadline | undefined,
  cancelled: boolean,
  exitCode: number | null,
): BoundedChildStatus => {
  if (cancelled) return "cancelled"
  if (deadline !== undefined) return "timed-out"
  return exitCode === 0 ? "passed" : "failed"
}

const spawnErrorOutcome = (
  error: unknown,
  elapsedMs: number,
  budget: number,
): BoundedChildOutcome => ({
  status: "spawn-error",
  deadline: undefined,
  exitCode: null,
  signal: null,
  stdout: "",
  stderr: "",
  truncated: false,
  elapsedMs,
  deadlineBudgetMs: budget,
  kill: undefined,
  survivors: 0,
  spawnError: error instanceof Error ? error.message : String(error),
})

interface DeadlineWatcher {
  /** Resolves once the kill sequence STARTED BY A DEADLINE has finished. */
  readonly settled: Promise<ReapResult>
  readonly deadline: () => BoundedChildDeadline | undefined
  readonly cancelled: () => boolean
  readonly stop: () => void
}

/**
 * The two ways this call ends without the child agreeing: a deadline we
 * declared, and a cancellation the caller asked for.
 *
 * Both start the SAME kill sequence and resolve the SAME promise, so the main
 * body races one thing instead of three — and neither can fire twice.
 */
const startDeadlineWatcher = (input: {
  readonly pgid: number | undefined
  readonly context: ReaperContext
  readonly startedAt: number
  readonly lastByteAt: () => number
  readonly signal: AbortSignal | undefined
}): DeadlineWatcher => {
  const { limits } = input.context
  const settled = Promise.withResolvers<ReapResult>()
  let deadline: BoundedChildDeadline | undefined
  let cancelled = false
  const startReap = (): void => {
    if (input.pgid === undefined) {
      settled.resolve({ kill: undefined, survivors: 0 })
      return
    }
    reapGroup(input.pgid, input.context).then(settled.resolve, () =>
      settled.resolve({ kill: undefined, survivors: undefined }),
    )
  }
  const onAbort = (): void => {
    if (deadline !== undefined || cancelled) return
    cancelled = true
    startReap()
  }
  const watchdog = setInterval(() => {
    if (deadline !== undefined || cancelled) return
    const now = Date.now()
    const hitTotal = now - input.startedAt >= limits.totalMs
    if (!hitTotal && now - input.lastByteAt() < limits.inactivityMs) return
    deadline = hitTotal ? "total" : "inactivity"
    startReap()
  }, limits.watchdogPollMs)
  input.signal?.addEventListener("abort", onAbort, { once: true })
  if (input.signal?.aborted === true) onAbort()
  return {
    settled: settled.promise,
    deadline: () => deadline,
    cancelled: () => cancelled,
    stop: () => {
      clearInterval(watchdog)
      input.signal?.removeEventListener("abort", onAbort)
    },
  }
}

interface ChildSettlement {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly spawnError: string | undefined
  readonly reaped: ReapResult | undefined
}

/**
 * Wait for the child OR for our own kill sequence, whichever lands first.
 *
 * This race is the module's liveness guarantee. A group that refuses to empty
 * means `exit` never fires, so awaiting it alone would make the declared
 * deadline a lie (measured: a 60s test timeout on the no-op-signal control).
 */
const raceExitAgainstReap = async (
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  watcher: DeadlineWatcher,
): Promise<ChildSettlement> => {
  try {
    const first = await Promise.race([
      exited.then((result) => ({ kind: "exit" as const, result })),
      watcher.settled.then((reap) => ({ kind: "reaped" as const, reap })),
    ])
    return first.kind === "exit"
      ? {
          exitCode: first.result.code,
          signal: first.result.signal,
          spawnError: undefined,
          reaped: undefined,
        }
      : { exitCode: null, signal: null, spawnError: undefined, reaped: first.reap }
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      spawnError: error instanceof Error ? error.message : String(error),
      reaped: undefined,
    }
  } finally {
    watcher.stop()
  }
}

export const runBoundedChild = async (
  request: BoundedChildRequest,
): Promise<BoundedChildOutcome> => {
  const limits = { ...DEFAULT_CHILD_LIMITS, ...request.limits }
  const budget = deadlineBudgetMs(limits)
  const observer = request.observer ?? defaultProcessObserver()
  const context: ReaperContext = {
    limits,
    observer,
    groupAlive: request.groupAlive ?? processGroupAlive,
    signalGroup: request.signalGroup ?? defaultSignalGroup,
  }
  const startedAt = Date.now()
  const [command, ...args] = argvOf(request)
  if (command === undefined) throw new Error("[bounded-child] empty child command")

  let child: ReturnType<typeof spawn>
  try {
    child = spawn(command, args, {
      cwd: request.cwd,
      env: request.env as NodeJS.ProcessEnv,
      // Own process group: ONE kill(-pgid) reaches every descendant, and the
      // survivor count below becomes a question the kernel can answer.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    return spawnErrorOutcome(error, Date.now() - startedAt, budget)
  }

  let lastByteAt = Date.now()
  const bump = (): void => {
    lastByteAt = Date.now()
  }
  const out = drainStream(child.stdout, limits.maxStreamBytes, bump, request.onStdout)
  const err = drainStream(child.stderr, limits.maxStreamBytes, bump, request.onStderr)

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve({ code, signal }))
    },
  )

  const pgid = child.pid
  const watcher = startDeadlineWatcher({
    pgid,
    context,
    startedAt,
    lastByteAt: () => lastByteAt,
    signal: request.signal,
  })

  const settled = await raceExitAgainstReap(exited, watcher)
  const { exitCode, signal, spawnError, reaped } = settled
  const deadline = watcher.deadline()
  const cancelled = watcher.cancelled()

  // Even a child that exited on its own may have left descendants in the group
  // (a detached language server, a shell's background job). Sweep either way —
  // the cheap syscall makes the clean case free.
  const final: ReapResult =
    reaped ??
    (pgid === undefined ? { kill: undefined, survivors: 0 } : await reapGroup(pgid, context))

  return {
    status:
      spawnError === undefined ? statusOf(deadline, cancelled, exitCode) : ("spawn-error" as const),
    deadline,
    exitCode,
    signal,
    stdout: out.text(),
    stderr: err.text(),
    truncated: out.truncated() || err.truncated(),
    elapsedMs: Date.now() - startedAt,
    deadlineBudgetMs: budget,
    kill: final.kill,
    survivors: final.survivors,
    ...(spawnError === undefined ? {} : { spawnError }),
  }
}
