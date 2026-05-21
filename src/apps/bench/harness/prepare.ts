/**
 * Pre-build the SWE-bench env image set BEFORE a batch eval, via
 * `swebench.harness.prepare_images`. The expensive per-repo conda env images
 * are built once here (in parallel, `--max_workers`) so the subsequent
 * `run_evaluation` is a near-pure container run against warm images instead of
 * serializing on a lazy first-instance build.
 *
 * NEVER throws — an unavailable harness / non-zero exit / spawn error all
 * resolve to `{ ok: false, … }` so the caller (bench CLI) can report + exit.
 */
import { runtimeConfig } from "@/shared"
import { hostArch } from "./arch"
import { type HarnessConfig, harnessFlags, resolveHarnessConfig } from "./config"
import { type DockerSpawn, listSwebenchImages } from "./images"

/** Local Spawn type (same shape as python-swebench's; declared here to avoid a
 *  cross-file import cycle between prepare.ts and python-swebench.ts). */
export type Spawn = (argv: string[], cwd: string, timeoutMs: number) => Promise<{
  code: number
  stdout: string
  stderr: string
}>

export interface PrepareImagesOpts {
  /** Predictions JSONL that scopes the instance set (when instanceIds absent). */
  predictionsPath: string
  /** Run id (log grouping; matches the eval run_id namespace). */
  runId: string
  /** Explicit instance ids to prepare (takes precedence over predictionsPath). */
  instanceIds?: string[]
  /** Dataset (HF id or local JSONL). Required — mirrors evaluate.ts. */
  datasetName: string
  /** Wall-clock budget for the prepare invocation. Default 1800000 (30m). */
  timeoutMs?: number
  /** Resolved harness config. Absent ⇒ `resolveHarnessConfig()`. */
  config?: HarnessConfig
  /** Explicit python interpreter. Absent ⇒ probe per {@link pythonCandidates}. */
  python?: string
  /** Injected python subprocess (tests pass a fake). */
  spawn?: Spawn
  /** Injected docker query for the warm-pool short-circuit (tests pass a fake). */
  dockerSpawn?: DockerSpawn
}

export interface PrepareImagesResult {
  /** True iff prepare_images exited 0. Never throws. */
  ok: boolean
  /** How many env-tier images were already present (warm-pool signal). */
  preexistingEnvImages: number
  /** Tail (~50 lines) of stdout/stderr from the prepare invocation. */
  log: string
}

const defaultSpawn: Spawn = async (argv, cwd, timeoutMs) => {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: process.env })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

/** Python interpreter candidates, override-first (mirrors python-swebench.ts). */
const pythonCandidates = (): readonly string[] => {
  const override = runtimeConfig().swebenchPythonBin
  return override ? [override, "python", "python3"] : ["python", "python3"]
}

const resolvePython = async (spawn: Spawn): Promise<string | null> => {
  for (const py of pythonCandidates()) {
    try {
      const r = await spawn([py, "-c", "import swebench"], ".", 15000)
      if (r.code === 0) return py
    } catch {
      // try the next interpreter
    }
  }
  return null
}

/** `prepare_images` accepts a NARROWER flag set than `run_evaluation`: only
 *  `--max_workers`, `--namespace`, `--force_rebuild` overlap. It rejects
 *  `--cache_level` and `--clean` (it only builds, never grades or tears down).
 *  We derive the prepare-safe subset from {@link harnessFlags} so the values
 *  stay in sync, then drop the two unsupported pairs. */
const PREPARE_DROP_FLAGS = new Set(["--cache_level", "--clean"])
const prepareFlags = (config: HarnessConfig): string[] => {
  const flags = harnessFlags(config)
  const out: string[] = []
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]
    if (f !== undefined && PREPARE_DROP_FLAGS.has(f)) {
      i++ // skip the value token too
      continue
    }
    if (f !== undefined) out.push(f)
  }
  return out
}

const tail = (s: string, lines = 50): string => s.split("\n").slice(-lines).join("\n")

