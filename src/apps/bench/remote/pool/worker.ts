/**
 * Worker loop for the persistent full-remote box pool: provision/reuse a box,
 * drain chunks from the shared queue, grade each (re-injecting a fresh token,
 * routing dead-box/busy/rate-limit outcomes), and rotate/terminate the box as
 * its wall-time / keepWarm policy dictates. Split out of pool.ts so the
 * orchestrator (runPool) stays thin; everything here is pool-internal.
 */
import { errMessage } from "@/shared"
import {
  attachBox,
  BOX_DIED_DURING_RUN_ERROR,
  type BoxSession,
  type FullRemoteResult,
  findIdleBox,
  GRADE_LOCK_RELEASE_ERROR,
  gradeChunkOnBox,
  POOL_BUSY_ERROR,
  provisionBox,
} from "../box-session"
import type { PoolAuthLease } from "../pool-auth"
import { acquirePatchGenBudgetLease, clampPatchGenConcurrency } from "../token-budget"
import {
  accumulateChunkCoverage,
  accumulatedCoverageComplete,
  accumulatedMissingInstances,
  type ChunkCoverageAccumulator,
  chunkBoxPaths,
  chunkCoverageAccumulatorFor,
  chunkCoverageResult,
  earnedVerdict,
} from "./coverage"
import { awaitFreshLaunchWindow, awaitPoolLaunchWindow } from "./launch-window"
import { type PoolChunk, type PoolChunkResult, type PoolConfig, sleepReal } from "./types"

/** A simple shared queue. Workers pull until empty; a re-queued (box-died) chunk
 *  goes back to the FRONT so it retries promptly on the next provisioned box. */
export class ChunkQueue {
  private readonly items: PoolChunk[]
  private aborted = false
  constructor(chunks: readonly PoolChunk[]) {
    this.items = [...chunks]
  }
  next(): PoolChunk | undefined {
    if (this.aborted) return undefined
    return this.items.shift()
  }
  requeueFront(chunk: PoolChunk): void {
    if (this.aborted) return
    this.items.unshift(chunk)
  }
  abort(): void {
    this.aborted = true
  }
  get size(): number {
    return this.items.length
  }
}

// Fallback poll-wait when every account is cooling and no explicit backoff base
// is configured (backoffBaseMs <= 0) — keeps the worker from busy-spinning.
const DEFAULT_BACKOFF_WAIT_MS = 5_000

const acquireChunkBudgetLease = async (
  workerId: number,
  chunk: PoolChunk,
  cfg: PoolConfig,
  onLog: (message: string) => void,
): Promise<Awaited<ReturnType<typeof acquirePatchGenBudgetLease>>> =>
  acquirePatchGenBudgetLease({
    label: `pool:${chunk.runId}:worker${workerId}`,
    requestedUnits: clampPatchGenConcurrency(cfg.concurrency),
    ...(cfg.tokenBudgetDir !== undefined ? { dir: cfg.tokenBudgetDir } : {}),
    ...(cfg.tokenBudgetWaitMs !== undefined ? { waitMs: cfg.tokenBudgetWaitMs } : {}),
    ...(cfg.tokenBudgetPollMs !== undefined ? { pollMs: cfg.tokenBudgetPollMs } : {}),
    onLog,
  })

const logGrantedChunkBudgetLease = (args: {
  readonly workerId: number
  readonly chunk: PoolChunk
  readonly effectiveConcurrency: number
  readonly lease: Awaited<ReturnType<typeof acquirePatchGenBudgetLease>>
  readonly onLog: (message: string) => void
}): void => {
  args.onLog(
    `[pool] worker ${args.workerId}: chunk ${args.chunk.runId} granted ${args.lease.units}/${args.lease.requestedUnits} global patch-gen token(s); box concurrency=${args.effectiveConcurrency} (in-use now <= ${args.lease.limit})`,
  )
}

interface GrantedChunkBudgetLease {
  readonly lease: Awaited<ReturnType<typeof acquirePatchGenBudgetLease>>
  readonly concurrency: number
}

