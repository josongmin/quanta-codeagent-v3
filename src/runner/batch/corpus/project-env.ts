import { join } from "node:path"
import { pythonForRepoVersion } from "./repo-version-python"

const BASE_PROJECT_ENV_DEPS = ["setuptools"] as const

/**
 * Per-repo env-prep override (NOT answer-key logic): each entry compensates for
 * a known import/build failure of a repo's OLD bench snapshot under uv, keyed on
 * the exact `owner/name` slug. This is dependency materialization, not source-
 * path/keyword matching against the gold patch.
 *
 * Two DISTINCT mechanisms, because uv resolves them at different times:
 *
 *  - `pinnedDeps`  → RUNTIME pins, emitted as `uv run --with <dep>`. Correct for
 *    a dep the repo's MODULE CODE imports at runtime (e.g. xarray imports
 *    `np.unicode_`, removed in numpy 2 → pin `numpy<2`). These are importable by
 *    the time the repo's code runs.
 *
 *  - `buildDeps`   → BUILD-TIME pins, materialized into the repo's
 *    `pyproject.toml` `[tool.uv.extra-build-dependencies]` table at sandbox-prep
 *    time (see {@link prepareProjectEnvSandbox}). Correct for a dep the repo's
 *    `setup.py`/build backend IMPORTS AT BUILD TIME (e.g. astropy's `setup.py`
 *    does `import extension_helpers`). `--with` does NOT work here: uv builds the
 *    editable `.` target BEFORE `--with` packages are importable by the
 *    setuptools build backend, so a build-time `import` still raises
 *    `ModuleNotFoundError`. Validated empirically (uv 0.11.x): `--with
 *    extension_helpers --with-editable .` FAILS on a package whose `setup.py`
 *    imports `extension_helpers`; injecting `[tool.uv.extra-build-dependencies]`
 *    makes it BUILD-OK. The table KEY is the project's DISTRIBUTION name
 *    (`distName`), the values are PyPI names (note `extension-helpers` HYPHEN).
 *
 * Each entry carries a one-line comment naming the failing import it fixes so a
 * future reader can verify it against current snapshots and retire it once the
 * official dependency authority makes it unnecessary.
 */
interface RepoEnvOverride {
  /** Runtime `--with <dep>` pins forced into the uv `run` env. */
  readonly pinnedDeps?: readonly string[]
  /**
   * Build-time deps materialized into `pyproject.toml`'s
   * `[tool.uv.extra-build-dependencies]` table. Requires {@link distName}.
   */
  readonly buildDeps?: readonly string[]
  /**
   * The project's distribution name — the KEY under
   * `[tool.uv.extra-build-dependencies]`. Required iff `buildDeps` is set.
   * This is the dist name (`astropy`), NOT the import name of the build dep.
   */
  readonly distName?: string
}

const REPO_ENV_OVERRIDES: Record<string, RepoEnvOverride> = {
  // astropy's `setup.py` does a build-time `import extension_helpers`. Old bench
  // snapshots don't declare it for uv, so the editable build raises
  // ModuleNotFoundError. `--with` cannot fix this (uv builds `.` before `--with`
  // packages are importable by the build backend); materialize it into the repo's
  // pyproject `[tool.uv.extra-build-dependencies]` instead. PyPI name is the
  // HYPHENATED `extension-helpers`; table key is the dist name `astropy`.
  "astropy/astropy": {
    buildDeps: ["extension-helpers"],
    distName: "astropy",
  },
  // xarray still imports `np.unicode_` on older bench snapshots; numpy 2 removed
  // it. This is a RUNTIME import (module code, not the build backend), so a
  // `--with numpy<2` runtime pin is the correct mechanism, NOT a build dep.
  "pydata/xarray": {
    pinnedDeps: ["numpy<2"],
  },
}

const repoPinnedDeps = (repo: string): readonly string[] =>
  REPO_ENV_OVERRIDES[repo]?.pinnedDeps ?? []

const repoBuildDeps = (repo: string): RepoEnvOverride | undefined => {
  const ov = REPO_ENV_OVERRIDES[repo]
  if (ov?.buildDeps === undefined || ov.buildDeps.length === 0) return undefined
  return ov
}