export const prepareImages = async (opts: PrepareImagesOpts): Promise<PrepareImagesResult> => {
  const spawn = opts.spawn ?? defaultSpawn
  const config = opts.config ?? resolveHarnessConfig()

  // arm64 guard: `prepare_images` ALWAYS builds locally (it has no pull mode).
  // SWE-bench base/env Dockerfiles pin linux/amd64, and conda's installer
  // crashes under x86 emulation on Apple Silicon (build exits 133 at the
  // miniconda step — observed). So prepare-images is only viable on native
  // x86 hosts. On arm64 the warm-cache win is still had FOR FREE: run_evaluation
  // PULLS the prebuilt env image and (with clean=false, the default) leaves it
  // on disk for the next instance. Return early with guidance instead of
  // burning a minute on a doomed build. Operators on arm64 who insist (e.g.
  // a working binfmt setup) can override with QUANTA_SWEBENCH_PREPARE_FORCE=1.
  //
  // `injected` = the caller passed a fake spawn ⇒ this is a unit test; never
  // short-circuit so the argv-contract tests still exercise the build path.
  const injected = opts.spawn !== undefined
  const forced = runtimeConfig().swebenchPrepareForce
  if (!injected && !forced && hostArch() === "arm64") {
    return {
      ok: false,
      preexistingEnvImages: 0,
      log:
        "prepare-images skipped on arm64: prepare_images builds x86 images " +
        "locally and conda crashes under emulation (build exit 133). The warm " +
        "cache is obtained automatically by running the eval directly " +
        "(run_evaluation pulls prebuilt images and keeps them with clean=false). " +
        "Set QUANTA_SWEBENCH_PREPARE_FORCE=1 to attempt the local build anyway.",
    }
  }

  // Warm-pool signal: how many env images already exist locally.
  let preexistingEnvImages = 0
  try {
    const images = await listSwebenchImages(
      opts.dockerSpawn ? { spawn: opts.dockerSpawn } : {},
    )
    preexistingEnvImages = images.filter((i) => i.tier === "env").length
  } catch {
    preexistingEnvImages = 0
  }

  const python = opts.python ?? (await resolvePython(spawn))
  if (!python) {
    return { ok: false, preexistingEnvImages, log: "no python interpreter could import swebench" }
  }

  // NOTE: prepare_images does NOT accept --predictions_path / --run_id /
  // --cache_level / --clean (verified against `prepare_images --help`). The
  // instance set comes from --instance_ids (always passed by the bench CLI)
  // or --dataset_name alone (prepares the whole split — avoid). predictionsPath
  // + runId are retained on the opts only for caller symmetry + log grouping.
  //
  // CRITICAL: prepare_images defaults `--env_image_tag` to None (which trips an
  // assertion in make_test_spec), whereas run_evaluation defaults BOTH
  // env/instance image tags to "latest". We pass "latest" explicitly so (a)
  // prepare doesn't crash and (b) the env image it builds is tagged identically
  // to what the later run_evaluation will look up — otherwise the warm cache
  // would be a silent miss (different tag = different image name).
  const argv = [
    python,
    "-m",
    "swebench.harness.prepare_images",
    "--dataset_name",
    opts.datasetName,
    "--tag",
    "latest",
    "--env_image_tag",
    "latest",
    ...prepareFlags(config),
  ]
  if (opts.instanceIds && opts.instanceIds.length > 0) {
    argv.push("--instance_ids", ...opts.instanceIds)
  }

  try {
    const r = await spawn(argv, ".", opts.timeoutMs ?? 1800000)
    const log = [`cmd: ${argv.join(" ")}`, `exit: ${r.code}`, `stdout(tail): ${tail(r.stdout)}`, `stderr(tail): ${tail(r.stderr)}`].join("\n")
    return { ok: r.code === 0, preexistingEnvImages, log }
  } catch (e) {
    return {
      ok: false,
      preexistingEnvImages,
      log: `prepare_images invocation failed: ${(e as Error).message}`,
    }
  }
}
