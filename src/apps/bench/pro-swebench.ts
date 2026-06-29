/**
 * SWE-bench **Pro** verifier (ScaleAI) — the second grading harness (RFC jun-29).
 *
 * ── Why this is separate from python-swebench.ts ──────────────────────────
 * Pro is NOT graded by `swebench.harness.run_evaluation`. ScaleAI ships its own
 * harness (`scaleapi/SWE-bench_Pro-os`, `swe_bench_pro_eval.py`) with:
 *   - a different predictions row:  {instance_id, patch, prefix}   (not model_patch)
 *   - prebuilt per-instance images: jefzda/sweap-images:<dockerhub_tag>
 *   - a raw sample CSV input:       --raw_sample_path
 *
 * ── Conforms to the existing grade seam ───────────────────────────────────
 * It returns the SAME `PythonSwebenchResult` shape the official verifier does
 * ({resolved, gradingCompleted, breakdown?, log}) so it injects into the same
 * `VerifyDeps.pythonSwebench`/`gradeVerifier` seam with ZERO change to verdict.ts.
 *
 * ── Invariants ────────────────────────────────────────────────────────────
 * - R2: Docker spawns go through the SAME process-global {@link withGradingLock}
 *   as the official harness (Pro pulls into the same daemon — identical race).
 * - R5: NEVER throws; an unavailable harness / missing CSV / pull fail / crash
 *   all resolve to {resolved:false, gradingCompleted:false, log:<why>}.
 * - Self-contained spawn (injectable) so tests stay hermetic — no Docker/network.
 *
 * ⚠️ The exact shape of Scale's `output_dir` report is confirmed against the
 * Scale repo at run time; {@link extractProResolved} scans tolerantly and
 * fail-closes when it cannot find a definitive verdict (never a silent pass).
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { PythonSwebenchResult } from "@/runner/batch/eval/verdict"
import { abortReasonOf, errMessage, runtimeConfig } from "@/shared"
import { benchWorkRoot } from "./corpus/paths"
import type { Instance } from "./types"
import { type Spawn, defaultSpawn, withGradingLock } from "./python-swebench"

/** One Scale predictions row (exact shape consumed by `swe_bench_pro_eval.py`). */
export interface ProPredictionRow {
  instance_id: string
  patch: string
  prefix: string
}

/** Serialize Scale predictions: a JSON array (NOT JSONL). */
export const writeProPredictions = (rows: ProPredictionRow[]): string =>
  `${JSON.stringify(rows)}\n`

export interface ProSwebenchOpts {
  /** Override the process boundary (tests inject a fake). */
  spawn?: Spawn
  /** Path to the raw Pro sample CSV (`--raw_sample_path`). Required to grade. */
  rawSamplePath?: string
  /** Dir holding `swe_bench_pro_eval.py` + `run_scripts/` (the Scale harness clone). */
  harnessDir?: string
  /** `--dockerhub_username`. Default "jefzda" (the public Pro image owner). */
  dockerhubUsername?: string
  /** model_name written as the predictions `prefix`. Default "quanta". */
  modelName?: string
  /** Wall-clock budget for the harness invocation. Default 1800000 (30m). */
  timeoutMs?: number
  /** Per-instance cancellation (eval-driver deadline). */
  signal?: AbortSignal
  /** Python interpreter. Default from runtime-config or "python3". */
  pythonBin?: string
}

const HARNESS_SCRIPT = "swe_bench_pro_eval.py"
const SCRIPTS_DIR = "run_scripts"

/** Build the `swe_bench_pro_eval.py` argv (no shell ⇒ no injection).
 *
 * `--use_local_docker` is MANDATORY: the harness defaults that flag to false, which
 * selects the **Modal** (cloud) backend (`eval_fn = eval_with_docker if args.use_local_docker
 * else eval_with_modal`, verified against scaleapi/SWE-bench_Pro-os@main). Without it, a box
 * with Docker (and no Modal SDK/auth) errors EVERY instance — and Scale records every error
 * as `false` in eval_results.json, so the whole slice would read as model misses. We always
 * grade against the local Docker daemon (the same daemon the R2 grading lock serializes). */
export const buildProArgv = (
  python: string,
  harnessDir: string,
  rawSamplePath: string,
  patchPath: string,
  outDir: string,
  dockerhubUsername: string,
  numWorkers = 1,
): string[] => [
  python,
  join(harnessDir, HARNESS_SCRIPT),
  `--raw_sample_path=${rawSamplePath}`,
  `--patch_path=${patchPath}`,
  `--output_dir=${outDir}`,
  `--scripts_dir=${join(harnessDir, SCRIPTS_DIR)}`,
  `--num_workers=${numWorkers}`,
  `--dockerhub_username=${dockerhubUsername}`,
  "--use_local_docker",
]