const acquireGrantedChunkBudgetLease = async (
  workerId: number,
  chunk: PoolChunk,
  cfg: PoolConfig,
  onLog: (message: string) => void,
): Promise<GrantedChunkBudgetLease> => {
  const lease = await acquireChunkBudgetLease(workerId, chunk, cfg, onLog)
  const concurrency = clampPatchGenConcurrency(lease.units)
  logGrantedChunkBudgetLease({
    workerId,
    chunk,
    effectiveConcurrency: concurrency,
    lease,
    onLog,
  })
  return { lease, concurrency }
}

const releaseGrantedChunkBudgetLease = async (
  workerId: number,
  chunk: PoolChunk,
  runtime: WorkerRuntime,
  grant: GrantedChunkBudgetLease,
): Promise<void> => {
  await grant.lease.release()
  runtime.log(
    `[pool] worker ${workerId}: released patch-gen budget lease for ${chunk.runId} (${grant.lease.units} token(s))`,
  )
}

interface WorkerRuntime {
  readonly log: (message: string) => void
  readonly maxRetries: number
  readonly now: () => number
  readonly maxBoxWallMs: number
  readonly reuseWarm: boolean
  readonly allowExtraBoxes: boolean
  readonly keepWarm: boolean
  readonly sleep: (ms: number) => Promise<void>
  readonly backoffBaseMs: number
  readonly backoffMaxMs: number
}

interface WorkerState {
  session: BoxSession | undefined
  boxProvisionedAt: number
  consecRateLimited: number
  /** jun-20 multi-auth: which account this worker's box currently holds, so the
   *  next chunk can PREFER reusing the same account (soft affinity, not a pin). */
  boxAccountLabel: string | undefined
}

interface WorkerChunkAuthState {
  authLease: PoolAuthLease | undefined
  leasedAccountLabel: string | undefined
  authJson: string | undefined
}

const createWorkerRuntime = (cfg: PoolConfig): WorkerRuntime => ({
  log: cfg.onLog ?? (() => {}),
  maxRetries: Math.max(0, cfg.maxChunkRetries ?? 2),
  now: cfg.now ?? (() => Date.now()),
  maxBoxWallMs: Math.max(0, cfg.maxBoxWallMs ?? 150 * 60 * 1000),
  reuseWarm: cfg.reuseWarm ?? true,
  allowExtraBoxes: cfg.allowExtraBoxes === true,
  keepWarm: cfg.keepWarm ?? true,
  sleep: cfg.sleep ?? sleepReal,
  backoffBaseMs: Math.max(0, cfg.backoffBaseMs ?? 90_000),
  backoffMaxMs: Math.max(0, cfg.backoffMaxMs ?? 30 * 60 * 1000),
})

const acquireWorkerChunkAuth = async (
  workerId: number,
  chunk: PoolChunk,
  cfg: PoolConfig,
  runtime: WorkerRuntime,
  state: WorkerState,
): Promise<WorkerChunkAuthState> => {
  const provider = cfg.authProvider
  if (provider === undefined) {
    return {
      authLease: undefined,
      leasedAccountLabel: undefined,
      authJson: cfg.authJsonProvider(),
    }
  }
  const lease = await acquireAuthLeaseWithWait(workerId, chunk, cfg, runtime, state)
  if (lease === null) {
    throw new Error(
      `[pool] worker ${workerId}: aborting run because the auth pool has no enabled account for chunk ${chunk.runId}`,
    )
  }
  return {
    authLease: lease,
    leasedAccountLabel: lease.accountLabel,
    authJson: undefined,
  }
}

const readWorkerChunkAuthJson = (
  workerId: number,
  chunk: PoolChunk,
  runtime: WorkerRuntime,
  auth: WorkerChunkAuthState,
): string => {
  if (auth.authLease === undefined) {
    if (auth.authJson === undefined) {
      throw new Error(
        `[pool] worker ${workerId}: missing auth payload before grading ${chunk.runId}`,
      )
    }
    return auth.authJson
  }
  const authJson = auth.authLease.readAuthJson()
  runtime.log(
    `[pool] worker ${workerId}: chunk ${chunk.runId} leased account ${auth.authLease.accountLabel}`,
  )
  return authJson
}

