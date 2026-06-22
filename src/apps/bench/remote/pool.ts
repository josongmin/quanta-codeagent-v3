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
  assertRemoteDatasetLaunchable,
  assertRemoteDatasetSelectionExists,
  assertRemoteStrictGroundingSupported,
  assertSafeArtifactSuffix,
  attachBox,
  BOX_DIED_DURING_RUN_ERROR,
  type BoxSession,
  type ChunkPaths,
  countLiveBoxes,
  type FullRemoteConfig,
  type FullRemoteResult,
  findIdleBox,
  GRADE_LOCK_RELEASE_ERROR,
  gradeChunkOnBox,
  POOL_BUSY_ERROR,
  provisionBox,
} from "./box-session"
import type { PoolAuthLease, PoolAuthProvider } from "./pool-auth"
import { acquireSingleBoxGuard, type SingleBoxGuard } from "./single-box-guard"
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
  /** Override the local single-box owner guard dir (test seam). */
  readonly singleBoxGuardDir?: string
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

export const assertUniqueChunkRunIds = (chunks: readonly PoolChunk[]): void => {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const chunk of chunks) {
    // Defense-in-depth at the EARLIEST boundary (chunk-list construction): a
    // runId flows unquoted into remote ssh paths (`mkdir -p ~/runs/<runId>/...`
    // at the pool's pre-grade sink, BEFORE gradeChunkOnBox's own guard). Validate
    // the charset here so a traversal/injection suffix can never reach any box
    // command. Redundant-but-belt-and-suspenders with the gradeChunkOnBox guard.
    assertSafeArtifactSuffix(chunk.runId)
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

const awaitPoolLaunchWindow = async (cfg: PoolConfig): Promise<string | undefined> => {
  if (cfg.allowExtraBoxes === true) return undefined
  const runtime = createPoolLaunchWindowRuntime(cfg)
  const announcedWait = { value: false }

  for (;;) {
    const idle = await findIdleBox(cfg.provision).catch(() => undefined)
    if (idle !== undefined) return idle

    let running: number
    try {
      running = await countLiveBoxes(cfg.provision)
    } catch (err) {
      await waitForReusableBoxProbe(runtime, err)
      continue
    }

    if (await handlePoolLaunchRunningBoxes(running, runtime, announcedWait)) return undefined
  }
}

const handleFreshLaunchRunningBoxes = async (
  running: number,
  runtime: PoolLaunchWindowRuntime,
  announcedWait: { value: boolean },
): Promise<boolean> => {
  if (running <= 0) return true
  if (!runtime.waitForIdle) {
    throw new Error(
      `[pool] refusing to launch a fresh box while ${running} quanta-bench box(es) are already live (running/pending). ` +
        "Reuse the existing box, wait for it to terminate, or opt in explicitly.",
    )
  }
  if (poolLaunchWindowTimedOut(runtime)) {
    throw new Error(
      `[pool] timed out waiting for ${running} live quanta-bench box(es) to terminate before launching a fresh box. ` +
        "Reuse the existing box, or use explicit extra-box opt-in.",
    )
  }
  if (!announcedWait.value) {
    runtime.log(
      `[pool] waiting for ${running} live quanta-bench box(es) to terminate before launching a fresh box…`,
    )
    announcedWait.value = true
  }
  await runtime.sleep(runtime.pollMs)
  return false
}

const awaitFreshLaunchWindow = async (cfg: PoolConfig): Promise<void> => {
  if (cfg.allowExtraBoxes === true) return
  const runtime = createPoolLaunchWindowRuntime(cfg)
  const announcedWait = { value: false }

  for (;;) {
    let running: number
    try {
      running = await countLiveBoxes(cfg.provision)
    } catch (err) {
      await waitForReusableBoxProbe(runtime, err)
      continue
    }

    if (await handleFreshLaunchRunningBoxes(running, runtime, announcedWait)) return
  }
}

const awaitPoolPreflightLaunchWindow = async (cfg: PoolConfig): Promise<void> => {
  if ((cfg.reuseWarm ?? true) === true) {
    await awaitPoolLaunchWindow(cfg)
    return
  }
  await awaitFreshLaunchWindow(cfg)
}

const acquirePoolSingleBoxGuard = async (
  chunks: readonly PoolChunk[],
  cfg: PoolConfig,
): Promise<SingleBoxGuard | undefined> => {
  if (cfg.allowExtraBoxes === true) return undefined
  const first = chunks[0]?.runId ?? "empty"
  const label = `pool:${first}${chunks.length > 1 ? `+${chunks.length - 1}` : ""}`
  return acquireSingleBoxGuard({
    label,
    ...(cfg.singleBoxGuardDir !== undefined ? { dir: cfg.singleBoxGuardDir } : {}),
    wait: cfg.waitForIdle === true,
    ...(cfg.waitForIdle === true ? { waitMs: cfg.waitForIdleTimeoutMs } : {}),
    ...(cfg.waitForIdlePollMs !== undefined ? { pollMs: cfg.waitForIdlePollMs } : {}),
    ...(cfg.now !== undefined ? { now: cfg.now } : {}),
    ...(cfg.sleep !== undefined ? { sleep: cfg.sleep } : {}),
    ...(cfg.onLog !== undefined ? { onLog: cfg.onLog } : {}),
  })
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
  try {
    await terminateWorkerSession(state)
  } catch (cleanupErr) {
    throw new Error(
      `[pool] worker ${workerId}: failed to terminate box after chunk ${chunk.runId} threw ${errMessage(err)}: ${errMessage(cleanupErr)}`,
    )
  }
  requeueOrLoseChunk(queue, out, chunk, attempt, runtime.maxRetries)
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

const mergeWorkerRunErrors = (
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
): Promise<void> => {
  const msg = errMessage(err)
  if (msg.includes(POOL_BUSY_ERROR)) {
    handlePoolBusyChunkError(workerId, queue, chunk, attempt, runtime, state, out)
    return
  }
  if (msg.includes(BOX_DIED_DURING_RUN_ERROR)) {
    // BUG 1: the detached poll loop confirmed the box DIED mid-run (spot reclaim
    // / wall-clock ceiling). Route to the dead-box requeue path FIRST — even
    // though a dead box also fails its grade-lock release (the secondary
    // GRADE_LOCK_RELEASE_FAILED gets wrapped in), that lock-release substring
    // must NOT mis-route a genuine box death to the rethrow branch below.
    await handleDeadBoxChunkError(workerId, queue, chunk, attempt, runtime, state, out, err)
    return
  }
  if (msg.includes(GRADE_LOCK_RELEASE_ERROR)) {
    throw err
  }
  await handleDeadBoxChunkError(workerId, queue, chunk, attempt, runtime, state, out, err)
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
    if (earnedVerdict(result)) {
      recordSuccessfulChunk(out, chunk, result, attempt)
      return { rateLimited: result.rateLimited === true, completed: true, lostBox: false }
    }
    await handleNoVerdictChunk(workerId, queue, chunk, attempt, runtime, state, out, result)
    return { rateLimited: result.rateLimited === true, completed: false, lostBox: true }
  } catch (err) {
    await routeChunkGradeError(err, workerId, queue, chunk, attempt, runtime, state, out)
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
        multiAuth,
      })
    }
  } catch (err) {
    primaryErr = err
    queue.abort()
  }
  await finalizeWorkerRun(workerId, runtime, state, primaryErr)
}