/**
 * Scan Scale's `output_dir` for a definitive verdict on `instanceId`. Tolerant
 * across report spellings: looks in every `*.json` for the instance keyed under a
 * resolved/success flag, or in a `resolved`/`resolved_ids` array. Returns:
 *   - true                  when the instance genuinely passed,
 *   - false                 when the instance was genuinely graded-and-failed,
 *   - null (INDETERMINATE)  when NO verdict exists OR a `false` could NOT be
 *                           corroborated as a real grade (⇒ caller fail-closes to infra).
 *
 * CRITICAL (verified against scaleapi/SWE-bench_Pro-os@main): Scale records BOTH a genuine
 * test-failure AND an infrastructure error (image-pull failure, container/Modal exception)
 * as `false` in `eval_results.json` — they are INDISTINGUISHABLE in that file (every `except`
 * path does `eval_results[id] = False`, and the script always exits 0 + always writes the
 * file). Treating a bare `false` as a model miss would launder a docker/throttle infra hole
 * into a real_miss — the #1 measurement sin. The corroborating signal is the per-instance
 * output json `{output_dir}/{instance_id}/{prefix}_output.json`, which the harness writes
 * ONLY after the container's tests actually ran. So a `false` is a genuine miss IFF that file
 * exists; otherwise the instance never ran ⇒ indeterminate (null) ⇒ infra hole.
 *
 * @param prefix the predictions `prefix` (our modelName) — names the per-instance output json.
 * @internal exported for unit tests.
 */
export const extractProResolved = async (
  dir: string,
  instanceId: string,
  prefix: string,
): Promise<boolean | null> => {
  const names = await readdir(dir, { recursive: true }).catch(() => null)
  if (names === null) return null
  let sawFalse = false
  for (const rel of names as string[]) {
    if (!rel.endsWith(".json")) continue
    const verdict = resolvedFromReport(await readJsonOrNull(join(dir, rel)), instanceId)
    if (verdict === true) return true
    if (verdict === false) sawFalse = true // a `false` needs corroboration (see below)
  }
  if (!sawFalse) return null
  // Corroborate the `false`: only a real grade (tests ran) writes the per-instance output
  // json. Absent ⇒ the `false` is an infra error masquerading as a miss ⇒ null.
  return proTestsActuallyRan(names as string[], instanceId, prefix) ? false : null
}

/** Did the harness genuinely run tests for `instanceId`? True iff the per-instance output
 *  json `{instance_id}/{prefix}_output.json` is present in the scanned output tree — the
 *  harness writes it ONLY after a successful in-container run (never on an error path). */
const proTestsActuallyRan = (names: string[], instanceId: string, prefix: string): boolean => {
  const marker = join(instanceId, `${prefix}_output.json`)
  return names.some((rel) => rel === marker || rel.endsWith(`/${marker}`))
}

/** Read + JSON-parse a file, or null on any read/parse error (extracted to keep
 *  {@link extractProResolved} under the cognitive-complexity ratchet, R7). */
const readJsonOrNull = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown
  } catch {
    return null
  }
}

/** Shape A: a per-instance entry `{ "<id>": bool | { resolved: bool } }`. Returns the
 *  explicit verdict, or null when absent / not a clear verdict (extracted to keep
 *  {@link resolvedFromReport} under the complexity ratchet, R7). */
const shapeAVerdict = (rec: Record<string, unknown>, instanceId: string): boolean | null => {
  if (!(instanceId in rec)) return null
  const v = rec[instanceId]
  if (typeof v === "boolean") return v
  if (typeof v === "object" && v !== null) {
    const r = (v as Record<string, unknown>).resolved
    if (typeof r === "boolean") return r
  }
  return null
}

/** Pull a resolved verdict for `instanceId` out of one parsed report, or null. */
const resolvedFromReport = (report: unknown, instanceId: string): boolean | null => {
  if (typeof report !== "object" || report === null) return null
  const rec = report as Record<string, unknown>
  const shapeA = shapeAVerdict(rec, instanceId)
  if (shapeA !== null) return shapeA
  // Shape B: { resolved_ids: [...] } / { resolved: [...] } / { resolved_instances: [...] }.
  // Membership ⇒ TRUE. ABSENCE ⇒ null (INDETERMINATE), NOT false: a resolved-ids list
  // that omits our instance does NOT prove the instance was attempted-and-missed — it
  // may have been skipped (image-pull fail, Scale silently dropped it). Returning false
  // here would let verdict.ts class an unattempted instance as a real_miss — the exact
  // throttle-miss confound this RFC fights (audit #5). An explicit per-instance
  // {resolved:false} (Shape A) is the ONLY path to a definitive false.
  for (const key of ["resolved_ids", "resolved_instances", "resolved"]) {
    const v = rec[key]
    if (Array.isArray(v)) return v.includes(instanceId) ? true : null
  }
  return null
}