const releaseWorkerChunkAuthAsLost = (auth: WorkerChunkAuthState): void => {
  auth.authLease?.release({ rateLimited: false, lostBox: true, completed: false })
  auth.authLease = undefined
}

const releaseWorkerChunkAuthOutcome = (auth: WorkerChunkAuthState, outcome: ChunkOutcome): void => {
  auth.authLease?.release({
    rateLimited: outcome.rateLimited,
    lostBox: outcome.lostBox,
    completed: outcome.completed,
  })
  auth.authLease = undefined
}

const acquireWorkerChunkBudgetGrant = async (
  workerId: number,
  chunk: PoolChunk,
  cfg: PoolConfig,
  runtime: WorkerRuntime,
): Promise<GrantedChunkBudgetLease> => {
  try {
    return await acquireGrantedChunkBudgetLease(workerId, chunk, cfg, runtime.log)
  } catch (err) {
    return handleChunkBudgetWaitError(workerId, chunk, runtime, err)
  }
}

const nextChunkAttempt = (attemptsByRun: Map<string, number>, chunk: PoolChunk): number => {
  const attempt = (attemptsByRun.get(chunk.runId) ?? 0) + 1
  attemptsByRun.set(chunk.runId, attempt)
  return attempt
}

const loseChunk = (
  out: Map<string, PoolChunkResult>,
  chunk: PoolChunk,
  attempt: number,
  coverageByRun: Map<string, ChunkCoverageAccumulator>,
  result: FullRemoteResult = {},
): void => {
  const acc = coverageByRun.get(chunk.runId)
  const aggregated = acc === undefined ? result : chunkCoverageResult(acc)
  const missing = acc === undefined ? [] : accumulatedMissingInstances(acc, chunk)
  const partial = earnedVerdict(aggregated) && missing.length > 0
  out.set(chunk.runId, {
    chunk,
    result: aggregated,
    attempts: attempt,
    lost: !partial,
    ...(partial ? { missing } : {}),
  })
  coverageByRun.delete(chunk.runId)
}

const requeueOrLoseChunk = (
  queue: ChunkQueue,
  out: Map<string, PoolChunkResult>,
  chunk: PoolChunk,
  attempt: number,
  maxRetries: number,
  coverageByRun: Map<string, ChunkCoverageAccumulator>,
  result: FullRemoteResult = {},
): void => {
  if (attempt <= maxRetries) {
    queue.requeueFront(chunk)
    return
  }
  loseChunk(out, chunk, attempt, coverageByRun, result)
}

const clearWorkerSession = (state: WorkerState): BoxSession | undefined => {
  const session = state.session
  state.session = undefined
  state.boxAccountLabel = undefined // box gone ⇒ no same-account affinity to keep
  return session
}

const terminateWorkerSession = async (state: WorkerState): Promise<void> => {
  await clearWorkerSession(state)?.terminate()
}

const maybeRotateWorkerSession = async (
  workerId: number,
  runtime: WorkerRuntime,
  state: WorkerState,
): Promise<void> => {
  if (state.session === undefined || runtime.maxBoxWallMs <= 0) return
  if (runtime.now() - state.boxProvisionedAt < runtime.maxBoxWallMs) return
  runtime.log(
    `[pool] worker ${workerId}: box ${state.session.iid} reached wall-time budget (${Math.round(runtime.maxBoxWallMs / 60000)}min) — rotating before TTL kills a chunk…`,
  )
  await terminateWorkerSession(state)
}

