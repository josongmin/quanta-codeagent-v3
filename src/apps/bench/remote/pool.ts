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
  countRunningBoxes,
  type FullRemoteConfig,
  type FullRemoteResult,
  findIdleBox,
  gradeChunkOnBox,
  POOL_BUSY_ERROR,
  provisionBox,
} from "./box-session"

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
  readonly preset: string
  readonly model: string
  /** Per-box patch-gen concurrency forwarded to `bench run`. */
  readonly concurrency: number
  /** Re-read the RAW chatgpt.json fresh PER CHUNK so a long run never ships a
   *  stale access_token. Called once per chunk attempt. */
  readonly authJsonProvider: () => string
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
  const log = cfg.onLog ?? (() => {})
  const maxRetries = Math.max(0, cfg.maxChunkRetries ?? 2)
  const now = cfg.now ?? (() => Date.now())
  const maxBoxWallMs = Math.max(0, cfg.maxBoxWallMs ?? 150 * 60 * 1000)
  const reuseWarm = cfg.reuseWarm ?? true
  const keepWarm = cfg.keepWarm ?? true
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const backoffBaseMs = Math.max(0, cfg.backoffBaseMs ?? 90_000)
  const backoffMaxMs = Math.max(0, cfg.backoffMaxMs ?? 30 * 60 * 1000)

  let session: BoxSession | undefined
  let boxProvisionedAt = 0
  // Consecutive rate-limited chunks ⇒ exponential backoff (resets on a clean one).
  let consecRateLimited = 0
  const provision = async (): Promise<BoxSession> => {
    // Prefer REUSING a warm, idle box (skips the whole bootstrap). Spot boxes get
    // reclaimed, so this is best-effort — none found ⇒ launch a fresh one.
    if (reuseWarm) {
      const idle = await findIdleBox(cfg.provision).catch(() => undefined)
      if (idle !== undefined) {
        const s = await attachBox(cfg.provision, idle)
        boxProvisionedAt = now()
        log(`[pool] worker ${workerId}: reusing warm box ${s.iid}`)
        return s
      }
    }
    log(`[pool] worker ${workerId}: provisioning box…`)
    const s = await provisionBox(cfg.provision)
    boxProvisionedAt = now()
    log(`[pool] worker ${workerId}: box ${s.iid} ready`)
    return s
  }

  try {
    for (let chunk = queue.next(); chunk !== undefined; chunk = queue.next()) {
      const attempt = (attemptsByRun.get(chunk.runId) ?? 0) + 1
      attemptsByRun.set(chunk.runId, attempt)

      // PROACTIVE rotation: retire a box that is about to hit its EC2 TTL BEFORE
      // it kills the next chunk mid-grade. NOT a chunk failure — just retire the
      // box so the `session === undefined` block below provisions a fresh one.
      if (session !== undefined && maxBoxWallMs > 0 && now() - boxProvisionedAt >= maxBoxWallMs) {
        log(
          `[pool] worker ${workerId}: box ${session.iid} reached wall-time budget (${Math.round(maxBoxWallMs / 60000)}min) — rotating before TTL kills a chunk…`,
        )
        await session.terminate().catch(() => undefined)
        session = undefined
      }

      // (Re)provision a box if we don't currently hold a live one.
      if (session === undefined) {
        try {
          session = await provision()
        } catch (err) {
          // Provisioning itself failed — requeue (bounded) and let the next loop
          // try again, or surface the loss.
          log(`[pool] worker ${workerId}: provision failed: ${errMessage(err)}`)
          if (attempt <= maxRetries) {
            queue.requeueFront(chunk)
          } else {
            out.set(chunk.runId, { chunk, result: {}, attempts: attempt, lost: true })
          }
          continue
        }
      }

      const paths = chunkBoxPaths(chunk.runId)
      // Capture the rate-limit signal from THIS attempt's result directly — NOT
      // from the shared `out` map (which a requeued/no-verdict chunk never writes,
      // and which a same-runId collision could read stale). A throttled run very
      // often yields a no-verdict report yet sets rateLimited:true, so this is the
      // case the backoff most needs to see.
      let chunkRateLimited = false
      try {
        // The dataset scp target dir must exist (scp won't mkdir). observeDir too.
        await session.ssh(`mkdir -p ${paths.observeDir}`)
        const result = await gradeChunkOnBox(session, {
          datasetPath: chunk.datasetPath,
          authJson: cfg.authJsonProvider(), // FRESH token per chunk
          ...(chunk.instanceIds !== undefined ? { instanceIds: chunk.instanceIds } : {}),
          preset: cfg.preset,
          model: cfg.model,
          concurrency: cfg.concurrency,
          paths,
          artifactSuffix: chunk.runId,
          recordTrajectory: cfg.recordTrajectory ?? false,
          forwardedBenchEnv: cfg.forwardedBenchEnv ?? "",
        })
        chunkRateLimited = result.rateLimited === true
        if (earnedVerdict(result)) {
          out.set(chunk.runId, { chunk, result, attempts: attempt, lost: false })
        } else if (attempt <= maxRetries) {
          // No verdict — most likely the box died mid-run. Drop this box and
          // requeue the chunk on a fresh one.
          log(
            `[pool] worker ${workerId}: chunk ${chunk.runId} produced no verdict (box died?) — requeue (attempt ${attempt}/${maxRetries + 1})`,
          )
          await session.terminate()
          session = undefined
          queue.requeueFront(chunk)
        } else {
          out.set(chunk.runId, { chunk, result, attempts: attempt, lost: true })
        }
      } catch (err) {
        const msg = errMessage(err)
        if (msg.includes(POOL_BUSY_ERROR)) {
          // The reused box was grabbed by ANOTHER run (lock race). DROP it WITHOUT
          // terminating — it is not ours to kill — and requeue to launch a fresh one.
          log(
            `[pool] worker ${workerId}: chunk ${chunk.runId} — box busy (another run); requeue on a fresh box`,
          )
          session = undefined
          if (attempt <= maxRetries) queue.requeueFront(chunk)
          else out.set(chunk.runId, { chunk, result: {}, attempts: attempt, lost: true })
        } else {
          // gradeChunkOnBox threw (scp/ssh hard failure) — treat as a dead box.
          log(`[pool] worker ${workerId}: chunk ${chunk.runId} threw: ${msg}`)
          await session?.terminate().catch(() => undefined)
          session = undefined
          if (attempt <= maxRetries) queue.requeueFront(chunk)
          else out.set(chunk.runId, { chunk, result: {}, attempts: attempt, lost: true })
        }
      }

      // 429 BACKOFF: a chunk that hit the shared-OAuth rate limit means the token
      // is throttled — pausing before the next chunk lets it recover instead of
      // burning more 429s (the contention that confounds a multi-run fleet). Read
      // the signal from THIS attempt (`chunkRateLimited`), so a throttled-but-no-
      // verdict chunk that got requeued still triggers the backoff.
      if (chunkRateLimited && backoffBaseMs > 0 && queue.size > 0) {
        consecRateLimited += 1
        const backoff = Math.min(backoffMaxMs, backoffBaseMs * 2 ** (consecRateLimited - 1))
        log(
          `[pool] worker ${workerId}: rate-limited (#${consecRateLimited} consecutive) — backing off ${Math.round(backoff / 1000)}s before next chunk`,
        )
        await sleep(backoff)
      } else if (!chunkRateLimited) {
        consecRateLimited = 0 // clean chunk resets the backoff ladder
      }
    }
  } finally {
    // On a CLEAN drain, leave the box WARM by default so the next run reuses it
    // (it self-terminates at its TTL / on spot reclaim). Dead and rotated boxes
    // were already terminated above. `keepWarm: false` forces termination.
    if (!keepWarm) {
      log(`[pool] worker ${workerId}: terminating box (keepWarm=false)`)
      await session?.terminate().catch(() => undefined)
    } else if (session !== undefined) {
      log(`[pool] worker ${workerId}: leaving box ${session.iid} WARM for reuse (TTL reaps it)`)
    }
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
  if (cfg.allowExtraBoxes !== true) {
    const idle = await findIdleBox(cfg.provision).catch(() => undefined)
    if (idle === undefined) {
      const running = await countRunningBoxes(cfg.provision)
      if (running > 0) {
        throw new Error(
          `[pool] refusing to launch another box while ${running} quanta-bench box(es) are already running. ` +
            "Wait for the existing box to go idle, or opt in explicitly.",
        )
      }
    }
  }
  const queue = new ChunkQueue(chunks)
  const attemptsByRun = new Map<string, number>()
  const out = new Map<string, PoolChunkResult>()

  await Promise.all(
    Array.from({ length: workers }, (_unused, i) =>
      runWorker(i + 1, queue, cfg, attemptsByRun, out),
    ),
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
