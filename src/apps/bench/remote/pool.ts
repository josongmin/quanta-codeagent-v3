/**
 * Persistent full-remote box pool (jun-20 box-lifecycle plan, Phase 2).
 *
 * The old sweep paid the FULL bootstrap tax (boot + cloud-init + rsync + bun
 * install + phantom deps + swebench/uvx warm + pyright) on EVERY wave because each
 * wave spun a fresh box via {@link createFullRemoteBackend}. This pool provisions
 * ONE box (or a small fixed number of workers) via {@link provisionBox} and feeds
 * it a QUEUE of chunks through {@link gradeChunkOnBox} — bootstrap once, grade
 * many. The binding limit is the shared OAuth login rate, not box count, so a
 * single box with high per-box patch-gen concurrency is the right shape.
 *
 * Invariants this module owns:
 *   - bootstrap runs ONCE per worker box, not once per chunk;
 *   - each chunk re-injects a FRESH stripped token (a long-lived run never grades
 *     on a stale access_token) and writes to a runId-SCOPED box dir, so chunks
 *     never collide on the shared `~/report.json` / `~/instances.jsonl`;
 *   - a chunk whose box DIED (spot reclaim / ssh-255) is RE-QUEUED on a fresh box
 *     (bounded), never silently lost;
 *   - the box is ALWAYS terminated when its worker drains (even on error).
 *
 * Everything routes through the injected SpawnFn (via {@link provisionBox} /
 * {@link gradeChunkOnBox}), so the whole pool is unit-testable offline.
 */
import { errMessage } from "@/shared"
import {
  attachBox,
  type BoxSession,
  type ChunkPaths,
  countLiveBoxes,
  type FullRemoteConfig,
  type FullRemoteResult,
  findIdleBox,
  gradeChunkOnBox,
  POOL_BUSY_ERROR,
  provisionBox,
} from "./box-session"
import type { PoolAuthLease, PoolAuthProvider } from "./pool-auth"
import { acquirePatchGenBudgetLease, clampPatchGenConcurrency } from "./token-budget"

/** One unit of work for the pool: a runId-tagged dataset slice. */
export interface PoolChunk {
  /** Unique per chunk — names the runId-scoped box dir AND the local artifacts
   *  (`report-<runId>.json`). MUST be filesystem-safe (no spaces / slashes). */
  readonly runId: string
  /** Local dataset jsonl for THIS chunk (scp'd up per chunk). */
  readonly datasetPath: string
  /** Subset filter (default: all rows in the chunk dataset). */
  readonly instanceIds?: readonly string[]
}