const provisionWorkerSession = async (
  workerId: number,
  cfg: PoolConfig,
  runtime: WorkerRuntime,
  state: WorkerState,
): Promise<BoxSession> => {
  const workerProvision = {
    ...cfg.provision,
    preset: cfg.preset,
    model: cfg.model,
  }
  if (runtime.reuseWarm) {
    const idle = await findIdleBox(workerProvision).catch(() => undefined)
    if (idle !== undefined) {
      const session = await attachBox(workerProvision, idle)
      state.boxProvisionedAt = runtime.now()
      runtime.log(`[pool] worker ${workerId}: reusing warm box ${session.iid}`)
      return session
    }
    const reusable = await awaitPoolLaunchWindow(cfg)
    if (reusable !== undefined) {
      const session = await attachBox(workerProvision, reusable)
      state.boxProvisionedAt = runtime.now()
      runtime.log(`[pool] worker ${workerId}: reusing warm box ${session.iid}`)
      return session
    }
  } else {
    await awaitFreshLaunchWindow(cfg)
  }
  runtime.log(`[pool] worker ${workerId}: provisioning box…`)
  const session = await provisionBox({
    ...workerProvision,
    launchMode: cfg.provision.launchMode ?? "pool",
  })
  state.boxProvisionedAt = runtime.now()
  runtime.log(`[pool] worker ${workerId}: box ${session.iid} ready`)
  return session
}

const ensureWorkerSession = async (
  workerId: number,
  _queue: ChunkQueue,
  chunk: PoolChunk,
  _attempt: number,
  cfg: PoolConfig,
  runtime: WorkerRuntime,
  state: WorkerState,
  _out: Map<string, PoolChunkResult>,
): Promise<boolean> => {
  if (state.session !== undefined) return true
  try {
    state.session = await provisionWorkerSession(workerId, cfg, runtime, state)
    return true
  } catch (err) {
    const msg = errMessage(err)
    runtime.log(`[pool] worker ${workerId}: provision failed: ${msg}`)
    throw new Error(
      `[pool] worker ${workerId}: aborting run because box provisioning failed before chunk ${chunk.runId}: ${msg}`,
    )
  }
}

const recordSuccessfulChunk = (
  out: Map<string, PoolChunkResult>,
  chunk: PoolChunk,
  result: FullRemoteResult,
  attempt: number,
  coverageByRun: Map<string, ChunkCoverageAccumulator>,
): void => {
  out.set(chunk.runId, { chunk, result, attempts: attempt, lost: false })
  coverageByRun.delete(chunk.runId)
}

const handleIncompleteChunk = async (
  workerId: number,
  queue: ChunkQueue,
  chunk: PoolChunk,
  attempt: number,
  runtime: WorkerRuntime,
  state: WorkerState,
  out: Map<string, PoolChunkResult>,
  coverageByRun: Map<string, ChunkCoverageAccumulator>,
  _result: FullRemoteResult,
): Promise<void> => {
  const acc = chunkCoverageAccumulatorFor(coverageByRun, chunk.runId)
  const aggregated = chunkCoverageResult(acc)
  const missing = accumulatedMissingInstances(acc, chunk)
  const partial = earnedVerdict(aggregated) && missing.length > 0
  if (attempt > runtime.maxRetries) {
    loseChunk(out, chunk, attempt, coverageByRun, aggregated)
    return
  }
  runtime.log(
    partial
      ? `[pool] worker ${workerId}: chunk ${chunk.runId} graded a strict subset (${missing.length} missing: ${missing.join(", ")}) — requeue to recover the rest (attempt ${attempt}/${runtime.maxRetries + 1})`
      : `[pool] worker ${workerId}: chunk ${chunk.runId} produced no verdict (box died?) — requeue (attempt ${attempt}/${runtime.maxRetries + 1})`,
  )
  await terminateWorkerSession(state)
  queue.requeueFront(chunk)
}

const handlePoolBusyChunkError = (
  workerId: number,
  queue: ChunkQueue,
  chunk: PoolChunk,
  attempt: number,
  runtime: WorkerRuntime,
  state: WorkerState,
  out: Map<string, PoolChunkResult>,
  coverageByRun: Map<string, ChunkCoverageAccumulator>,
): void => {
  clearWorkerSession(state)
  if (!runtime.reuseWarm && !runtime.allowExtraBoxes) {
    runtime.log(
      `[pool] worker ${workerId}: chunk ${chunk.runId} — box busy (another run); fresh launch is forbidden without explicit extra-box opt-in`,
    )
    throw new Error(
      `[pool] refusing to launch a fresh box after ${POOL_BUSY_ERROR} on chunk ${chunk.runId}; ` +
        "the current box is already owned by another run. Wait for it to go idle, or opt in explicitly.",
    )
  }
  runtime.log(
    `[pool] worker ${workerId}: chunk ${chunk.runId} — box busy (another run); requeue on a fresh box`,
  )
  requeueOrLoseChunk(queue, out, chunk, attempt, runtime.maxRetries, coverageByRun)
}

