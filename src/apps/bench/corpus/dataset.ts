/**
 * Official SWE-bench / SWE-bench Pro dataset adapter.
 *
 * ── Why this is separate from swebench.ts ─────────────────────────────────
 * swebench.ts loads a *custom* corpus (Instance-shaped manifest + checked-out
 * repos). This file ingests the OFFICIAL upstream dataset (the snake_case
 * JSONL exported from the HuggingFace SWE-bench datasets) and turns each row
 * into a runnable `Instance` by cloning the real repo at `base_commit`.
 *
 * ── What we can and cannot do locally ─────────────────────────────────────
 * Official grading (FAIL_TO_PASS / PASS_TO_PASS over the gold `test_patch`)
 * is only valid inside the official `swebench.harness.run_evaluation` Docker
 * harness. That is environment-blocked here, so this adapter deliberately
 * does NOT attempt local grading: `toInstance` sets `testCmd: "true"` (a
 * no-op) and the real, gradeable signal is the captured `.patch`, emitted as
 * an official-format `predictions.jsonl` for the user to feed to the Docker
 * harness. We ignore the dataset's `patch` / `test_patch` / `FAIL_TO_PASS` /
 * `PASS_TO_PASS` fields for exactly this reason.
 *
 * Dependency-light per the bench brief / RFC §3.1: git runs via a tiny local
 * Bun.spawn `exec` (a copy of runner.ts's shape — NOT an import of it).
 */
import type { Instance } from "../types"

/** A single official SWE-bench task (subset of the upstream row we use). */
export interface SwebenchTask {
  instanceId: string
  repo: string
  baseCommit: string
  problemStatement: string
  environmentSetupCommit?: string
  /** The untouched upstream row, kept around for callers that need extra
   *  fields (cheap — it is already parsed). */
  raw: Record<string, unknown>
}

/** Result shape of the injected exec (mirrors runner.ts's local exec). */
export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Same signature as runner.ts's private `exec` — injected so tests stay
 *  hermetic and bench avoids an @/runtime dependency. */
export type Exec = (cmd: string, cwd: string, timeoutMs: number) => Promise<ExecResult>

/** Default `bash -c` exec via Bun.spawn with a hard timeout. Local copy of
 *  runner.ts's helper (intentionally NOT imported — bench stays self-
 *  contained per RFC §3.1). */
