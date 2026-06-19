/**
 * Official SWE-bench Python harness verifier (the documented seam, now real).
 *
 * ── What this does ────────────────────────────────────────────────────────
 * Given a real `swebench.verified` Instance and the unified diff the agent
 * produced, this writes an official predictions JSONL and invokes the upstream
 * grader:
 *
 *   python -m swebench.harness.run_evaluation \
 *       --predictions_path <preds.jsonl> \
 *       --run_id <run_id> \
 *       --instance_ids <instance_id> \
 *       --max_workers 1 --cache_level none --clean True \
 *       [--dataset_name <name>]
 *
 * The harness writes a report `<model>.<run_id>.json` into its cwd whose
 * `resolved_ids` lists the instances that passed FAIL_TO_PASS + PASS_TO_PASS.
 * We parse that (with a tolerant fallback over `*.json` reports) into
 * `{ resolved, log }`.
 *
 * ── Self-contained, like runner.ts ────────────────────────────────────────
 * Process spawning is a tiny local Bun.spawn helper (NOT an import of
 * @/runtime) and is injectable (`PySwebenchOpts.spawn`/`.probe`) so tests stay
 * hermetic — no real Python, no Docker, no network required.
 *
 * ── Availability + fallback ───────────────────────────────────────────────
 * `isPythonSwebenchAvailable()` probes `python -c "import swebench"` (then
 * `python3`). If unavailable the caller (runner.ts) silently keeps the
 * existing local `testCmd` path. This module NEVER throws for an
 * environment/grader failure — it returns `{ resolved: false, log }`.
 *
 * Argv is built as an array (Bun.spawn, no shell) so instance ids / paths
 * cannot inject shell.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { abortableSleep, abortReasonOf, errMessage, runtimeConfig } from "@/shared"
import { benchWorkRoot } from "./corpus/paths"
import { type HarnessConfig, harnessFlags, resolveHarnessConfig } from "./harness"
import type { Instance } from "./types"

export interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

/** Injectable process boundary: argv (no shell), cwd, timeout → result. */
export type Spawn = (argv: string[], cwd: string, timeoutMs: number) => Promise<SpawnResult>

/** Default argv spawn via Bun.spawn (no shell ⇒ no injection). Local copy of
 *  runner.ts's pattern — intentionally NOT imported (bench stays self-
 *  contained per RFC §3.1). */