const handleDeadBoxChunkError = async (
  workerId: number,
  queue: ChunkQueue,
  chunk: PoolChunk,
  attempt: number,
  runtime: WorkerRuntime,
  state: WorkerState,
  out: Map<string, PoolChunkResult>,
  coverageByRun: Map<string, ChunkCoverageAccumulator>,
  err: unknown,
): Promise<void> => {
  runtime.log(`[pool] worker ${workerId}: chunk ${chunk.runId} threw: ${errMessage(err)}`)
  try {
    await terminateWorkerSession(state)
  } catch (cleanupErr) {
    throw new Error(
      `[pool] worker ${workerId}: failed to terminate box after chunk ${chunk.runId} threw ${errMessage(err)}: ${errMessage(cleanupErr)}`,
    )
  }
  requeueOrLoseChunk(queue, out, chunk, attempt, runtime.maxRetries, coverageByRun)
}

const handleChunkBudgetWaitError = (
  workerId: number,
  chunk: PoolChunk,
  runtime: WorkerRuntime,
  err: unknown,
): never => {
  const msg = errMessage(err)
  runtime.log(
    `[pool] worker ${workerId}: chunk ${chunk.runId} could not acquire patch-gen budget: ${msg}`,
  )
  throw new Error(
    `[pool] worker ${workerId}: aborting run because chunk ${chunk.runId} could not acquire patch-gen budget: ${msg}`,
  )
}

const gradeWorkerChunk = async (args: {
  readonly workerId: number
  readonly queue: ChunkQueue
  readonly chunk: PoolChunk
  readonly attempt: number
  readonly cfg: PoolConfig
  readonly runtime: WorkerRuntime
  readonly state: WorkerState
  readonly out: Map<string, PoolChunkResult>
  readonly coverageByRun: Map<string, ChunkCoverageAccumulator>
  readonly auth: WorkerChunkAuthState
  readonly budgetGrant: GrantedChunkBudgetLease
  readonly multiAuth: boolean
}): Promise<ChunkOutcome | undefined> => {
  if (
    !(await ensureWorkerSession(
      args.workerId,
      args.queue,
      args.chunk,
      args.attempt,
      args.cfg,
      args.runtime,
      args.state,
      args.out,
    ))
  ) {
    releaseWorkerChunkAuthAsLost(args.auth)
    return undefined
  }
  const authJson = readWorkerChunkAuthJson(args.workerId, args.chunk, args.runtime, args.auth)
  if (args.auth.leasedAccountLabel !== undefined) {
    args.state.boxAccountLabel = args.auth.leasedAccountLabel
  }
  const outcome = await gradeChunkAttempt(
    args.workerId,
    args.queue,
    args.chunk,
    args.attempt,
    args.cfg,
    args.runtime,
    args.state,
    args.out,
    args.coverageByRun,
    authJson,
    args.budgetGrant.concurrency,
    args.auth.leasedAccountLabel,
  )
  if (args.multiAuth) releaseWorkerChunkAuthOutcome(args.auth, outcome)
  return outcome
}