/**
 * Run all `chunks` through a persistent pool of `cfg.workers` boxes. Returns one
 * {@link PoolChunkResult} per chunk (keyed back to its runId), preserving the
 * input order. Bootstrap is paid ONCE per worker box, not per chunk.
 */
/** Per-chunk launchability preflight — dataset reachable, selection non-empty,
 *  and strict-grounding supported for the configured preset. Throws on any gap. */
const assertPoolChunksLaunchable = (chunks: readonly PoolChunk[], cfg: PoolConfig): void => {
  for (const chunk of chunks) {
    assertRemoteDatasetLaunchable({
      datasetPath: chunk.datasetPath,
      surface: `pool chunk ${chunk.runId}`,
    })
    assertRemoteDatasetSelectionExists({
      datasetPath: chunk.datasetPath,
      ...(chunk.instanceIds !== undefined ? { instanceIds: chunk.instanceIds } : {}),
      surface: `pool chunk ${chunk.runId}`,
    })
    assertRemoteStrictGroundingSupported({
      preset: cfg.preset,
      datasetPath: chunk.datasetPath,
      ...(chunk.instanceIds !== undefined ? { instanceIds: chunk.instanceIds } : {}),
      surface: `pool chunk ${chunk.runId}`,
    })
  }
}

/** Normalize + gate the requested worker count: parallel workers can launch
 *  parallel boxes, so multi-worker runs require BOTH explicit opt-ins. */