export interface PoolConfig {
  /** Box provisioning config (region/key/ami/ttl/onDemand/spawn/onLog/…). The
   *  per-chunk dataset/instanceIds come from each {@link PoolChunk}, NOT here. */
  readonly provision: FullRemoteConfig
  /** Number of worker boxes. 1–2 by default — more boxes just multiply the 429
   *  burst (shared OAuth) and the bootstrap tax. Clamped to ≥1. */
  readonly workers: number
  /** Fail-closed guard: `workers > 1` must be an EXPLICIT caller opt-in. */
  readonly allowExtraWorkers?: boolean
  /** Fail-closed guard across PROCESSES too: if another quanta-bench box is
   *  already running, callers must opt in before launching a fresh one. */
  readonly allowExtraBoxes?: boolean
  /** When extra boxes are DISABLED, wait for an existing running box to become
   *  idle (or disappear) instead of failing fast. Useful for chaining waves onto
   *  the warm-box lifecycle without manual retry loops. */
  readonly waitForIdle?: boolean
  /** Poll cadence for {@link waitForIdle}. Default 15s. */
  readonly waitForIdlePollMs?: number
  /** Max wait before failing the idle wait. Default 45min. 0/negative = no timeout. */
  readonly waitForIdleTimeoutMs?: number
  readonly preset: string
  readonly model: string
  /** Per-box patch-gen concurrency forwarded to `bench run`. */
  readonly concurrency: number
  /** Re-read the RAW chatgpt.json fresh PER CHUNK so a long run never ships a
   *  stale access_token. Called once per chunk attempt. Used in SINGLE-auth mode
   *  (no pool); the legacy behavior is byte-identical. */
  readonly authJsonProvider: () => string
  /** jun-20 multi-auth (T-3): when present, EACH chunk acquires a per-account
   *  lease here BEFORE its box launch/reuse, ships that account's token, and
   *  releases the lease with the chunk outcome. Per-account cooldown then OWNS
   *  429 backoff (the worker-level {@link backoffBaseMs} lane is skipped), so one
   *  account's throttle never stalls another. Absent ⇒ single-auth path unchanged. */
  readonly authProvider?: PoolAuthProvider
  /** Forwarded `QUANTA_BENCH_*` env prefix (built once via buildForwardedBenchEnv). */
  readonly forwardedBenchEnv?: string
  readonly recordTrajectory?: boolean
  /** Max RE-QUEUE attempts for a chunk whose box died (spot reclaim / ssh-255).
   *  Default 2. A chunk that still has no verdict after this is surfaced in its
   *  result with `lost: true`. */
  readonly maxChunkRetries?: number
  /** PROACTIVE box rotation: terminate + reprovision a worker box once it has
   *  lived this long, BEFORE starting the next chunk. The box self-terminates at
   *  its EC2 TTL (`shutdown -h +<ttlMinutes>`, default 180min); a chunk that
   *  starts just under the TTL would be killed mid-grade and wasted (then
   *  requeued on a fresh box anyway). Rotating a bit BEFORE the TTL avoids that
   *  wasted partial chunk. Default 150min (under the 180min TTL). The rotation is
   *  NOT a chunk failure — it does not consume a retry. */
  readonly maxBoxWallMs?: number
  /** Injectable clock (test seam — default Date.now). */
  readonly now?: () => number
  /** Injectable sleep (test seam — default real setTimeout). Used for 429 backoff. */
  readonly sleep?: (ms: number) => Promise<void>
  /** Base backoff after a chunk that hit the shared-OAuth rate limit
   *  (generation_error / 429). Doubles per CONSECUTIVE rate-limited chunk, capped
   *  at {@link backoffMaxMs}; resets on a clean chunk. Default 90s (matches the
   *  sweep's WAVE_BACKOFF). 0 disables backoff. */
  readonly backoffBaseMs?: number
  /** Cap for the exponential 429 backoff. Default 30min. */
  readonly backoffMaxMs?: number
  /** REUSE a running, bootstrapped, idle quanta-bench box (skip bootstrap) when
   *  one exists; default true. The box is a SPOT instance, so reuse is best-effort
   *  — a reclaimed box just isn't found and a fresh one is launched. Set false to
   *  always launch a dedicated box. */
  readonly reuseWarm?: boolean
  /** Leave the worker's box ALIVE after the queue drains (warm for the next run;
   *  it self-terminates at its EC2 TTL or on spot reclaim). Default true. Dead /
   *  rotated boxes are still terminated regardless. Set false to terminate on
   *  clean drain. */
  readonly keepWarm?: boolean
  /** Override the cross-process patch-gen budget lease dir (test seam). */
  readonly tokenBudgetDir?: string
  /** Max wait for the global patch-gen budget lease. */
  readonly tokenBudgetWaitMs?: number
  /** Poll cadence while waiting for the global patch-gen budget lease. */
  readonly tokenBudgetPollMs?: number
  readonly onLog?: (m: string) => void
}

export interface PoolChunkResult {
  readonly chunk: PoolChunk
  readonly result: FullRemoteResult
  /** Box-attempts spent on this chunk (1 = no requeue). */
  readonly attempts: number
  /** True when the chunk never earned ANY verdict across all attempts — a genuine
   *  loss the operator must see (NOT silently counted as resolved=0). */
  readonly lost: boolean
}

const assertUniqueChunkRunIds = (chunks: readonly PoolChunk[]): void => {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const chunk of chunks) {
    if (seen.has(chunk.runId)) dup.add(chunk.runId)
    seen.add(chunk.runId)
  }
  if (dup.size > 0) {
    throw new Error(
      `[pool] duplicate chunk runId(s): ${[...dup].sort().join(", ")} — every chunk must have a unique runId`,
    )
  }
}

const sleepReal = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms))

interface PoolLaunchWindowRuntime {
  readonly waitForIdle: boolean
  readonly log: (message: string) => void
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly pollMs: number
  readonly deadline: number
}

