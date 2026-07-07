/**
 * Resolved SWE-bench harness configuration — the SSOT that replaces the old
 * hardcoded `--cache_level none --clean True --max_workers 1` in
 * python-swebench.ts. All values flow from {@link runtimeConfig} (frozen at
 * startup) with SOTA defaults: keep the per-repo env image warm, don't clean
 * between runs, parallelize to ~75% of cores, build locally for the host arch.
 */
import { availableParallelism } from "node:os"
import { runtimeConfig, type SwebenchCacheLevel } from "@/shared"
import { defaultNamespace } from "./arch"

export interface HarnessConfig {
  /** `--cache_level`: which image tiers survive the run. Default `env`. */
  cacheLevel: SwebenchCacheLevel
  /** `--clean`: remove images above cacheLevel after the run. Default false. */
  clean: boolean
  /** `--max_workers`: instance-eval parallelism. Default `min(4, 75% cores)`. */
  maxWorkers: number
  /** `--namespace`: image registry namespace. Default `none` (build locally). */
  namespace: string
  /** `--force_rebuild`: ignore cached images. Default false. */
  forceRebuild: boolean
}

/** Upstream guidance: workers should be <= 75% of CPU cores. We also cap at 4
 *  because Docker image builds are I/O + memory heavy and over-subscription
 *  thrashes the daemon more than it parallelizes. */
export const computeMaxWorkers = (cores: number): number => {
  const threeQuarters = Math.floor(cores * 0.75)
  return Math.max(1, Math.min(4, threeQuarters))
}

/**
 * Build the resolved harness config from the frozen runtime config. Pure: the
 * only ambient reads are `runtimeConfig()` (frozen) and `availableParallelism`
 * (stable per host). `cores` is injectable for tests.
 */
export const resolveHarnessConfig = (cores: number = availableParallelism()): HarnessConfig => {
  const cfg = runtimeConfig()
  return {
    cacheLevel: cfg.swebenchCacheLevel,
    clean: cfg.swebenchClean,
    maxWorkers: cfg.swebenchMaxWorkers ?? computeMaxWorkers(cores),
    namespace: cfg.swebenchNamespace ?? defaultNamespace(),
    forceRebuild: cfg.swebenchForceRebuild,
  }
}

/** Render the harness config as `run_evaluation` argv flags (no interpreter /
 *  predictions / instance args — those are caller-owned). Centralized so the
 *  evaluate path emits the same cache/namespace flags as any future prepare
 *  path would. */
export const harnessFlags = (c: HarnessConfig): string[] => [
  "--max_workers",
  String(c.maxWorkers),
  "--cache_level",
  c.cacheLevel,
  "--clean",
  c.clean ? "True" : "False",
  // swebench==2.1.6 does not expose --namespace; the harness resolves the
  // image namespace internally. Passing --namespace causes an immediate crash
  // ("unrecognized arguments") so we omit it unconditionally here.
  ...(c.forceRebuild ? ["--force_rebuild", "True"] : []),
]