const processWorkerChunk = async (args: {
  readonly workerId: number
  readonly queue: ChunkQueue
  readonly chunk: PoolChunk
  readonly attempt: number
  readonly cfg: PoolConfig
  readonly runtime: WorkerRuntime
  readonly state: WorkerState
  readonly out: Map<string, PoolChunkResult>
  readonly coverageByRun: Map<string, ChunkCoverageAccumulator>
  readonly multiAuth: boolean
}): Promise<void> => {
  const auth = await acquireWorkerChunkAuth(
    args.workerId,
    args.chunk,
    args.cfg,
    args.runtime,
    args.state,
  )
  try {
    const budgetGrant = await acquireWorkerChunkBudgetGrant(
      args.workerId,
      args.chunk,
      args.cfg,
      args.runtime,
    )
    let outcome: ChunkOutcome | undefined
    let primaryErr: unknown
    let budgetCleanupErr: unknown
    try {
      outcome = await gradeWorkerChunk({ ...args, auth, budgetGrant })
    } catch (err) {
      primaryErr = err
    }
    try {
      await releaseGrantedChunkBudgetLease(args.workerId, args.chunk, args.runtime, budgetGrant)
    } catch (cleanupErr) {
      budgetCleanupErr = cleanupErr
    }
    if (budgetCleanupErr !== undefined) {
      if (primaryErr !== undefined) {
        throw new Error(
          `[pool] worker ${args.workerId}: chunk ${args.chunk.runId} budget cleanup failed after primary=${errMessage(primaryErr)}; cleanup=${errMessage(budgetCleanupErr)}`,
        )
      }
      throw budgetCleanupErr
    }
    if (primaryErr !== undefined) throw primaryErr
    if (!args.multiAuth && outcome !== undefined) {
      await maybeBackoffWorker(
        args.workerId,
        args.queue,
        args.runtime,
        args.state,
        outcome.rateLimited,
      )
    }
  } finally {
    // Safety net: any unexpected throw must still return the account's slots
    // (release is idempotent, so a prior explicit release is a no-op).
    releaseWorkerChunkAuthAsLost(auth)
  }
}

const finalizeWorkerRun = async (
  workerId: number,
  runtime: WorkerRuntime,
  state: WorkerState,
  primaryErr: unknown,
): Promise<void> => {
  let cleanupErr: unknown
  try {
    await finalizeWorkerSession(workerId, runtime, state)
  } catch (err) {
    cleanupErr = err
  }

  if (cleanupErr !== undefined) {
    if (primaryErr !== undefined) {
      throw new Error(
        `[pool] worker ${workerId}: final cleanup failed after primary=${errMessage(primaryErr)}; cleanup=${errMessage(cleanupErr)}`,
      )
    }
    throw cleanupErr
  }
  if (primaryErr !== undefined) throw primaryErr
}

export const mergeWorkerRunErrors = (
  errors: ReadonlyArray<{ workerId: number; error: unknown }>,
): unknown => {
  if (errors.length === 0) return undefined
  if (errors.length === 1) return errors[0]?.error
  return new Error(
    `[pool] multiple workers failed: ${errors
      .map(({ workerId, error }) => `worker ${workerId}=${errMessage(error)}`)
      .join("; ")}`,
  )
}

/** Outcome of one chunk grade attempt — drives the per-account auth lease
 *  release (rateLimited ⇒ cool the account; lostBox ⇒ requeue; completed ⇒ done). */
interface ChunkOutcome {
  readonly rateLimited: boolean
  readonly completed: boolean
  readonly lostBox: boolean
}

const OUTCOME_LOST: ChunkOutcome = { rateLimited: false, completed: false, lostBox: true }

/**
 * Route a chunk-grade exception to its requeue/abort handler by inspecting the
 * stamped error markers. ORDER MATTERS: a genuine box death (BUG 1) also fails
 * its grade-lock release, so the {@link BOX_DIED_DURING_RUN_ERROR} substring
 * must be matched BEFORE {@link GRADE_LOCK_RELEASE_ERROR} or a real box death
 * would mis-route to the lock-rethrow branch. A bare grade-lock failure (no box
 * death) is unrecoverable and rethrown; anything else is treated as a dead box.
 */
const routeChunkGradeError = async (
  err: unknown,
  workerId: number,
  queue: ChunkQueue,
  chunk: PoolChunk,
  attempt: number,
  runtime: WorkerRuntime,
  state: WorkerState,
  out: Map<string, PoolChunkResult>,
  coverageByRun: Map<string, ChunkCoverageAccumulator>,
): Promise<void> => {
  const msg = errMessage(err)
  if (msg.includes(POOL_BUSY_ERROR)) {
    handlePoolBusyChunkError(workerId, queue, chunk, attempt, runtime, state, out, coverageByRun)
    return
  }
  if (msg.includes(BOX_DIED_DURING_RUN_ERROR)) {
    // BUG 1: the detached poll loop confirmed the box DIED mid-run (spot reclaim
    // / wall-clock ceiling). Route to the dead-box requeue path FIRST — even
    // though a dead box also fails its grade-lock release (the secondary
    // GRADE_LOCK_RELEASE_FAILED gets wrapped in), that lock-release substring
    // must NOT mis-route a genuine box death to the rethrow branch below.
    await handleDeadBoxChunkError(
      workerId,
      queue,
      chunk,
      attempt,
      runtime,
      state,
      out,
      coverageByRun,
      err,
    )
    return
  }
  if (msg.includes(GRADE_LOCK_RELEASE_ERROR)) {
    throw err
  }
  await handleDeadBoxChunkError(
    workerId,
    queue,
    chunk,
    attempt,
    runtime,
    state,
    out,
    coverageByRun,
    err,
  )
}