const createPoolLaunchWindowRuntime = (cfg: PoolConfig): PoolLaunchWindowRuntime => ({
  waitForIdle: cfg.waitForIdle === true,
  log: cfg.onLog ?? (() => {}),
  now: cfg.now ?? (() => Date.now()),
  sleep: cfg.sleep ?? sleepReal,
  pollMs: Math.max(1_000, cfg.waitForIdlePollMs ?? 15_000),
  deadline:
    (cfg.waitForIdleTimeoutMs ?? 45 * 60 * 1000) > 0
      ? (cfg.now ?? (() => Date.now()))() + (cfg.waitForIdleTimeoutMs ?? 45 * 60 * 1000)
      : Number.POSITIVE_INFINITY,
})

const poolLaunchWindowTimedOut = (runtime: PoolLaunchWindowRuntime): boolean =>
  runtime.now() >= runtime.deadline

const waitForReusableBoxProbe = async (
  runtime: PoolLaunchWindowRuntime,
  err: unknown,
): Promise<void> => {
  if (!runtime.waitForIdle) throw err
  if (poolLaunchWindowTimedOut(runtime)) {
    throw new Error(
      `[pool] timed out waiting for a reusable box while status probes kept failing: ${errMessage(err)}`,
    )
  }
  runtime.log(
    `[pool] waiting for a reusable box: status probe failed (${errMessage(err)}) — retrying…`,
  )
  await runtime.sleep(runtime.pollMs)
}

const handlePoolLaunchRunningBoxes = async (
  running: number,
  runtime: PoolLaunchWindowRuntime,
  announcedWait: { value: boolean },
): Promise<boolean> => {
  if (running <= 0) return true
  if (!runtime.waitForIdle) {
    throw new Error(
      `[pool] refusing to launch another box while ${running} quanta-bench box(es) are already live (running/pending). ` +
        "Wait for the existing box to go idle, or opt in explicitly.",
    )
  }
  if (poolLaunchWindowTimedOut(runtime)) {
    throw new Error(
      `[pool] timed out waiting for ${running} live quanta-bench box(es) to go idle. ` +
        "Use explicit extra-box opt-in to launch past them.",
    )
  }
  if (!announcedWait.value) {
    runtime.log(
      `[pool] waiting for ${running} live quanta-bench box(es) to go idle before launching another box…`,
    )
    announcedWait.value = true
  }
  await runtime.sleep(runtime.pollMs)
  return false
}

const awaitPoolLaunchWindow = async (cfg: PoolConfig): Promise<void> => {
  if (cfg.allowExtraBoxes === true) return
  const runtime = createPoolLaunchWindowRuntime(cfg)
  const announcedWait = { value: false }

  for (;;) {
    const idle = await findIdleBox(cfg.provision).catch(() => undefined)
    if (idle !== undefined) return

    let running: number
    try {
      running = await countLiveBoxes(cfg.provision)
    } catch (err) {
      await waitForReusableBoxProbe(runtime, err)
      continue
    }

    if (await handlePoolLaunchRunningBoxes(running, runtime, announcedWait)) return
  }
}

/** runId-scoped box paths so concurrent/sequential chunks on one box never
 *  collide on the shared fixed paths. `trajectory` uses `$HOME` (not `~`) because
 *  it is interpolated inside double quotes in the record env (see box-session.ts). */
export const chunkBoxPaths = (runId: string): ChunkPaths => ({
  dataset: `~/runs/${runId}/instances.jsonl`,
  preds: `~/runs/${runId}/preds.jsonl`,
  report: `~/runs/${runId}/report.json`,
  runLog: `~/runs/${runId}/run.log`,
  observeDir: `~/runs/${runId}/observe`,
  trajectory: `$HOME/runs/${runId}/trajectory.jsonl`,
})

/** Did this chunk's grade produce ANY verdict? An all-empty result means the box
 *  died (or produced no report) — the chunk should be re-queued. */
const earnedVerdict = (r: FullRemoteResult): boolean =>
  (r.resolved?.length ?? 0) +
    (r.unresolved?.length ?? 0) +
    (r.errored?.length ?? 0) +
    (r.emptyPatch?.length ?? 0) >
  0

/** A simple shared queue. Workers pull until empty; a re-queued (box-died) chunk
 *  goes back to the FRONT so it retries promptly on the next provisioned box. */
