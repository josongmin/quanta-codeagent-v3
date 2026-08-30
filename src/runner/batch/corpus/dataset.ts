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
 * Git runs via the CANONICAL hardened bench exec (`../eval/exec`): tree-kill
 * deadline (jun-26) + C9 scrubbed child env. This file used to carry its own
 * "self-contained" Bun.spawn copy per the bench brief / RFC §3.1, but that
 * copy diverged from both hardenings (G3-02) — the exact drift class the
 * canonical helper's own header documents.
 */

import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { errMessage } from "@/shared"
import { quantaHomeDir } from "@/shared/quanta-home"
import { runtimeConfig } from "@/shared/runtime-config"
import { exec } from "../eval/exec"
import type { Instance } from "../types"
import { buildProjectEnvUvRunArgv } from "./project-env"
import type { RepoCheckoutSpec } from "./public-task"
import { specResolvedRunner, specRunnerKind } from "./repo-version-specs"
import {
  parseSelectedTestFilesToRun,
  selectedTestFilesVerifierCommand,
} from "./selected-test-files-verifier"
import { parseSerializedStringList } from "./string-list-literal"

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

/** Default `bash -c` exec — the canonical hardened helper (tree-kill deadline
 *  + scrubbed child env), not a local Bun.spawn copy (G3-02 consolidation). */
export const defaultExec: Exec = (cmd, cwd, timeoutMs) => exec(cmd, cwd, timeoutMs)

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
export const parseSwebenchJsonl = (
  text: string,
  normalize: (raw: Record<string, unknown>) => Record<string, unknown> = (r) => r,
): SwebenchTask[] => {
  const out: SwebenchTask[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    try {
      const row = JSON.parse(trimmed) as unknown
      if (typeof row !== "object" || row === null) continue
      const task = toTask(normalize(row as Record<string, unknown>))
      if (task) out.push(task)
    } catch {
      // skip malformed line
    }
  }
  return out
}

/**
 * Normalize a SWE-bench **Pro** (ScaleAI) row into the canonical raw shape this
 * module's downstream readers expect (RFC jun-29). Pro ships lowercase
 * `fail_to_pass`/`pass_to_pass`; {@link synthesizeTestCmd}/{@link parseTestNameList}
 * read the UPPERCASE official keys — without this mapping a Pro row yields the
 * `testCmd:"true"` no-op (fake-green risk). Originals + Pro's extra fields
 * (`dockerhub_tag`, `repo_language`, `before_repo_set_cmd`,
 * `selected_test_files_to_run`) are preserved; {@link toInstance} carries the
 * image tag + language onward. Pure — the Pro profile passes this as the
 * `parseSwebenchJsonl` normalizer.
 */
export const normalizeProRow = (raw: Record<string, unknown>): Record<string, unknown> => ({
  ...raw,
  // Guard `!= null` (not just `!== undefined`) — a JSON `null` fail_to_pass (common in
  // datasets) would otherwise copy `FAIL_TO_PASS: null`, which decodes to the no-op
  // testCmd silently (audit #8). `!= null` excludes both null and undefined.
  ...(raw.FAIL_TO_PASS === undefined && raw.fail_to_pass != null
    ? { FAIL_TO_PASS: raw.fail_to_pass }
    : {}),
  ...(raw.PASS_TO_PASS === undefined && raw.pass_to_pass != null
    ? { PASS_TO_PASS: raw.pass_to_pass }
    : {}),
})

/** Check out `ref` in `destDir`, recovering commits omitted from the mirror.
 *
 * A full bare clone still omits commits reachable only from provider-specific
 * refs (for example GitHub pull-request refs). SWE-bench Pro can legitimately
 * name one of those commits as `base_commit`. The sandbox clone's `origin` is
 * our local mirror, so deepening that origin cannot discover the omitted
 * object. After the cheap local retry, fetch the exact ref from the
 * authoritative repository URL before declaring the dataset row broken.
 */
