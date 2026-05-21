import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { runtimeConfig } from "@/shared"

/**
 * Persistent bench artifacts root. NEVER `tmpdir()` — bench corpus,
 * predictions, reports and observe trajectories MUST survive across runs. The
 * OS reaps `/tmp`, which silently destroyed earlier triage data (the per-run
 * patches + trajectory JSONL were the only post-mortem signal and they were
 * gone by the next session).
 *
 * Precedence:
 *   1. `QUANTA_BENCH_HOME` env override (explicit operator choice)
 *   2. `<QUANTA_HOME>/bench` when `QUANTA_HOME` is set (shares the app home)
 *   3. macOS:  `~/Library/quanta-codeagent-v3/bench`
 *      other:  `~/.quanta/bench`
 */
export const benchHome = (): string => {
  const cfg = runtimeConfig()
  if (cfg.benchHome) return cfg.benchHome
  if (cfg.quantaHome) return join(cfg.quantaHome, "bench")
  const base =
    process.platform === "darwin"
      ? join(homedir(), "Library", "quanta-codeagent-v3")
      : join(homedir(), ".quanta")
  return join(base, "bench")
}

const ensureDir = (dir: string): string => {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Scratch workdirs (cloned repos, sandboxes). Persisted (not tmp) so a failed
 *  run is inspectable; callers still `rm` their own `mkdtemp` subdir on the
 *  success path. */
export const benchWorkRoot = (): string => ensureDir(join(benchHome(), "work"))

/** Run-output root (predictions / report / observe trajectories). */
export const benchRunsRoot = (): string => ensureDir(join(benchHome(), "runs"))

/** Stable run id for this process (shared by observe + predictions + report so
 *  they group under one `runs/<runId>/` dir). `QUANTA_RUN_ID` pins it. */
export const benchRunId = (): string => runtimeConfig().runId ?? `run-${Date.now()}`

/** Per-run output dir: `<benchHome>/runs/<runId>/`. Created on first call. */
export const benchRunDir = (runId: string): string => ensureDir(join(benchRunsRoot(), runId))