const proResult = (
  resolved: boolean,
  gradingCompleted: boolean,
  log: string,
): PythonSwebenchResult => ({ resolved, gradingCompleted, log })

/**
 * Grade one Pro instance's `prediction` with the Scale harness. Returns the
 * standard `PythonSwebenchResult` so it injects into the same grade seam.
 * NEVER throws (R5).
 */
export const evaluateWithProSwebench = async (
  instance: Instance,
  prediction: string,
  opts: ProSwebenchOpts = {},
): Promise<PythonSwebenchResult> => {
  const meta = instance.swebench
  if (!meta) return proResult(false, false, `instance ${instance.id} has no swebench metadata`)
  if (prediction.trim() === "") return proResult(false, false, `empty prediction for ${meta.instanceId}`)

  // Opts-driven (the Pro profile injects these from its KnobSchema — R3, no global
  // config read in the verifier itself).
  const rawSamplePath = opts.rawSamplePath
  const harnessDir = opts.harnessDir
  if (!rawSamplePath || !harnessDir) {
    // R5: requested Pro grading but the harness/CSV is not wired ⇒ fail loud, never
    // silently degrade. The eval seam classifies gradingCompleted:false as infra.
    return proResult(
      false,
      false,
      "Pro harness not wired: set QUANTA_SWEBENCH_PRO_HARNESS_DIR + QUANTA_SWEBENCH_PRO_RAW_SAMPLE_PATH (scaleapi/SWE-bench_Pro-os).",
    )
  }

  const spawn = opts.spawn ?? defaultSpawn
  const python = opts.pythonBin ?? runtimeConfig().swebenchPythonBin ?? "python3"
  const dockerhubUsername = opts.dockerhubUsername ?? "jefzda"
  const modelName = opts.modelName ?? "quanta"
  const timeout = opts.timeoutMs ?? 1800000

  const work = await mkdtemp(join(benchWorkRoot(), `pro-${meta.instanceId}-`))
  const patchPath = join(work, "predictions.json")
  const outDir = join(work, "out")
  try {
    await writeFile(
      patchPath,
      writeProPredictions([{ instance_id: meta.instanceId, patch: prediction, prefix: modelName }]),
    )
    const argv = buildProArgv(python, harnessDir, rawSamplePath, patchPath, outDir, dockerhubUsername)
    // R2: same process-global grading chain as the official harness.
    // CWD MUST be harnessDir, NOT the temp `work` dir: swe_bench_pro_eval.py reads the
    // per-instance env Dockerfiles via the hardcoded RELATIVE path
    // `dockerfiles/{base,instance}_dockerfile/<id>/Dockerfile` (create_entryscript). With
    // cwd=work those don't resolve ⇒ FileNotFoundError ⇒ the harness records EVERY instance
    // (even gold) as False ⇒ systematic gold-fail/grader_invalid (measured: Pro 5/5 gold-fail).
    // All argv paths (patch_path/output_dir/raw_sample_path/scripts_dir) are absolute, so the
    // cwd change is otherwise inert.
    let run: { code: number; stdout: string; stderr: string }
    try {
      run = await withGradingLock(() => spawn(argv, harnessDir, timeout))
    } catch (e) {
      if (abortReasonOf(e) !== null) return proResult(false, false, `pro grade cancelled: ${errMessage(e)}`)
      throw e
    }
    const verdict = await extractProResolved(outDir, meta.instanceId, modelName)
    // gradingCompleted is derived ONLY from a found verdict — NEVER from stdout banner
    // guessing. A crashed harness routinely echoes its argv (`--output_dir=…`), so any
    // stdout-substring summary check would misread an immediate crash as "completed" and
    // let verdict.ts class it as a clean real_miss instead of infra (audit #6, fail-open).
    // No verdict ⇒ indeterminate ⇒ gradingCompleted:false ⇒ infra hole (correct).
    const gradingCompleted = verdict !== null
    const resolved = verdict === true
    const tail = (s: string): string => s.slice(-1500)
    const log = [
      `cmd: ${argv.join(" ")}`,
      `exit: ${run.code}`,
      `verdict: ${verdict === null ? "INDETERMINATE (fail-closed)" : verdict}`,
      `gradingCompleted: ${gradingCompleted}`,
      `stdout(tail): ${tail(run.stdout)}`,
      `stderr(tail): ${tail(run.stderr)}`,
    ].join("\n")
    return proResult(resolved, gradingCompleted, log)
  } catch (e) {
    return proResult(false, false, `pro harness invocation failed: ${errMessage(e)}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