const checkoutOrDeepen = async (
  task: RepoCheckoutSpec,
  destDir: string,
  exec: Exec,
  repoUrl: string,
  ref: string,
  label: string,
  timeoutMs: number,
): Promise<void> => {
  let checkout = await exec(`git checkout -q ${ref}`, destDir, timeoutMs)
  if (checkout.code === 0) return

  // A shallow / partial local clone may only need its existing origin deepened.
  const deepen = await exec(
    `git fetch -q --unshallow || git fetch -q --depth=2147483647 origin`,
    destDir,
    timeoutMs,
  )
  if (deepen.code === 0) {
    checkout = await exec(`git checkout -q ${ref}`, destDir, timeoutMs)
    if (checkout.code === 0) return
  }

  // `origin` points at the local mirror. Fetch the exact object from the real
  // repository to cover commits reachable only through refs the mirror did not
  // clone (e.g. GitHub refs/pull/*). Do not mutate the shared mirror: multiple
  // instances can prepare the same repository concurrently.
  const exactFetch = await exec(
    `git fetch -q --no-tags ${shellWord(repoUrl)} ${shellWord(ref)}`,
    destDir,
    timeoutMs,
  )
  if (exactFetch.code !== 0) {
    throw new Error(
      `git fetch exact ${label} (${ref}) failed for ${task.instanceId} from ${repoUrl} (code ${exactFetch.code}): ${exactFetch.stderr.slice(0, 500)}; local deepen: ${deepen.stderr.slice(0, 300)}`,
    )
  }

  checkout = await exec(`git checkout -q ${ref}`, destDir, timeoutMs)
  if (checkout.code !== 0) {
    throw new Error(
      `git checkout ${label} (${ref}) failed for ${task.instanceId} after exact upstream fetch (code ${checkout.code}): ${checkout.stderr.slice(0, 500)}`,
    )
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
  // PMX-02: the NARROW checkout role view, not the whole task. Repository
  // preparation needs identity + two git refs and nothing else, and typing it
  // that way means a caller physically cannot hand this function a gold-bearing
  // row. `SwebenchTask` still satisfies it structurally, so every existing call
  // site is unchanged.
  task: RepoCheckoutSpec,
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
      repoUrl,
      task.environmentSetupCommit,
      "environment_setup_commit",
      timeoutMs,
    )
  }
  await checkoutOrDeepen(task, destDir, exec, repoUrl, task.baseCommit, "base_commit", timeoutMs)
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
  // Pro non-Python (RFC jun-29 / audit #7): repo_language go/js/ts/java does NOT run
  // under pytest — synthesizing `uv run pytest` for a Go repo is a fake-grade vector
  // (verdict.ts would run it on a non-Python tree). Return the `"true"` no-op so the
  // harness-required guard fires (verdict.ts refuses to fake-grade swebench without the
  // authoritative harness). Verified/Live carry no repo_language ⇒ unaffected.
  const lang =
    typeof raw.repo_language === "string" ? raw.repo_language.trim().toLowerCase() : undefined
  // Treat every python spelling as python (audit EDGE-2): `python3`, `py`, `cpython`,
  // `python 3.11` must NOT be fenced as non-python (that would no-op a gradeable repo).
  const isPython =
    lang === undefined ||
    lang === "" ||
    lang.startsWith("python") ||
    lang === "py" ||
    lang === "cpython"
  if (!isPython) {
    return (
      selectedTestFilesVerifierCommand({
        repoLanguage: lang,
        selectedTestFilesToRun: raw.selected_test_files_to_run,
      }) ?? "true"
    )
  }
  const names = parseSerializedStringList(raw.FAIL_TO_PASS)
  if (names === undefined) return "true"
  const repo = typeof raw.repo === "string" ? raw.repo : ""
  const version = typeof raw.version === "string" ? raw.version : undefined
  if (specRunnerKind(repo, version) === "runtests") {
    // django-style: the spec runner already carries the correct, version-aware
    // verbosity/settings/parallel flags — use them VERBATIM, never re-add a
    // settings flag (1.9 has none, 1.10 does; the spec owns that difference).
    // Strip the leading `./` and invoke under `python`. FAIL_TO_PASS → labels.
    // specResolvedRunner (not specTestCmd) so an unmapped version of a runtests
    // repo still gets a real runtests runner instead of an empty command.
    const runner = specResolvedRunner(repo, version) ?? ""
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

/** Parse a SWE-bench test-name array field (`PASS_TO_PASS` / `FAIL_TO_PASS`) —
 *  a JSON-encoded array, a Pro Python-literal array, OR an already-decoded array
 *  of pytest node-ids / bare names. Returns the non-empty string entries, or
 *  `undefined` when absent, malformed, or empty. EVAL-ONLY use. */
export const parseTestNameList = (
  raw: Record<string, unknown>,
  key: string,
): readonly string[] | undefined => {
  return parseSerializedStringList(raw[key])
}

export const toInstance = (task: SwebenchTask, repoPath: string): Instance => {
  const goldPatch = str(task.raw.patch)
  const passToPass = parseTestNameList(task.raw, "PASS_TO_PASS")
  const version = typeof task.raw.version === "string" ? task.raw.version : undefined
  // Pro-only carry (RFC jun-29) — absent for Verified/Live ⇒ byte-identical.
  const dockerhubTag = str(task.raw.dockerhub_tag)
  const repoLanguage = str(task.raw.repo_language)
  const selectedTestFilesToRun = parseSelectedTestFilesToRun(task.raw.selected_test_files_to_run)
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
      ...(dockerhubTag !== undefined ? { dockerhubTag } : {}),
      ...(repoLanguage !== undefined ? { repoLanguage } : {}),
      ...(selectedTestFilesToRun !== undefined ? { selectedTestFilesToRun } : {}),
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