const resolvePoolWorkerCount = (cfg: PoolConfig): number => {
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
  return workers
}

/** Reconcile the single-box guard release with the run's primary error: a
 *  release failure is folded into the primary error when one exists, else it
 *  becomes the thrown error; otherwise the run's result/primary error stands. */
const settlePoolOutcome = (
  result: PoolChunkResult[] | undefined,
  primaryErr: unknown,
  guardReleaseErr: unknown,
): PoolChunkResult[] => {
  if (guardReleaseErr !== undefined) {
    if (primaryErr !== undefined) {
      throw new Error(
        `[pool] failed to release the single-box guard after ${errMessage(primaryErr)}: ${errMessage(guardReleaseErr)}`,
      )
    }
    throw guardReleaseErr
  }
  if (primaryErr !== undefined) throw primaryErr
  if (result !== undefined) return result
  throw new Error("[pool] run completed without a result or error")
}

export const runPool = async (
  chunks: readonly PoolChunk[],
  cfg: PoolConfig,
): Promise<PoolChunkResult[]> => {
  assertUniqueChunkRunIds(chunks)
  if (chunks.length === 0) return []
  assertPoolChunksLaunchable(chunks, cfg)
  const workers = resolvePoolWorkerCount(cfg)
  const guard = await acquirePoolSingleBoxGuard(chunks, cfg)
  let result: PoolChunkResult[] | undefined
  let primaryErr: unknown
  try {
    await awaitPoolPreflightLaunchWindow(cfg)
    const queue = new ChunkQueue(chunks)
    const attemptsByRun = new Map<string, number>()
    const out = new Map<string, PoolChunkResult>()
    const workerRuns = Array.from({ length: workers }, (_unused, i) => ({
      workerId: i + 1,
      promise: runWorker(i + 1, queue, cfg, attemptsByRun, out),
    }))
    const settled = await Promise.allSettled(workerRuns.map((worker) => worker.promise))
    const workerErrors = settled.flatMap((result, idx) =>
      result.status === "rejected"
        ? [{ workerId: workerRuns[idx]?.workerId ?? idx + 1, error: result.reason }]
        : [],
    )
    if (workerErrors.length > 0) {
      throw mergeWorkerRunErrors(workerErrors)
    }

    // Preserve input order; a chunk with no recorded result (should not happen —
    // every path records one) is surfaced as lost rather than dropped.
    result = chunks.map(
      (chunk) =>
        out.get(chunk.runId) ?? {
          chunk,
          result: {},
          attempts: attemptsByRun.get(chunk.runId) ?? 0,
          lost: true,
        },
    )
  } catch (err) {
    primaryErr = err
  }

  let guardReleaseErr: unknown
  try {
    await guard?.release()
  } catch (err) {
    guardReleaseErr = err
  }

  return settlePoolOutcome(result, primaryErr, guardReleaseErr)
}