/**
 * Shared SWE-bench project env prefix for repo-local repro / verifier commands.
 *
 * `setuptools` is forced into the `uv run` env because older repos still import
 * `pkg_resources` during module import, even when pytest itself is present.
 * `--no-project` keeps uv from switching into the repo's own project-managed
 * environment, which otherwise hides `--with` dependencies behind the project
 * layer; we install the repo explicitly via `--with-editable .` instead.
 *
 * BUILD-time deps (e.g. astropy's `extension_helpers`) are NOT emitted here —
 * they are materialized into `pyproject.toml` by {@link prepareProjectEnvSandbox}
 * at sandbox-prep time, because `--with` does not reach the build backend. This
 * argv therefore carries NO `--no-build-isolation` flag for those repos: the
 * pyproject `extra-build-dependencies` table works WITH normal build isolation.
 */
export const buildProjectEnvUvRunArgv = (
  repo: string,
  version: string | undefined,
  extraWith: readonly string[] = [],
): readonly string[] => {
  const deps = [...new Set([...extraWith, ...repoPinnedDeps(repo), ...BASE_PROJECT_ENV_DEPS])]
  const argv = [
    "uv",
    "run",
    "--no-project",
    "--python",
    pythonForRepoVersion(repo, version),
  ] as string[]
  for (const dep of deps) argv.push("--with", dep)
  argv.push("--with-editable", ".")
  return argv
}

/**
 * Sentinel markers fencing the build-dep table THIS harness injects into a
 * repo's `pyproject.toml`. They serve two jobs:
 *
 *  1. Idempotency — a re-prep replaces the fenced block instead of appending a
 *     duplicate `[tool.uv.extra-build-dependencies]` table.
 *  2. Diff-exclusion — {@link stripProjectEnvSandboxBlock} removes EXACTLY the
 *     fenced region (and nothing else) before the candidate patch is captured,
 *     so this env-only mutation never leaks into the submitted diff while any
 *     genuine agent edit to the SAME file survives untouched.
 *
 * The markers are TOML comments so a partially-stripped file (defensive) is
 * still valid TOML.
 */
export const PROJECT_ENV_SANDBOX_BEGIN =
  "# >>> quanta-bench project-env build deps (env-only, excluded from patch) >>>"
export const PROJECT_ENV_SANDBOX_END = "# <<< quanta-bench project-env build deps <<<"

/** Build the fenced TOML block for a repo's build deps. The table KEY is the
 *  project's dist name; values are PyPI requirement strings. */
const renderProjectEnvBlock = (distName: string, buildDeps: readonly string[]): string => {
  const values = buildDeps.map((d) => JSON.stringify(d)).join(", ")
  return [
    PROJECT_ENV_SANDBOX_BEGIN,
    "[tool.uv.extra-build-dependencies]",
    `${distName} = [${values}]`,
    PROJECT_ENV_SANDBOX_END,
  ].join("\n")
}

/**
 * Remove EXACTLY one previously-injected sandbox block (and its surrounding
 * blank-line padding) from a pyproject's text, leaving every other byte intact.
 * Idempotent: returns the input unchanged when no marker pair is present.
 *
 * Used by {@link prepareProjectEnvSandbox} (re-prep → replace, not duplicate)
 * and by the diff-exclusion path before candidate capture.
 */
export const stripProjectEnvSandboxBlock = (content: string): string => {
  const begin = content.indexOf(PROJECT_ENV_SANDBOX_BEGIN)
  if (begin === -1) return content
  const endMarker = content.indexOf(PROJECT_ENV_SANDBOX_END, begin)
  if (endMarker === -1) return content
  const endLine = endMarker + PROJECT_ENV_SANDBOX_END.length
  // Absorb the newline(s) we inserted before the block (so a re-prep round-trips
  // to byte-identical) and a single trailing newline after it.
  let head = content.slice(0, begin)
  head = head.replace(/\n*$/, "")
  let tail = content.slice(endLine)
  tail = tail.replace(/^\n/, "")
  if (head === "" && tail === "") return ""
  if (head === "") return tail
  if (tail === "") return `${head}\n`
  return `${head}\n${tail}`
}

/** True iff a repo's pyproject text currently carries our injected block. */
export const hasProjectEnvSandboxBlock = (content: string): boolean =>
  content.includes(PROJECT_ENV_SANDBOX_BEGIN) && content.includes(PROJECT_ENV_SANDBOX_END)

/** Pure transform: given the existing pyproject text (possibly ""), return the
 *  text with the repo's build-dep block injected idempotently, or `undefined`
 *  when the repo needs no build deps. Stripping any prior block first makes a
 *  re-prep replace-not-duplicate AND tolerates a manually-edited stale block. */
