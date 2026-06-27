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
 * harness. The adapter preserves the upstream gold `patch` as metadata for
 * evaluator sanity checks, but it is never included in the agent prompt.
 *
 * Dependency-light per the bench brief / RFC §3.1: git runs via a tiny local
 * Bun.spawn `exec` (a copy of runner.ts's shape — NOT an import of it).
 */

import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { errMessage } from "@/shared"
import { quantaHomeDir } from "@/shared/quanta-home"
import { runtimeConfig } from "@/shared/runtime-config"
import type { Instance } from "../types"
import { buildProjectEnvUvRunArgv } from "./project-env"
import { specRunnerKind, specTestCmd } from "./repo-version-specs"

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
const DEFAULT_REPO_BASE_URL = "https://github.com/"

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

/** Reap orphaned `*.git.tmp-<uuid>` bare-mirror dirs left by a clone that was
 *  SIGTERM'd before its atomic rename. AGE-GATED: only temps older than the max
 *  plausible in-flight clone are swept, so a concurrent same-repo instance's live
 *  temp (minutes old at most) is never raced. Best-effort: any fs error is ignored.
 *  @internal exported for unit tests. */
const ORPHAN_TMP_MAX_AGE_MS = 6 * 60 * 60 * 1000
export const reapStaleMirrorTemps = async (repoCacheRoot: string): Promise<void> => {
  const now = Date.now()
  const entries = await readdir(repoCacheRoot).catch(() => [] as string[])
  for (const name of entries) {
    if (!name.includes(".git.tmp-")) continue
    const p = join(repoCacheRoot, name)
    const st = await stat(p).catch(() => null)
    if (st !== null && now - st.mtimeMs > ORPHAN_TMP_MAX_AGE_MS) {
      await rm(p, { recursive: true, force: true }).catch(() => {})
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
  repoBaseUrl = DEFAULT_REPO_BASE_URL,
  timeoutMs = 300000,
): Promise<string> => {
  const base = repoBaseUrl.endsWith("/") ? repoBaseUrl : `${repoBaseUrl}/`
  const repoUrl = `${base}${task.repo}.git`

  // Persistent FULL bare-mirror cache. A blobless partial clone breaks LSP:
  // pyright indexes the whole workspace and a missing blob triggers a per-file
  // lazy fetch, so grounding/localize never finishes. A full clone, conversely,
  // is hundreds of MB of network PER INSTANCE. The cache squares the circle: the
  // network full-clone happens at most ONCE per repo (into a bare mirror), and
  // each instance sandbox is a fast LOCAL clone from it — every blob present, so
  // pyright indexes normally. Override the cache dir via
  // QUANTA_SWEBENCH_REPO_CACHE; a `file://` repoBaseUrl already-local stays fast.
  const repoCacheRoot =
    runtimeConfig().swebenchRepoCacheDir ?? join(quantaHomeDir(), "bench", "repo-cache")
  const repoCacheName =
    base === DEFAULT_REPO_BASE_URL
      ? task.repo.replace("/", "__")
      : `${task.repo.replace("/", "__")}--${createHash("sha256").update(repoUrl).digest("hex").slice(0, 12)}`
  const mirror = join(repoCacheRoot, `${repoCacheName}.git`)
  if (!existsSync(mirror)) {
    await mkdir(repoCacheRoot, { recursive: true })
    // Atomic create to avoid a concurrent-instance TOCTOU on the SHARED mirror
    // (audit R2: same-repo instances under QUANTA_BENCH_CONCURRENCY>1 both pass
    // the existsSync check and race `git clone --bare` into the same path). Clone
    // into a per-call unique temp, then atomically rename into place; if another
    // instance won, our rename throws (target exists) ⇒ discard ours and use theirs.
    // `tmp` and `mirror` share parent `repoCacheRoot` so the rename is intra-dir
    // (no EXDEV). A SIGTERM (the bench deadline kills aggressively) between the clone
    // success and the rename can orphan a `*.tmp-<uuid>` dir; reap stale ones here,
    // AGE-GATED so a concurrent same-repo instance's still-live tmp is never raced.
    await reapStaleMirrorTemps(repoCacheRoot)
    const tmp = `${mirror}.tmp-${randomUUID()}`
    const m = await exec(`git clone --bare ${repoUrl} ${tmp}`, ".", timeoutMs)
    if (m.code !== 0) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
      throw new Error(
        `bare mirror clone failed for ${task.instanceId} (${repoUrl}, code ${m.code}): ${m.stderr.slice(0, 500)}`,
      )
    }
    try {
      await rename(tmp, mirror)
    } catch (renameErr) {
      // The ONLY benign rename failure is "another instance already published the
      // mirror" — detect that by the target now existing, then discard our tmp.
      // Any other failure (permissions, ENOSPC, …) is real: surface it instead of
      // masking it behind a downstream `git clone failed`.
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
      if (!existsSync(mirror)) {
        throw new Error(
          `bare mirror publish (rename) failed for ${task.instanceId} (${repoUrl}): ${errMessage(renameErr)}`,
        )
      }
    }
  }
  const clone = await exec(`git clone ${mirror} ${destDir}`, ".", timeoutMs)
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
 * Adapt a SwebenchTask into a runnable `Instance`. `testCmd` is auto-synthesized
 * from `FAIL_TO_PASS` when present (Docker-free local grading via pytest in the
 * sandbox's own venv — same env_install as Docker, minus image layer). Fallback
 * to `"true"` when FAIL_TO_PASS is missing/empty so callers that depend on the
 * historical no-op shape stay byte-identical.
 *
 * When `QUANTA_SWEBENCH_PYTHON=1` and the official harness is importable,
 * `runner.verify()` still routes to the Docker grader (RFC §11) — testCmd is
 * the FALLBACK path only. With Docker OFF, pytest runs the exact FAIL_TO_PASS
 * tests in the sandbox; ImportError/test failure surfaces correctly.
 */
/**
 * Build the argv to run a repro script under the SAME project env the synthesized
 * `testCmd` uses. A bare `python3 <script>` on the box host cannot `import` the
 * target project (it is NOT pip-installed there — only the per-instance Docker
 * image and this uvx ephemeral env carry it), so every Agentless repro hit
 * ModuleNotFoundError and the primary rail never fired. Mirrors
 * `synthesizeTestCmd`'s env strategy: `uv run --with-editable .` installs the repo
 * (from the sandbox cwd's setup.py/pyproject) + resolves transitive deps; the
 * first sample pays the build, the rest hit uv's cache. `repo === ""` (non-
 * SWE-bench fixtures) ⇒ caller should NOT use this (bare python3 is correct).
 *
 * `version` selects the CPython minor via {@link pythonForRepoVersion} (RCA
 * jun-20: a static per-repo python forced django 5.0 onto 3.9 → `No solution
 * found`, and old scikit-learn onto 3.10 → numpy build fail; ~13% of repros).
 */
export const reproRunArgv = (
  repo: string,
  version: string | undefined,
  scriptPath: string,
): readonly string[] => {
  // `pytest` MUST be in the repro exec env: P1 (jun-23) made repros real pytest
  // tests whose verdict is the process exit code, via a `pytest.main([__file__])`
  // footer run under `python <script>`. Without `--with pytest` the footer's
  // `import pytest` raises ModuleNotFoundError ⇒ every repro is `exec_failed`
  // (measured on the box re-measure: django repros all crashed on `import pytest`).
  return [
    ...buildProjectEnvUvRunArgv(repo, version, ["pytest"], {
      PYTEST_ADDOPTS: "",
      PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1",
      PYTHONNOUSERSITE: "1",
    }),
    "python",
    "-s",
    scriptPath,
  ]
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`
const shellWord = (s: string): string => (/^[A-Za-z0-9_./:=+-]+$/.test(s) ? s : shellQuote(s))

const djangoRuntestsLabel = (name: string): string => {
  const unittestStyle = name.match(/^([A-Za-z_]\w*) \(([^)]+)\)$/)
  if (unittestStyle !== null) return `${unittestStyle[2]}.${unittestStyle[1]}`
  const parts = name.split("::")
  const pathPart = parts[0]
  if (pathPart === undefined) return name
  const nodeParts = parts.slice(1)
  if (pathPart.endsWith(".py")) {
    const modulePath = pathPart
      .replace(/^tests\//, "")
      .replace(/\.py$/, "")
      .replace(/\//g, ".")
    return [modulePath, ...nodeParts].filter((part) => part.trim() !== "").join(".")
  }
  return name
}

/** Synthesize the per-instance test command from FAIL_TO_PASS. The RUNNER is
 *  derived from the SWE-bench spec SSOT. The RUNNER KIND comes from
 *  `specRunnerKind` (the ONE place runner-name knowledge lives) — no per-repo or
 *  per-runner-name literal here: a "runtests" repo (django) gets its spec runner +
 *  dotted-module labels; everything else uses the uniform pytest node-id/`-k`
 *  path. The FAIL_TO_PASS names are the grading answer key (existing oracle
 *  behavior) and are appended here. */
export const synthesizeTestCmd = (raw: Record<string, unknown>): string => {
  const names = decodeTestNameList(raw.FAIL_TO_PASS)
  if (names === undefined) return "true"
  const repo = typeof raw.repo === "string" ? raw.repo : ""
  const version = typeof raw.version === "string" ? raw.version : undefined
  if (specRunnerKind(repo, version) === "runtests") {
    // django-style: the spec runner already carries the correct, version-aware
    // verbosity/settings/parallel flags — use them VERBATIM, never re-add a
    // settings flag (1.9 has none, 1.10 does; the spec owns that difference).
    // Strip the leading `./` and invoke under `python`. FAIL_TO_PASS → labels.
    const runner = specTestCmd(repo, version) ?? ""
    const prefix = buildProjectEnvUvRunArgv(repo, version, ["pytest"], {
      PYTEST_ADDOPTS: "",
      PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1",
      PYTHONNOUSERSITE: "1",
    })
      .map(shellWord)
      .join(" ")
    const runnerArgs = runner.replace(/^\.\//, "")
    const labels = names.map((name) => shellQuote(djangoRuntestsLabel(name)))
    return `${prefix} python ${runnerArgs} ${labels.join(" ")}`
  }
  // FAIL_TO_PASS values vary by repo:
  //   - "tests/test_x.py::test_y"           → pytest node id (use as path)
  //   - "tests/test_x.py::TestClass::test_y" → also a node id
  //   - "test_encode_morse"                  → bare test name (sympy style)
  //   - "path/to/test_file.py"               → just a file
  // Strategy: if value contains `::` OR `/` (path-like), pass as positional
  // arg verbatim. If it's a bare identifier, collect into a single `-k`
  // keyword expression (`pytest -k 'name1 or name2'`). Both can appear in
  // the same array — split into two groups and pass both.
  const isNodeIdLike = (n: string): boolean => n.includes("::") || n.includes("/")
  const nodeIds = names.filter(isNodeIdLike)
  const keywords = names.filter((n) => !isNodeIdLike(n))
  const parts: string[] = []
  for (const n of nodeIds) parts.push(shellQuote(n))
  if (keywords.length > 0) {
    // pytest -k accepts boolean expression over substrings. Join with " or "
    // so any matching test triggers; quote the whole expression so the shell
    // treats it as one argument.
    parts.push("-k", shellQuote(keywords.join(" or ")))
  }
  // `uv run` pulls deps + pytest into a cached ephemeral env so the sandbox
  // doesn't need its own venv. `--with setuptools` keeps `pkg_resources`-era imports
  // alive; `--with-editable .` installs the repo at the sandbox's cwd from its
  // `setup.py` / `pyproject.toml` so pip resolves transitive deps.
  // First call per (python ver, repo, base commit) pays the build cost;
  // subsequent calls hit uv's cache (~ms).
  const prefix = buildProjectEnvUvRunArgv(repo, version, ["pytest"], {
    PYTEST_ADDOPTS: "",
  })
    .map(shellWord)
    .join(" ")
  return `${prefix} pytest -x --no-header ${parts.join(" ")}`
}

const decodeTestNameList = (value: unknown): readonly string[] | undefined => {
  let parsed: unknown
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value)
    } catch {
      return undefined
    }
  } else {
    parsed = value
  }
  if (!Array.isArray(parsed)) return undefined
  const names = parsed.filter((t): t is string => typeof t === "string" && t.length > 0)
  return names.length > 0 ? names : undefined
}

/** Parse a SWE-bench test-name array field (`PASS_TO_PASS` / `FAIL_TO_PASS`) —
 *  a JSON-encoded string array OR an already-decoded array of pytest node-ids /
 *  bare names. Returns the non-empty string entries, or `undefined` when the
 *  field is absent, malformed, or empty (so callers omit it rather than
 *  threading `[]`). EVAL-ONLY use. */
export const parseTestNameList = (
  raw: Record<string, unknown>,
  key: string,
): readonly string[] | undefined => {
  return decodeTestNameList(raw[key])
}

export const toInstance = (task: SwebenchTask, repoPath: string): Instance => {
  const goldPatch = str(task.raw.patch)
  const passToPass = parseTestNameList(task.raw, "PASS_TO_PASS")
  const version = typeof task.raw.version === "string" ? task.raw.version : undefined
  return {
    id: task.instanceId,
    repoPath,
    problemStatement: task.problemStatement,
    testCmd: synthesizeTestCmd(task.raw),
    ...(goldPatch !== undefined ? { goldPatch } : {}),
    swebench: {
      instanceId: task.instanceId,
      repo: task.repo,
      baseCommit: task.baseCommit,
      ...(version !== undefined ? { version } : {}),
      ...(task.environmentSetupCommit !== undefined
        ? { environmentSetupCommit: task.environmentSetupCommit }
        : {}),
      ...(passToPass !== undefined ? { passToPass } : {}),
    },
  }
}

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
