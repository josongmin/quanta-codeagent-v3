import { createHash } from "node:crypto"
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
 *   2. `<unified home>/bench` when an app-home root is explicitly set —
 *      `QUANTA_CONFIG_DIR` (canonical) ?? `QUANTA_HOME` (alias). Matches the
 *      quantaHomeDir() SSOT precedence, but WITHOUT its `~/.quanta` default so
 *      the bench-specific macOS Library default below is preserved.
 *   3. macOS:  `~/Library/quanta-codeagent-v3/bench`
 *      other:  `~/.quanta/bench`
 */
export const benchHome = (): string => {
  const cfg = runtimeConfig()
  if (cfg.benchHome) return cfg.benchHome
  const explicitRoot = cfg.centralConfigDir ?? cfg.quantaHome
  if (explicitRoot) return join(explicitRoot, "bench")
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

/** Opaque agent-visible workdir component. Dataset instance ids are retained in
 * reports and grader metadata, but never exposed through the sandbox path: some
 * SWE-bench Pro ids contain the upstream fix commit SHA. */
export const benchInstanceWorkSlug = (instanceId: string): string =>
  createHash("sha256").update(instanceId).digest("hex").slice(0, 20)

/** Run-output root (predictions / report / observe trajectories). */
export const benchRunsRoot = (): string => ensureDir(join(benchHome(), "runs"))

/** Stable run id for this process (shared by observe + predictions + report so
 *  they group under one `runs/<runId>/` dir). `QUANTA_RUN_ID` pins it. */
export const benchRunId = (): string => runtimeConfig().runId ?? `run-${Date.now()}`

/** Per-run output dir: `<benchHome>/runs/<runId>/`. Created on first call. */
export const benchRunDir = (runId: string): string => ensureDir(join(benchRunsRoot(), runId))