export const materializeProjectEnvPyproject = (
  repo: string,
  existing: string,
): string | undefined => {
  const ov = repoBuildDeps(repo)
  if (ov?.buildDeps === undefined || ov.distName === undefined) return undefined
  const base = stripProjectEnvSandboxBlock(existing)
  // Guard against producing a DUPLICATE `[tool.uv.extra-build-dependencies]`
  // table. If the repo's OWN pyproject already declares one (after stripping any
  // prior block of OURS), appending a second is invalid TOML (table redefinition)
  // — uv would reject the whole file. Current overrides (astropy old snapshots)
  // never ship this table, so we no-op rather than corrupt: the repo already owns
  // its build-dep authority, and emitting broken TOML would be strictly worse than
  // leaving it. (If a future snapshot needs merge-INTO an existing table, that is
  // a deliberate follow-up, not a silent clobber.)
  if (base.includes("[tool.uv.extra-build-dependencies]")) return undefined
  const block = renderProjectEnvBlock(ov.distName, ov.buildDeps)
  if (base.trim() === "") return `${block}\n`
  const sep = base.endsWith("\n") ? "\n" : "\n\n"
  return `${base}${sep}${block}\n`
}

/** Minimal sandbox surface this module needs — a thin fs port so the heavy
 *  e2e can drive a real temp dir while unit tests can inject a fake. */
export interface ProjectEnvSandboxFs {
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
}

export interface PrepareProjectEnvResult {
  /** True iff this repo needed build-dep materialization. */
  readonly materialized: boolean
  /** Absolute path written, when `materialized`. */
  readonly pyprojectPath?: string
}

/**
 * Sandbox build-env materialization (P0). For repos whose build backend imports
 * a dep at BUILD time, inject the uv `[tool.uv.extra-build-dependencies]` table
 * into the checked-out repo's `pyproject.toml` BEFORE any repro/test exec.
 *
 * Contract:
 *  - ENV-ONLY: mutates only `pyproject.toml`, and only the fenced block.
 *  - IDEMPOTENT: safe to call repeatedly; a re-prep replaces the fenced block
 *    rather than appending a duplicate table.
 *  - MERGE-SAFE: any pre-existing `[tool.uv]` / pyproject content is preserved
 *    verbatim; the block is appended, never clobbering the repo's own tables.
 *  - DIFF-EXCLUDED: the block is sentinel-fenced so the candidate-capture seam
 *    strips it (see {@link revertProjectEnvSandbox} / the integrator wiring
 *    note) — this mutation must NEVER reach the submitted patch.
 *
 * No-op (returns `{materialized:false}`) for repos without build deps, or when
 * the repo has no `pyproject.toml` (uv `extra-build-dependencies` requires one;
 * a setup.py-only repo without pyproject is out of scope and left untouched —
 * we never fabricate a pyproject because that itself WOULD be a leaked patch).
 */
export const prepareProjectEnvSandbox = async (
  sandbox: string,
  repo: string,
  fs: ProjectEnvSandboxFs,
): Promise<PrepareProjectEnvResult> => {
  if (repoBuildDeps(repo) === undefined) return { materialized: false }
  const pyprojectPath = join(sandbox, "pyproject.toml")
  if (!(await fs.exists(pyprojectPath))) return { materialized: false }
  const existing = await fs.readFile(pyprojectPath)
  const next = materializeProjectEnvPyproject(repo, existing)
  if (next === undefined || next === existing) return { materialized: false }
  await fs.writeFile(pyprojectPath, next)
  return { materialized: true, pyprojectPath }
}

/**
 * Diff-exclusion: strip the injected block back out of `pyproject.toml` so the
 * candidate patch captured by `git add -A && git diff --cached` does NOT carry
 * this env-only mutation. Surgical — only the fenced block is removed; a genuine
 * agent edit elsewhere in the same file survives. Idempotent / no-op when the
 * file or block is absent.
 *
 * The integrator calls this immediately BEFORE candidate capture (see snapshot
 * seam), OR — equivalently — captures the diff from the base-committed pyproject
 * by resetting just this path. We expose the surgical revert because it preserves
 * concurrent agent edits, which a blind `git checkout -- pyproject.toml` would
 * destroy.
 */
export const revertProjectEnvSandbox = async (
  sandbox: string,
  repo: string,
  fs: ProjectEnvSandboxFs,
): Promise<boolean> => {
  if (repoBuildDeps(repo) === undefined) return false
  const pyprojectPath = join(sandbox, "pyproject.toml")
  if (!(await fs.exists(pyprojectPath))) return false
  const existing = await fs.readFile(pyprojectPath)
  if (!hasProjectEnvSandboxBlock(existing)) return false
  await fs.writeFile(pyprojectPath, stripProjectEnvSandboxBlock(existing))
  return true
}