export const defaultSpawn: Spawn = async (argv, cwd, timeoutMs) => {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
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

/**
 * Canonical SWE-bench **Verified** dataset id. This tool's identity is a
 * Verified harness, so this is the default `--dataset_name` when the caller
 * does not override it. NOTE: the upstream `run_evaluation` default is the
 * FULL `princeton-nlp/SWE-bench` split — NOT Verified — so omitting
 * `--dataset_name` would silently grade the wrong dataset. We therefore always
 * pass an explicit dataset (this constant unless overridden).
 */
export const SWEBENCH_VERIFIED_DATASET = "princeton-nlp/SWE-bench_Verified"

export interface PySwebenchOpts {
  /** Override the process boundary (tests inject a fake). */
  spawn?: Spawn
  /** Override the availability probe (tests force true/false). */
  probe?: () => Promise<boolean>
  /** `--dataset_name` for the harness (HF id or local JSONL). When unset we
   *  default to {@link SWEBENCH_VERIFIED_DATASET} — NOT the harness's own
   *  default (which is the full SWE-bench split, not Verified). */
  datasetName?: string
  /** model_name_or_path written into the predictions row (and the report
   *  filename the harness emits). Default "quanta". */
  modelName?: string
  /** Wall-clock budget for the harness invocation. Default 1800000 (30m). */
  timeoutMs?: number
  /** T01 (audit L5 H-5 / M-8): per-instance cancellation. When the eval driver's
   *  per-instance deadline fires, the transient-crash retry sleep races against
   *  this signal instead of blocking the full 5s, and the retry is skipped
   *  entirely if already aborted. The spawn boundary itself is owned by the
   *  injected `Spawn` seam (which threads its own process timeout); this signal
   *  governs the harness-level orchestration (retry sleep + pre-retry gate). */
  signal?: AbortSignal
  /** Resolved harness config (cache/clean/workers/namespace/forceRebuild).
   *  Absent ⇒ `resolveHarnessConfig()` is called inside `buildArgv` to pull
   *  the frozen runtime-config defaults. Tests inject explicit configs. */
  harnessConfig?: HarnessConfig
}

export interface PySwebenchResult {
  /** True iff the instance id appears in the harness report's resolved_ids. */
  resolved: boolean
  /** True iff the swebench harness reached its summary line. False ⇒ harness
   *  crashed (Docker glitch, image-pull race, module import error) BEFORE
   *  grading. Callers distinguish: resolved:false+gradingCompleted:true is a
   *  REAL patch fail; resolved:false+gradingCompleted:false is an INFRA fail
   *  (retry-worthy). The retry path inside this module handles transient
   *  crashes silently; this field reaches the caller for downstream
   *  classification (verdict.ts uses it to avoid the `harness_error` misname). */
  gradingCompleted: boolean
  /** Human-readable trace: probe/argv/exit + report excerpt or failure cause.
   *  Always populated, even on failure (never throws to the caller). */
  log: string
}

/** Python interpreter candidates, tried in order. Explicit override
 *  (`QUANTA_SWEBENCH_PYTHON_BIN`) is checked FIRST. Default fallbacks are
 *  `python` then `python3`. The `swebench` PyPI package needs 3.10+ (PEP 604
 *  `list | None`); hosts whose `python3` is older MUST set the explicit
 *  override or no candidate will resolve. */
const pythonCandidates = (): readonly string[] => {
  const override = runtimeConfig().swebenchPythonBin
  return override ? [override, "python", "python3"] : ["python", "python3"]
}

/** `import swebench` is HEAVY — it eagerly pulls in docker/datasets/etc. and
 *  measures ~10s cold even on an idle box, spiking past a 15s budget under any
 *  CPU contention (multiple bench/test sessions). A too-tight probe silently
 *  falls back to the FAKE `testCmd:"true"` grader (every patch "passes"), so the
 *  budget is deliberately generous. Observed 9–13s idle ⇒ 60s headroom. */
const IMPORT_PROBE_TIMEOUT_MS = 60_000

/**
 * Detect the official Python harness. True iff some interpreter can
 * `import swebench`. Never throws (any spawn failure ⇒ false). The probe is
 * overridable for hermetic tests.
 */
export const isPythonSwebenchAvailable = async (opts: PySwebenchOpts = {}): Promise<boolean> => {
  if (opts.probe) return opts.probe()
  const spawn = opts.spawn ?? defaultSpawn
  for (const py of pythonCandidates()) {
    try {
      const r = await spawn([py, "-c", "import swebench"], ".", IMPORT_PROBE_TIMEOUT_MS)
      if (r.code === 0) return true
    } catch {
      // try the next interpreter
    }
  }
  return false
}

/** First interpreter that can import swebench, or null. */
const resolvePython = async (spawn: Spawn): Promise<string | null> => {
  for (const py of pythonCandidates()) {
    try {
      const r = await spawn([py, "-c", "import swebench"], ".", IMPORT_PROBE_TIMEOUT_MS)
      if (r.code === 0) return py
    } catch {
      // try the next interpreter
    }
  }
  return null
}

const INSTANCE_KEYS = ["resolved_ids", "resolved_instances", "resolved"] as const

/** Pull a string[] of resolved instance ids out of a parsed report object,
 *  tolerating the few key spellings the harness has used across versions. */
const extractResolvedIds = (report: unknown): string[] => {
  if (typeof report !== "object" || report === null) return []
  const rec = report as Record<string, unknown>
  for (const key of INSTANCE_KEYS) {
    const v = rec[key]
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string")
  }
  return []
}

/** Scan `dir` for the harness report JSON(s) and return every resolved id
 *  found across them. Tolerant: unreadable/non-JSON files are skipped. */
const collectResolvedIds = async (dir: string): Promise<string[]> => {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const ids: string[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as unknown
      ids.push(...extractResolvedIds(parsed))
    } catch {
      // not a report / unreadable — skip
    }
  }
  return ids
}

