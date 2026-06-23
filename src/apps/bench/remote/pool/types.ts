/**
 * Public + shared types for the persistent full-remote box pool (jun-20
 * box-lifecycle plan, Phase 2). Split out of pool.ts so the worker/coverage/
 * launch-window siblings share one definition of {@link PoolChunk} /
 * {@link PoolConfig} / {@link PoolChunkResult} without a cyclic dependency on
 * the orchestrator.
 */
import type { FullRemoteConfig, FullRemoteResult } from "../box-session"
import type { PoolAuthProvider } from "../pool-auth"

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
  /** #2: instances this chunk REQUESTED (via {@link PoolChunk.instanceIds}) but
   *  that never earned any verdict after all attempts — a PARTIAL coverage gap.
   *  Present (non-empty) only when the chunk graded a strict subset; never let
   *  these vanish silently (the box-died-after-grading-N confound). Empty/absent
   *  when coverage was complete or the chunk had no declared instance set. */
  readonly missing?: readonly string[]
}

export const sleepReal = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms))