class ChunkQueue {
  private readonly items: PoolChunk[]
  constructor(chunks: readonly PoolChunk[]) {
    this.items = [...chunks]
  }
  next(): PoolChunk | undefined {
    return this.items.shift()
  }
  requeueFront(chunk: PoolChunk): void {
    this.items.unshift(chunk)
  }
  get size(): number {
    return this.items.length
  }
}

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

interface WorkerRuntime {
  readonly log: (message: string) => void
  readonly maxRetries: number
  readonly now: () => number
  readonly maxBoxWallMs: number
  readonly reuseWarm: boolean
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

const createWorkerRuntime = (cfg: PoolConfig): WorkerRuntime => ({
  log: cfg.onLog ?? (() => {}),
  maxRetries: Math.max(0, cfg.maxChunkRetries ?? 2),
  now: cfg.now ?? (() => Date.now()),
  maxBoxWallMs: Math.max(0, cfg.maxBoxWallMs ?? 150 * 60 * 1000),
  reuseWarm: cfg.reuseWarm ?? true,
  keepWarm: cfg.keepWarm ?? true,
  sleep: cfg.sleep ?? sleepReal,
  backoffBaseMs: Math.max(0, cfg.backoffBaseMs ?? 90_000),
  backoffMaxMs: Math.max(0, cfg.backoffMaxMs ?? 30 * 60 * 1000),
})

const nextChunkAttempt = (attemptsByRun: Map<string, number>, chunk: PoolChunk): number => {
  const attempt = (attemptsByRun.get(chunk.runId) ?? 0) + 1
  attemptsByRun.set(chunk.runId, attempt)
  return attempt
}

const loseChunk = (
  out: Map<string, PoolChunkResult>,
  chunk: PoolChunk,
  attempt: number,
  result: FullRemoteResult = {},
): void => {
  out.set(chunk.runId, { chunk, result, attempts: attempt, lost: true })
}

const requeueOrLoseChunk = (
  queue: ChunkQueue,
  out: Map<string, PoolChunkResult>,
  chunk: PoolChunk,
  attempt: number,
  maxRetries: number,
  result: FullRemoteResult = {},
): void => {
  if (attempt <= maxRetries) {
    queue.requeueFront(chunk)
    return
  }
  loseChunk(out, chunk, attempt, result)
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

const terminateWorkerSessionQuietly = async (state: WorkerState): Promise<void> => {
  await clearWorkerSession(state)
    ?.terminate()
    .catch(() => undefined)
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
  await terminateWorkerSessionQuietly(state)
}

const provisionWorkerSession = async (
  workerId: number,
  cfg: PoolConfig,
  runtime: WorkerRuntime,
  state: WorkerState,
): Promise<BoxSession> => {
  if (runtime.reuseWarm) {
    const idle = await findIdleBox(cfg.provision).catch(() => undefined)
    if (idle !== undefined) {
      const session = await attachBox(cfg.provision, idle)
      state.boxProvisionedAt = runtime.now()
      runtime.log(`[pool] worker ${workerId}: reusing warm box ${session.iid}`)
      return session
    }
  }
  runtime.log(`[pool] worker ${workerId}: provisioning box…`)
  const session = await provisionBox({
    ...cfg.provision,
    launchMode: cfg.provision.launchMode ?? "pool",
  })
  state.boxProvisionedAt = runtime.now()
  runtime.log(`[pool] worker ${workerId}: box ${session.iid} ready`)
  return session
}

const ensureWorkerSession = async (
  workerId: number,
  queue: ChunkQueue,
  chunk: PoolChunk,
  attempt: number,
  cfg: PoolConfig,
  runtime: WorkerRuntime,
  state: WorkerState,
  out: Map<string, PoolChunkResult>,
): Promise<boolean> => {
  if (state.session !== undefined) return true
  try {
    state.session = await provisionWorkerSession(workerId, cfg, runtime, state)
    return true
  } catch (err) {
    runtime.log(`[pool] worker ${workerId}: provision failed: ${errMessage(err)}`)
    requeueOrLoseChunk(queue, out, chunk, attempt, runtime.maxRetries)
    return false
  }
}

const recordSuccessfulChunk = (
  out: Map<string, PoolChunkResult>,
  chunk: PoolChunk,
  result: FullRemoteResult,
  attempt: number,
): void => {
  out.set(chunk.runId, { chunk, result, attempts: attempt, lost: false })
}

const handleNoVerdictChunk = async (
  workerId: number,
  queue: ChunkQueue,
  chunk: PoolChunk,
  attempt: number,
  runtime: WorkerRuntime,
  state: WorkerState,
  out: Map<string, PoolChunkResult>,
  result: FullRemoteResult,
): Promise<void> => {
  if (attempt > runtime.maxRetries) {
    loseChunk(out, chunk, attempt, result)
    return
  }
  runtime.log(
    `[pool] worker ${workerId}: chunk ${chunk.runId} produced no verdict (box died?) — requeue (attempt ${attempt}/${runtime.maxRetries + 1})`,
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
): void => {
  runtime.log(
    `[pool] worker ${workerId}: chunk ${chunk.runId} — box busy (another run); requeue on a fresh box`,
  )
  clearWorkerSession(state)
  requeueOrLoseChunk(queue, out, chunk, attempt, runtime.maxRetries)
}

const handleDeadBoxChunkError = async (
  workerId: number,
  queue: ChunkQueue,
  chunk: PoolChunk,
  attempt: number,
  runtime: WorkerRuntime,
  state: WorkerState,
  out: Map<string, PoolChunkResult>,
  err: unknown,
): Promise<void> => {
  runtime.log(`[pool] worker ${workerId}: chunk ${chunk.runId} threw: ${errMessage(err)}`)
  await terminateWorkerSessionQuietly(state)
  requeueOrLoseChunk(queue, out, chunk, attempt, runtime.maxRetries)
}

/** Outcome of one chunk grade attempt — drives the per-account auth lease
 *  release (rateLimited ⇒ cool the account; lostBox ⇒ requeue; completed ⇒ done). */
interface ChunkOutcome {
  readonly rateLimited: boolean
  readonly completed: boolean
  readonly lostBox: boolean
}

const OUTCOME_LOST: ChunkOutcome = { rateLimited: false, completed: false, lostBox: true }

const gradeChunkAttempt = async (
  workerId: number,
  queue: ChunkQueue,
  chunk: PoolChunk,
  attempt: number,
  cfg: PoolConfig,
  runtime: WorkerRuntime,
  state: WorkerState,
  out: Map<string, PoolChunkResult>,
  authJson: string,
): Promise<ChunkOutcome> => {
  const session = state.session
  if (session === undefined) {
    throw new Error(`[pool] worker ${workerId}: missing box session before grading ${chunk.runId}`)
  }
  const paths = chunkBoxPaths(chunk.runId)
  let lease: Awaited<ReturnType<typeof acquirePatchGenBudgetLease>> | undefined
  try {
    lease = await acquireChunkBudgetLease(workerId, chunk, cfg, runtime.log)
    const chunkConcurrency = clampPatchGenConcurrency(lease.units)
    logGrantedChunkBudgetLease({
      workerId,
      chunk,
      effectiveConcurrency: chunkConcurrency,
      lease,
      onLog: runtime.log,
    })
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
    })
    if (earnedVerdict(result)) {
      recordSuccessfulChunk(out, chunk, result, attempt)
      return { rateLimited: result.rateLimited === true, completed: true, lostBox: false }
    }
    await handleNoVerdictChunk(workerId, queue, chunk, attempt, runtime, state, out, result)
    return { rateLimited: result.rateLimited === true, completed: false, lostBox: true }
  } catch (err) {
    if (errMessage(err).includes(POOL_BUSY_ERROR)) {
      handlePoolBusyChunkError(workerId, queue, chunk, attempt, runtime, state, out)
    } else {
      await handleDeadBoxChunkError(workerId, queue, chunk, attempt, runtime, state, out, err)
    }
    return OUTCOME_LOST
  } finally {
    if (lease !== undefined) {
      await lease.release().catch(() => undefined)
      runtime.log(
        `[pool] worker ${workerId}: released patch-gen budget lease for ${chunk.runId} (${lease.units} token(s))`,
      )
    }
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
    await terminateWorkerSessionQuietly(state)
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
        : Math.max(1, runtime.backoffBaseMs > 0 ? runtime.backoffBaseMs : 5_000)
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
const runWorker = async (
  workerId: number,
  queue: ChunkQueue,
  cfg: PoolConfig,
  attemptsByRun: Map<string, number>,
  out: Map<string, PoolChunkResult>,
): Promise<void> => {
  const runtime = createWorkerRuntime(cfg)
  const state: WorkerState = {
    session: undefined,
    boxProvisionedAt: 0,
    consecRateLimited: 0,
    boxAccountLabel: undefined,
  }
  const multiAuth = cfg.authProvider !== undefined

  try {
    for (let chunk = queue.next(); chunk !== undefined; chunk = queue.next()) {
      const attempt = nextChunkAttempt(attemptsByRun, chunk)
      await maybeRotateWorkerSession(workerId, runtime, state)

      // Acquire the per-account lease BEFORE provisioning/reusing a box, so a
      // chunk never launches a box it then can't credential. Single-auth mode
      // skips this entirely and ships the legacy provider (byte-identical).
      let authLease: PoolAuthLease | undefined
      let authJson: string
      if (multiAuth) {
        const lease = await acquireAuthLeaseWithWait(workerId, chunk, cfg, runtime, state)
        if (lease === null) {
          runtime.log(
            `[pool] worker ${workerId}: no enabled account for chunk ${chunk.runId} — marking lost`,
          )
          loseChunk(out, chunk, attempt)
          continue
        }
        authLease = lease
        state.boxAccountLabel = lease.accountLabel
        authJson = lease.readAuthJson()
        runtime.log(`[pool] worker ${workerId}: chunk ${chunk.runId} leased account ${lease.accountLabel}`)
      } else {
        authJson = cfg.authJsonProvider()
      }

      try {
        if (!(await ensureWorkerSession(workerId, queue, chunk, attempt, cfg, runtime, state, out))) {
          authLease?.release({ rateLimited: false, lostBox: true, completed: false })
          authLease = undefined
          continue
        }
        const outcome = await gradeChunkAttempt(
          workerId,
          queue,
          chunk,
          attempt,
          cfg,
          runtime,
          state,
          out,
          authJson,
        )
        if (multiAuth) {
          authLease?.release({
            rateLimited: outcome.rateLimited,
            lostBox: outcome.lostBox,
            completed: outcome.completed,
          })
          authLease = undefined
        } else {
          await maybeBackoffWorker(workerId, queue, runtime, state, outcome.rateLimited)
        }
      } finally {
        // Safety net: any unexpected throw must still return the account's slots
        // (release is idempotent, so a prior explicit release is a no-op).
        authLease?.release({ rateLimited: false, lostBox: true, completed: false })
      }
    }
  } finally {
    await finalizeWorkerSession(workerId, runtime, state)
  }
}

/**
 * Run all `chunks` through a persistent pool of `cfg.workers` boxes. Returns one
 * {@link PoolChunkResult} per chunk (keyed back to its runId), preserving the
 * input order. Bootstrap is paid ONCE per worker box, not per chunk.
 */
export const runPool = async (
  chunks: readonly PoolChunk[],
  cfg: PoolConfig,
): Promise<PoolChunkResult[]> => {
  assertUniqueChunkRunIds(chunks)
  const workers = Math.max(1, Math.trunc(cfg.workers) || 1)
  if (workers > 1 && cfg.allowExtraWorkers !== true) {
    throw new Error(
      `[pool] refusing workers=${workers} without explicit opt-in (allowExtraWorkers=true)`,
    )
  }
  if (workers > 1 && cfg.allowExtraBoxes !== true) {
    throw new Error(
      `[pool] refusing workers=${workers} without explicit extra-box opt-in ` +
        "(allowExtraBoxes=true): parallel workers can launch parallel boxes",
    )
  }
  await awaitPoolLaunchWindow(cfg)
  const queue = new ChunkQueue(chunks)
  const attemptsByRun = new Map<string, number>()
  const out = new Map<string, PoolChunkResult>()

  await Promise.all(
    Array.from({ length: workers }, (_unused, i) => runWorker(i + 1, queue, cfg, attemptsByRun, out)),
  )

  // Preserve input order; a chunk with no recorded result (should not happen —
  // every path records one) is surfaced as lost rather than dropped.
  return chunks.map(
    (chunk) =>
      out.get(chunk.runId) ?? {
        chunk,
        result: {},
        attempts: attemptsByRun.get(chunk.runId) ?? 0,
        lost: true,
      },
  )
}