/**
 * Build the `run_evaluation` argv. Cache/clean/workers/namespace/force_rebuild
 * flags flow from {@link resolveHarnessConfig} (frozen runtime-config), not
 * hardcoded — SOTA defaults: `cache_level=env clean=false workers=min(4,75%cores)
 * namespace=none` keep the per-repo env image warm across runs and build
 * locally for the host arch (no x86 emulation on arm64).
 *
 * Operators restore the prior brittle defaults via env vars:
 *   `QUANTA_SWEBENCH_CACHE_LEVEL=none QUANTA_SWEBENCH_CLEAN=true
 *    QUANTA_SWEBENCH_MAX_WORKERS=1`.
 */
export const buildArgv = (
  python: string,
  predictionsPath: string,
  runId: string,
  instanceId: string,
  datasetName: string | undefined,
  config: HarnessConfig = resolveHarnessConfig(),
): string[] => {
  const argv = [
    python,
    "-m",
    "swebench.harness.run_evaluation",
    "--predictions_path",
    predictionsPath,
    "--run_id",
    runId,
    "--instance_ids",
    instanceId,
    ...harnessFlags(config),
  ]
  if (datasetName) argv.push("--dataset_name", datasetName)
  return argv
}

/**
 * Grade one instance's `prediction` (a unified `diff --git` patch) with the
 * official Python harness. Returns `{ resolved, log }`; NEVER throws — an
 * unavailable harness, a non-swebench instance, an empty patch, or a grader
 * crash all resolve to `{ resolved: false, log: <why> }` so the caller can
 * fall back to its local testCmd path.
 */
/**
 * Process-global grading semaphore — ALWAYS SERIAL (limit hard-pinned to 1).
 *
 * ⚠️ Concurrent on-box grading was PROVEN to FALSE-NEGATIVE correct patches
 * (2026-06-19: GRADE_CONCURRENCY=6 scored 0/5; the SAME 5 patches re-graded
 * serially scored 4/5, with 3 byte-identical to gold + git-apply-clean).
 * Separate `run_evaluation` processes race the shared run_id image cache/cleanup
 * ("Removed N images") and yank each other's containers — the assumption that
 * "distinct instances ⇒ distinct containers ⇒ safe" was WRONG.
 *
 * So `gradeLimit()` is HARD-CLAMPED to 1: a stray `QUANTA_SWEBENCH_GRADE_CONCURRENCY>1`
 * is IGNORED (a warning comment isn't a guard — the code must refuse it). The
 * knob/field are retained only so the value is recorded; they no longer change
 * behavior. For PARALLEL grading use the grade-only path's swebench-native
 * `--max_workers` (harness-internal, concurrency-safe), NOT this per-process lock.
 * patch-gen still overlaps freely (QUANTA_BENCH_CONCURRENCY) — that's safe.
 */
let gradeInFlight = 0
const gradeWaiters: Array<() => void> = []
// HARD-CLAMPED to 1 — see above. Do NOT read the knob here; concurrent grading
// false-negatives. (Knob still parsed into runtimeConfig for telemetry only.)
const gradeLimit = (): number => 1
const withGradingLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  while (gradeInFlight >= gradeLimit()) {
    await new Promise<void>((resolve) => gradeWaiters.push(resolve))
  }
  gradeInFlight += 1
  try {
    return await fn()
  } finally {
    gradeInFlight -= 1
    // Wake every parked waiter; each re-evaluates the bound in its while-loop and
    // re-parks if still over. With small N + few waiters the herd is negligible,
    // and it guarantees no stall when >1 permit frees logically at once.
    const woken = gradeWaiters.splice(0)
    for (const w of woken) w()
  }
}

/** The harness reached its run summary ⇒ grading actually completed (vs a
 *  Docker/network crash before any verdict). */
const harnessReachedSummary = (out: string): boolean =>
  out.includes("Instances submitted:") || out.includes("Instances completed:")