const gradeChunkAttempt = async (
  workerId: number,
  queue: ChunkQueue,
  chunk: PoolChunk,
  attempt: number,
  cfg: PoolConfig,
  runtime: WorkerRuntime,
  state: WorkerState,
  out: Map<string, PoolChunkResult>,
  coverageByRun: Map<string, ChunkCoverageAccumulator>,
  authJson: string,
  chunkConcurrency: number,
  accountLabel: string | undefined,
): Promise<ChunkOutcome> => {
  const session = state.session
  if (session === undefined) {
    throw new Error(`[pool] worker ${workerId}: missing box session before grading ${chunk.runId}`)
  }
  const paths = chunkBoxPaths(chunk.runId)
  try {
    await session.ssh(`mkdir -p ${paths.observeDir}`)
    const result = await gradeChunkOnBox(session, {
      datasetPath: chunk.datasetPath,
      authJson, // FRESH token per chunk (single provider OR leased account)
      ...(chunk.instanceIds !== undefined ? { instanceIds: chunk.instanceIds } : {}),
      preset: cfg.preset,
      model: cfg.model,
      concurrency: chunkConcurrency,
      paths,
      artifactSuffix: chunk.runId,
      recordTrajectory: cfg.recordTrajectory ?? false,
      forwardedBenchEnv: cfg.forwardedBenchEnv ?? "",
      // jun-20 multi-auth (T-6): surface the leased account in the box status snapshot.
      ...(accountLabel !== undefined ? { accountLabel } : {}),
      // BUG 1 test seams: forward the box-side injectable sleep/clock into the
      // detached run+poll loop so a test can drive the box-death bound offline
      // (default real setTimeout / Date.now in production — byte-identical).
      ...(cfg.provision.sleep !== undefined ? { pollSleep: cfg.provision.sleep } : {}),
      ...(cfg.now !== undefined ? { pollNow: cfg.now } : {}),
    })
    // #2: "completed" requires covering EVERY requested instance, not merely
    // earning ≥1 verdict. A strict-subset grade (box died after N of M) flows to
    // the incomplete handler, which requeues to recover the rest and — on attempt
    // exhaustion — surfaces the gap as `missing` instead of silently dropping it.
    const acc = chunkCoverageAccumulatorFor(coverageByRun, chunk.runId)
    accumulateChunkCoverage(acc, result)
    if (accumulatedCoverageComplete(acc, chunk)) {
      recordSuccessfulChunk(out, chunk, chunkCoverageResult(acc), attempt, coverageByRun)
      return { rateLimited: result.rateLimited === true, completed: true, lostBox: false }
    }
    await handleIncompleteChunk(
      workerId,
      queue,
      chunk,
      attempt,
      runtime,
      state,
      out,
      coverageByRun,
      result,
    )
    return { rateLimited: result.rateLimited === true, completed: false, lostBox: true }
  } catch (err) {
    await routeChunkGradeError(
      err,
      workerId,
      queue,
      chunk,
      attempt,
      runtime,
      state,
      out,
      coverageByRun,
    )
    return OUTCOME_LOST
  }
}