export const defaultExec: Exec = async (cmd, cwd, timeoutMs) => {
  const proc = Bun.spawn(["bash", "-c", cmd], {
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

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

/** Coerce one raw upstream row into a SwebenchTask, or null when a required
 *  field is missing/ill-typed (skipped, never throws). */
const toTask = (raw: Record<string, unknown>): SwebenchTask | null => {
  const instanceId = str(raw.instance_id)
  const repo = str(raw.repo)
  const baseCommit = str(raw.base_commit)
  const problemStatement = str(raw.problem_statement)
  if (!instanceId || !repo || !baseCommit || !problemStatement) return null
  const environmentSetupCommit = str(raw.environment_setup_commit)
  return {
    instanceId,
    repo,
    baseCommit,
    problemStatement,
    ...(environmentSetupCommit !== undefined ? { environmentSetupCommit } : {}),
    raw,
  }
}

/**
 * Parse official SWE-bench JSONL: one JSON object per line, OFFICIAL
 * snake_case field names (`instance_id`, `repo`, `base_commit`,
 * `problem_statement`, `environment_setup_commit`). Tolerant: blank and
 * malformed lines are skipped, rows missing any required field are skipped.
 * Never throws.
 */
export const parseSwebenchJsonl = (text: string): SwebenchTask[] => {
  const out: SwebenchTask[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    try {
      const row = JSON.parse(trimmed) as unknown
      if (typeof row !== "object" || row === null) continue
      const task = toTask(row as Record<string, unknown>)
      if (task) out.push(task)
    } catch {
      // skip malformed line
    }
  }
  return out
}

/** Check out `ref` in `destDir`, deepening a shallow clone once on failure.
 *  Throws a precise Error (with `label` for context) on any git failure. */
const checkoutOrDeepen = async (
  task: SwebenchTask,
  destDir: string,
  exec: Exec,
  ref: string,
  label: string,
  timeoutMs: number,
): Promise<void> => {
  let checkout = await exec(`git checkout -q ${ref}`, destDir, timeoutMs)
  if (checkout.code !== 0) {
    // Shallow / partial clone may not contain `ref` — deepen & retry.
    const fetch = await exec(
      `git fetch -q --unshallow || git fetch -q --depth=2147483647 origin`,
      destDir,
      timeoutMs,
    )
    if (fetch.code !== 0) {
      throw new Error(
        `git fetch (deepen) failed for ${task.instanceId} (code ${fetch.code}): ${fetch.stderr.slice(0, 500)}`,
      )
    }
    checkout = await exec(`git checkout -q ${ref}`, destDir, timeoutMs)
    if (checkout.code !== 0) {
      throw new Error(
        `git checkout ${label} (${ref}) failed for ${task.instanceId} (code ${checkout.code}): ${checkout.stderr.slice(0, 500)}`,
      )
    }
  }
}

/**
 * Produce a checked-out repo for `task` under `destDir` and return its path.
 * Clones `https://github.com/<repo>.git` (override the base via `repoBaseUrl`
 * so tests can clone a local path offline). If a shallow clone lacks a target
 * commit it deepens once via `git fetch`.
 *
 * T4 (env pre-prep, Part A): when `task.environmentSetupCommit` is present we
 * check it OUT FIRST. That is the upstream-designated commit carrying the
 * correct `setup.py`/`requirements*.txt` for the instance's toolchain — the
 * same commit the official SWE-bench Docker harness uses to build the env.
 * Materializing those files (pure git, always correct, no host mutation) lets
 * a later setup step install against the right manifest. We then check out
 * `base_commit` so the FINAL working tree is the canonical buggy tree the
 * agent must fix; the env-setup-commit's files survive only where base_commit
 * does not overwrite them (matching upstream semantics). When the field is
 * absent, behavior is byte-identical to before (base_commit checkout only).
 */
export const prepareTaskRepo = async (
  task: SwebenchTask,
  destDir: string,
  exec: Exec,
  repoBaseUrl = "https://github.com/",
  timeoutMs = 300000,
): Promise<string> => {
  const base = repoBaseUrl.endsWith("/") ? repoBaseUrl : `${repoBaseUrl}/`
  const repoUrl = `${base}${task.repo}.git`

  const clone = await exec(`git clone ${repoUrl} ${destDir}`, ".", timeoutMs)
  if (clone.code !== 0) {
    throw new Error(
      `git clone failed for ${task.instanceId} (${repoUrl}, code ${clone.code}): ${clone.stderr.slice(0, 500)}`,
    )
  }

  if (task.environmentSetupCommit !== undefined && task.environmentSetupCommit !== "") {
    await checkoutOrDeepen(
      task,
      destDir,
      exec,
      task.environmentSetupCommit,
      "environment_setup_commit",
      timeoutMs,
    )
  }
  await checkoutOrDeepen(task, destDir, exec, task.baseCommit, "base_commit", timeoutMs)
  return destDir
}

/**
 * Adapt a SwebenchTask into a runnable `Instance`. `testCmd` is `"true"`: a
 * deliberate no-op because local grading is impossible without the official
 * Docker harness (see file header). The gradeable signal is the captured
 * `.patch`, exported via `writePredictions`.
 */
export const toInstance = (task: SwebenchTask, repoPath: string): Instance => ({
  id: task.instanceId,
  repoPath,
  problemStatement: task.problemStatement,
  // `true` is the no-op LOCAL fallback (real grading is upstream-only). The
  // `swebench` block makes the produced patch officially gradeable: when
  // `QUANTA_SWEBENCH_PYTHON=1` and the harness is importable, runner.verify()
  // routes to the official `swebench.harness.run_evaluation` Docker grader
  // instead of this no-op (RFC §11 / runner.ts:252).
  testCmd: "true",
  swebench: {
    instanceId: task.instanceId,
    repo: task.repo,
    baseCommit: task.baseCommit,
    ...(task.environmentSetupCommit !== undefined
      ? { environmentSetupCommit: task.environmentSetupCommit }
      : {}),
  },
})

/** One official SWE-bench prediction row (exact shape consumed by
 *  `swebench.harness.run_evaluation`). */
export interface Prediction {
  instance_id: string
  model_name_or_path: string
  model_patch: string
}

/** Emit official SWE-bench predictions JSONL: one compact JSON object per
 *  line, trailing newline. */
export const writePredictions = async (file: string, rows: Prediction[]): Promise<void> => {
  const body = rows.map((r) => JSON.stringify(r)).join("\n")
  await Bun.write(file, rows.length === 0 ? "" : `${body}\n`)
}