/** Run `run_evaluation` (under the grading mutex) with a single transient-crash
 *  retry. Extracted from `evaluateWithPythonSwebench` to keep that function
 *  under the cognitive-complexity ceiling. A genuine patch fail keeps exit=0 +
 *  a populated report, so the retry (exit!=0 AND no resolved AND no summary)
 *  never re-runs a real fail. The 5s settle races the abort signal (the
 *  per-instance deadline can cancel it mid-sleep). */
const gradeWithRetry = async (
  spawn: Spawn,
  argv: string[],
  work: string,
  opts: PySwebenchOpts,
): Promise<{ run: SpawnResult; resolvedIds: string[]; retried: boolean }> => {
  const timeout = opts.timeoutMs ?? 1800000
  let run = await withGradingLock(() => spawn(argv, work, timeout))
  let resolvedIds = await collectResolvedIds(work)
  let retried = false
  if (run.code !== 0 && resolvedIds.length === 0 && !harnessReachedSummary(run.stdout)) {
    try {
      await abortableSleep(5000, opts.signal)
      retried = true
      run = await withGradingLock(() => spawn(argv, work, timeout))
      resolvedIds = await collectResolvedIds(work)
    } catch (e) {
      if (abortReasonOf(e) === null) throw e
      // Cancelled mid-settle: keep the first (failed) run, mark NOT retried.
    }
  }
  return { run, resolvedIds, retried }
}

export const evaluateWithPythonSwebench = async (
  instance: Instance,
  prediction: string,
  opts: PySwebenchOpts = {},
): Promise<PySwebenchResult> => {
  const meta = instance.swebench
  if (!meta) {
    return {
      resolved: false,
      gradingCompleted: false,
      log: `instance ${instance.id} has no swebench metadata`,
    }
  }
  if (prediction.trim() === "") {
    return {
      resolved: false,
      gradingCompleted: false,
      log: `empty prediction for ${meta.instanceId}`,
    }
  }

  const spawn = opts.spawn ?? defaultSpawn
  if (!(await isPythonSwebenchAvailable(opts))) {
    return {
      resolved: false,
      gradingCompleted: false,
      log: "python swebench harness unavailable (import failed)",
    }
  }
  const python = opts.probe ? pythonCandidates()[0]! : await resolvePython(spawn)
  if (!python) {
    return {
      resolved: false,
      gradingCompleted: false,
      log: "no python interpreter could import swebench",
    }
  }

  const modelName = opts.modelName ?? "quanta"
  const runId = `quanta-${meta.instanceId}-${Date.now()}`
  const work = await mkdtemp(join(benchWorkRoot(), `pyswe-${meta.instanceId}-`))
  const predictionsPath = join(work, "predictions.jsonl")
  try {
    await writeFile(
      predictionsPath,
      `${JSON.stringify({
        instance_id: meta.instanceId,
        model_name_or_path: modelName,
        model_patch: prediction,
      })}\n`,
    )
    const datasetName = opts.datasetName ?? SWEBENCH_VERIFIED_DATASET
    const harnessCfg = opts.harnessConfig ?? resolveHarnessConfig()
    const argv = buildArgv(python, predictionsPath, runId, meta.instanceId, datasetName, harnessCfg)
    const { run, resolvedIds, retried } = await gradeWithRetry(spawn, argv, work, opts)
    const resolved = resolvedIds.includes(meta.instanceId)
    const gradingCompleted = harnessReachedSummary(run.stdout)
    const tail = (s: string): string => s.slice(-1500)
    const log = [
      `cmd: ${argv.join(" ")}`,
      `exit: ${run.code}`,
      `retried: ${retried}`,
      `gradingCompleted: ${gradingCompleted}`,
      `resolved_ids: ${JSON.stringify(resolvedIds)}`,
      `stdout(tail): ${tail(run.stdout)}`,
      `stderr(tail): ${tail(run.stderr)}`,
    ].join("\n")
    return { resolved, gradingCompleted, log }
  } catch (e) {
    return {
      resolved: false,
      gradingCompleted: false,
      log: `python harness invocation failed: ${errMessage(e)}`,
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