const maybeBackoffWorker = async (
  workerId: number,
  queue: ChunkQueue,
  runtime: WorkerRuntime,
  state: WorkerState,
  chunkRateLimited: boolean,
): Promise<void> => {
  if (!chunkRateLimited) {
    state.consecRateLimited = 0
    return
  }
  if (runtime.backoffBaseMs <= 0 || queue.size <= 0) return
  state.consecRateLimited += 1
  const backoff = Math.min(
    runtime.backoffMaxMs,
    runtime.backoffBaseMs * 2 ** (state.consecRateLimited - 1),
  )
  runtime.log(
    `[pool] worker ${workerId}: rate-limited (#${state.consecRateLimited} consecutive) — backing off ${Math.round(backoff / 1000)}s before next chunk`,
  )
  await runtime.sleep(backoff)
}

const finalizeWorkerSession = async (
  workerId: number,
  runtime: WorkerRuntime,
  state: WorkerState,
): Promise<void> => {
  if (!runtime.keepWarm) {
    runtime.log(`[pool] worker ${workerId}: terminating box (keepWarm=false)`)
    await terminateWorkerSession(state)
    return
  }
  if (state.session !== undefined) {
    runtime.log(
      `[pool] worker ${workerId}: leaving box ${state.session.iid} WARM for reuse (TTL reaps it)`,
    )
  }
}

/**
 * jun-20 multi-auth: block until an account can take this chunk. Returns the
 * lease, or null ONLY when every account is disabled (the chunk can never run).
 * A merely-cooling/saturated pool waits (sized by `nextReadyAt`, else the 429
 * backoff base) and retries — this IS the per-account backoff, replacing the
 * worker-level global lane.
 */
const acquireAuthLeaseWithWait = async (
  workerId: number,
  chunk: PoolChunk,
  cfg: PoolConfig,
  runtime: WorkerRuntime,
  state: WorkerState,
): Promise<PoolAuthLease | null> => {
  const provider = cfg.authProvider
  if (provider === undefined) return null
  const requestedSlots = clampPatchGenConcurrency(cfg.concurrency)
  for (;;) {
    const lease = provider.acquire({
      runId: chunk.runId,
      requestedSlots,
      ...(state.boxAccountLabel !== undefined
        ? { preferredAccountLabel: state.boxAccountLabel }
        : {}),
    })
    if (lease !== null) return lease
    if (!provider.canEventuallySchedule()) return null
    const readyAt = provider.nextReadyAt()
    const waitMs =
      readyAt !== undefined
        ? Math.max(1, readyAt - runtime.now())
        : Math.max(1, runtime.backoffBaseMs > 0 ? runtime.backoffBaseMs : DEFAULT_BACKOFF_WAIT_MS)
    runtime.log(
      `[pool] worker ${workerId}: all accounts busy/cooling — waiting ${Math.round(waitMs / 1000)}s for ${chunk.runId}`,
    )
    await runtime.sleep(waitMs)
  }
}

/**
 * Run one worker: provision a box, drain chunks from the shared queue, terminate
 * when done. Each chunk that dies mid-grade is re-queued (bounded by
 * `maxChunkRetries`) and the worker provisions a FRESH box to continue. Results
 * accumulate into `out` keyed by runId.
 */
export const runWorker = async (
  workerId: number,
  queue: ChunkQueue,
  cfg: PoolConfig,
  attemptsByRun: Map<string, number>,
  out: Map<string, PoolChunkResult>,
  coverageByRun: Map<string, ChunkCoverageAccumulator>,
): Promise<void> => {
  const runtime = createWorkerRuntime(cfg)
  const state: WorkerState = {
    session: undefined,
    boxProvisionedAt: 0,
    consecRateLimited: 0,
    boxAccountLabel: undefined,
  }
  const multiAuth = cfg.authProvider !== undefined
  let primaryErr: unknown

  try {
    for (let chunk = queue.next(); chunk !== undefined; chunk = queue.next()) {
      const attempt = nextChunkAttempt(attemptsByRun, chunk)
      await maybeRotateWorkerSession(workerId, runtime, state)
      await processWorkerChunk({
        workerId,
        queue,
        chunk,
        attempt,
        cfg,
        runtime,
        state,
        out,
        coverageByRun,
        multiAuth,
      })
    }
  } catch (err) {
    primaryErr = err
    queue.abort()
  }
  await finalizeWorkerRun(workerId, runtime, state, primaryErr)
}
