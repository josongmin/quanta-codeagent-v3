import { basename, join } from "node:path"
import { pythonForRepoVersion, resolvePythonForRepoVersion } from "./repo-version-python"
import {
  specEvalCommands,
  specInstall,
  specPipPackages,
  specPreInstall,
} from "./repo-version-specs"

/* ── era-correct dependency pins (jun-29 SOTA++ env fix) ───────────────────────
 * The official SWE-bench env pins old-instance deps two ways: `pip_packages`
 * (explicit version pins) AND `pre_install` sed edits that CONSTRAIN deps in
 * setup.py (e.g. sphinx 3.5: `sphinxcontrib-applehelp<=1.0.7`, `markupsafe<=2.0.1`,
 * `alabaster<0.7.12`). pip_packages alone is INSUFFICIENT for sphinx 3.x/4.x: uv
 * free-resolves sphinxcontrib-applehelp 2.x → `Sphinx()` raises
 * VersionRequirementError. We extract the dep CONSTRAINTS from the pre_install
 * sed REPLACEMENTS and apply them as uv `--with` too (pure version bounds — no
 * setup.py edit / revert needed). Both sets are gated on the env using the
 * GROUND-TRUTH python: when UV_FLOOR raised the python off-era (`pythonFloored`),
 * the era pins (e.g. numpy==1.16.0) have no wheel and source-build fails, so we
 * SKIP them and free-resolve (the pre-fix behavior — no new regression). */

/** Replacement side `B` of a `sed 's/A/B/' file` command (escape-tolerant), or
 *  null when the command is not a substitution. */
const sedReplacement = (cmd: string): string | null => {
  const m = /s\/((?:[^/\\]|\\.)*)\/((?:[^/\\]|\\.)*)\//.exec(cmd)
  return m === null ? null : (m[2] ?? null)
}

/** A pip requirement with an explicit version constraint, e.g. `Jinja2<3.0`,
 *  `sphinxcontrib-applehelp<=1.0.7`, `alabaster>=0.7,<0.7.12`. */
const DEP_CONSTRAINT = /[A-Za-z][A-Za-z0-9_.-]*(?:(?:<=|>=|==|!=|<|>)[0-9][0-9A-Za-z.*]*,?)+/g

/** Distribution name (lowercased, normalized) of a requirement spec. */
const pkgName = (spec: string): string =>
  (spec.toLowerCase().match(/^[a-z0-9_.-]+/)?.[0] ?? spec.toLowerCase()).replace(/[._]+/g, "-")

/** Dep CONSTRAINTS extracted from the (repo,version) pre_install sed replacements
 *  (the official setup.py dep-cap edits, as uv `--with` constraints). */
const preInstallConstraints = (repo: string, version: string | undefined): readonly string[] => {
  const out = new Set<string>()
  for (const cmd of specPreInstall(repo, version)) {
    const repl = sedReplacement(cmd)
    if (repl === null) continue
    for (const m of repl.matchAll(DEP_CONSTRAINT)) out.add(m[0])
  }
  return [...out]
}

/** The pip EXTRA from the official `install` command (`pip install -e .[test]` →
 *  `test`), or undefined. Applied as `--with-editable '.[extra]'` so the editable
 *  install pulls the official test/dev extras the env needs — SOTA-faithful: a
 *  prior assumption that pip_packages always carries the `[test]` deps is FALSE
 *  (e.g. sphinx `[test]` = html5lib/cython/typed-ast, absent from pip_packages). */
const installExtra = (repo: string, version: string | undefined): string | undefined => {
  const m = specInstall(repo, version)?.match(/-e\s+\.\[([A-Za-z0-9_,.-]+)\]/)
  return m === null ? undefined : m?.[1]
}

/** `export KEY=VAL` env vars from the official `eval_commands` (e.g. django's
 *  LANG / LC_ALL / PYTHONIOENCODING locale exports, which flip locale-sensitive
 *  i18n tests). Folded into the exec env. Non-export commands (root-only
 *  `locale-gen`, `sed /etc/locale.gen`) are skipped. */
const evalEnvExports = (repo: string, version: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const cmd of specEvalCommands(repo, version)) {
    const m = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(cmd.trim())
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2].replace(/^["']|["']$/g, "")
  }
  return out
}

/** The era-correct `--with` pins for (repo,version): official `pip_packages`
 *  (priority) merged with the pre_install dep-caps, deduped by distribution name
 *  (a pip_packages pin wins over a pre_install constraint for the same package —
 *  e.g. `Jinja2==3.0.3` supersedes `Jinja2<3.0`). EMPTY when the env's python was
 *  FLOORED off ground truth (era pins would be unbuildable ⇒ free-resolve). */
export const specEraPins = (repo: string, version: string | undefined): readonly string[] => {
  if (resolvePythonForRepoVersion(repo, version).pythonFloored !== undefined) return []
  const pips = specPipPackages(repo, version)
  const seen = new Set(pips.map(pkgName))
  const extra = preInstallConstraints(repo, version).filter((c) => !seen.has(pkgName(c)))
  return [...pips, ...extra]
}

const BASE_PROJECT_ENV_DEPS = ["setuptools"] as const
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

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
  /** Per-command env assignments prefixed via `env KEY=VALUE uv run ...`. */
  readonly execEnv?: Readonly<Record<string, string>>
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
  /** Rebuild this editable distribution after every source reset. Required for
   * native-extension repos where uv may otherwise reuse an artifact compiled
   * from a different checkout state. */
  readonly reinstallEditable?: boolean
  /** Env-only source import rewrites materialized into matching repo files. */
  readonly sourceImportShims?: readonly RepoSourceImportShim[]
}

interface RepoSourceImportShim {
  /** Apply to files whose basename matches one of these names. */
  readonly targetBasenames: readonly string[]
  /** Import source module to rewrite FROM. */
  readonly fromModule: string
  /** Import source module to rewrite TO. */
  readonly toModule: string
}

const REPO_ENV_OVERRIDES: Record<string, RepoEnvOverride> = {
  // astropy's `setup.py` does a build-time `import extension_helpers`. Old bench
  // snapshots don't declare it for uv, so the editable build raises
  // ModuleNotFoundError. `--with` cannot fix this under uv 0.11.23 (uv builds `.`
  // before `--with` packages reach the build backend — measured); materialize it
  // into the repo's pyproject `[tool.uv.extra-build-dependencies]` instead. PyPI
  // name is the HYPHENATED `extension-helpers`; table key is the dist name `astropy`.
  //
  // Astropy's legacy setup graph then imports nested `setup_package.py` modules
  // that still do `from setuptools.dep_util import ...`. Modern editable builds
  // need setuptools >=64, but setuptools 60+ removed `dep_util`; pinning
  // `setuptools<60` is a dead end because old setuptools has no `build_editable`.
  // The env-only closure is therefore a sandbox source shim:
  // `setuptools.dep_util` → `distutils.dep_util` in `setup.py`/`setup_package.py`
  // files, reverted before diff capture so it never leaks into the candidate.
  //
  // On this macOS arm64 host, clang also rejects several legacy C extension
  // signatures in astropy's editable build as incompatible function pointers.
  // The repo-local fix is a command-local CFLAGS demotion (NOT ambient process
  // env) plus the test/runtime pins the repo's pytest entry path needs.
  "astropy/astropy": {
    pinnedDeps: ["numpy<2", "hypothesis", "pytest-astropy"],
    execEnv: {
      CFLAGS:
        "-Wno-error=incompatible-function-pointer-types -Wno-incompatible-function-pointer-types",
    },
    buildDeps: ["extension-helpers"],
    distName: "astropy",
    reinstallEditable: true,
    sourceImportShims: [
      {
        targetBasenames: ["setup.py", "setup_package.py"],
        fromModule: "setuptools.dep_util",
        toModule: "distutils.dep_util",
      },
    ],
  },
  // NOTE (jun-27): a scikit-learn/scikit-learn buildDeps override (Cython/numpy)
  // was tried + REVERTED — a single-case box smoke (scikit-14087) proved it does
  // NOT fix the no-repro: uv `--with-editable .` still fails ("Failed to resolve
  // --with requirement / build backend returned an error") and the Cython
  // C-extensions stay uncompiled ("No module named sklearn.__check_build"). The
  // real blocker is that the uv editable build can't COMPILE old scikit's
  // extensions (numpy.distutils era) — declaring build deps is insufficient.
  // The docker GRADING path builds scikit fine (14629 greened), so the fix is to
  // route repro-gen through a working build, not REPO_ENV_OVERRIDES. See
  // docs/journal/jun-27/swe-bench-verified-retrospective.md.
  // xarray still imports `np.unicode_` on older bench snapshots; numpy 2 removed
  // it. This is a RUNTIME import (module code, not the build backend), so a
  // `--with numpy<2` runtime pin is the correct mechanism, NOT a build dep.
  "pydata/xarray": {
    pinnedDeps: ["numpy<2"],
  },
}

const repoPinnedDeps = (repo: string): readonly string[] =>
  REPO_ENV_OVERRIDES[repo]?.pinnedDeps ?? []

const repoExecEnv = (repo: string): Readonly<Record<string, string>> =>
  REPO_ENV_OVERRIDES[repo]?.execEnv ?? {}

const repoSourceImportShims = (repo: string): readonly RepoSourceImportShim[] =>
  REPO_ENV_OVERRIDES[repo]?.sourceImportShims ?? []

const repoBuildDeps = (repo: string): RepoEnvOverride | undefined => {
  const ov = REPO_ENV_OVERRIDES[repo]
  if (ov?.buildDeps === undefined || ov.buildDeps.length === 0) return undefined
  return ov
}

const repoNeedsProjectEnvMaterialization = (repo: string): boolean =>
  repoBuildDeps(repo) !== undefined || repoSourceImportShims(repo).length > 0

/**
 * Shared SWE-bench project env prefix for repo-local repro / verifier commands.
 *
 * `setuptools` is forced into the `uv run` env because older repos still import
 * `pkg_resources` during module import, even when pytest itself is present.
 * `--no-project` keeps uv from switching into the repo's own project-managed
 * environment, which otherwise hides `--with` dependencies behind the project
 * layer; we install the repo explicitly via `--with-editable .` instead.
 * Repo-local compiler flags (e.g. astropy on clang) are prefixed via
 * `env KEY=VALUE uv run ...` so EVERY rail (testCmd/repro/regression) sees the
 * same command-local build env without mutating the host process.
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
  extraExecEnv: Readonly<Record<string, string>> = {},
): readonly string[] => {
  // jun-29 SOTA++ env fix: the official era pins (`pip_packages` + pre_install
  // dep-caps, e.g. sphinx 3.5 `Jinja2==3.0.3` + `sphinxcontrib-applehelp<=1.0.7`)
  // applied as `--with` so the repro/test env resolves era-correct deps instead of
  // latest — the official mechanism, no setup.py edit / build break, and skipped
  // when the python was floored off-era (see {@link specEraPins}). (A `--exclude-newer`
  // date-cutoff approach was tried + rejected — it broke the editable build.)
  const deps = [
    ...new Set([
      ...extraWith,
      ...specEraPins(repo, version),
      ...repoPinnedDeps(repo),
      ...BASE_PROJECT_ENV_DEPS,
    ]),
  ]
  const argv = [] as string[]
  // env layer: official eval_commands exports (LANG/locale) as the BASE, then the
  // caller's extraExecEnv, then the repo's build-flag overrides (later wins).
  for (const [name, value] of Object.entries({
    ...evalEnvExports(repo, version),
    ...extraExecEnv,
    ...repoExecEnv(repo),
  })) {
    if (argv.length === 0) argv.push("env")
    argv.push(`${name}=${value}`)
  }
  argv.push("uv", "run", "--no-project")
  argv.push("--python", pythonForRepoVersion(repo, version))
  const override = REPO_ENV_OVERRIDES[repo]
  if (override?.reinstallEditable === true && override.distName !== undefined) {
    // `--reinstall-package` alone can still relink uv's cached editable artifact
    // after `git clean -fdx` removed its native extensions. Native-extension
    // rematerialization must compile from the current checkout, not that cache.
    argv.push("--no-cache")
    argv.push("--reinstall-package", override.distName)
  }
  for (const dep of deps) argv.push("--with", dep)
  // editable install with the official `.[extra]` (e.g. sphinx `.[test]`) so the
  // env pulls the extras the tests import; bare `.` when the spec has no extra OR
  // the python was floored off-era (the extra's era deps may be unbuildable on the
  // floored python — consistent with the specEraPins floor gate).
  const floored = resolvePythonForRepoVersion(repo, version).pythonFloored !== undefined
  const extra = floored ? undefined : installExtra(repo, version)
  argv.push("--with-editable", extra !== undefined ? `.[${extra}]` : ".")
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
export const PROJECT_ENV_SOURCE_SHIM_BEGIN =
  "# >>> quanta-bench project-env source shim (env-only, excluded from patch) >>>"
export const PROJECT_ENV_SOURCE_SHIM_END = "# <<< quanta-bench project-env source shim <<<"
const PROJECT_ENV_SOURCE_SHIM_ORIGINAL = "# quanta-bench original: "

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

/** True iff the file currently carries one of our env-only source shim blocks. */
export const hasProjectEnvSourceShimBlock = (content: string): boolean =>
  content.includes(PROJECT_ENV_SOURCE_SHIM_BEGIN) && content.includes(PROJECT_ENV_SOURCE_SHIM_END)

/** Strip every previously-injected env-only source shim block back to its
 * original import line. Idempotent: malformed / absent blocks are left intact. */
export const stripProjectEnvSourceShimBlocks = (content: string): string => {
  const lines = content.split("\n")
  const out: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ""
    if (line.trimStart() !== PROJECT_ENV_SOURCE_SHIM_BEGIN) {
      out.push(line)
      continue
    }
    const original = lines[i + 1]
    if (original === undefined) {
      out.push(line)
      continue
    }
    const trimmedOriginal = original.trimStart()
    if (!trimmedOriginal.startsWith(PROJECT_ENV_SOURCE_SHIM_ORIGINAL)) {
      out.push(line)
      continue
    }
    let end = i + 2
    while (end < lines.length && (lines[end] ?? "").trimStart() !== PROJECT_ENV_SOURCE_SHIM_END) {
      end += 1
    }
    if (end >= lines.length) {
      out.push(line)
      continue
    }
    out.push(trimmedOriginal.slice(PROJECT_ENV_SOURCE_SHIM_ORIGINAL.length))
    i = end
  }
  return out.join("\n")
}

const renderProjectEnvSourceShimBlock = (originalLine: string, replacementLine: string): string => {
  const indent = originalLine.match(/^\s*/)?.[0] ?? ""
  return [
    `${indent}${PROJECT_ENV_SOURCE_SHIM_BEGIN}`,
    `${indent}${PROJECT_ENV_SOURCE_SHIM_ORIGINAL}${originalLine}`,
    replacementLine,
    `${indent}${PROJECT_ENV_SOURCE_SHIM_END}`,
  ].join("\n")
}

const rewriteSourceImportShim = (content: string, fromModule: string, toModule: string): string => {
  const lineRe = new RegExp(`^([ \\t]*from ${escapeRegExp(fromModule)} import [^\\n]+)$`, "gm")
  const fromClause = `from ${fromModule} import`
  const toClause = `from ${toModule} import`
  return content.replace(lineRe, (originalLine: string) =>
    renderProjectEnvSourceShimBlock(originalLine, originalLine.replace(fromClause, toClause)),
  )
}

/** Pure transform: materialize this repo's env-only source shim(s) into the
 * given file when its basename is one of the repo's targeted setup files. */
export const materializeProjectEnvSourceShimFile = (
  repo: string,
  filePath: string,
  existing: string,
): string | undefined => {
  const shims = repoSourceImportShims(repo).filter((shim) =>
    shim.targetBasenames.includes(basename(filePath)),
  )
  if (shims.length === 0) return undefined
  let next = stripProjectEnvSourceShimBlocks(existing)
  for (const shim of shims) {
    next = rewriteSourceImportShim(next, shim.fromModule, shim.toModule)
  }
  return next === existing ? undefined : next
}

const collectProjectEnvSourceShimPaths = async (
  sandbox: string,
  repo: string,
  fs: ProjectEnvSandboxFs,
): Promise<readonly string[]> => {
  const wanted = new Set(repoSourceImportShims(repo).flatMap((shim) => shim.targetBasenames))
  if (wanted.size === 0) return []
  const paths: string[] = []
  const pending = [sandbox]
  while (pending.length > 0) {
    const dir = pending.pop() as string
    for (const name of await fs.readdir(dir)) {
      if (name === ".git") continue
      const path = join(dir, name)
      if (await fs.isDirectory(path)) {
        pending.push(path)
        continue
      }
      if (wanted.has(name)) paths.push(path)
    }
  }
  return paths
}

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
  readdir: (path: string) => Promise<readonly string[]>
  isDirectory: (path: string) => Promise<boolean>
}

export interface PrepareProjectEnvResult {
  /** True iff this repo needed any env-only materialization. */
  readonly materialized: boolean
  /** Absolute pyproject path written, when build deps were materialized. */
  readonly pyprojectPath?: string
  /** Absolute setup file paths written, when source shims were materialized. */
  readonly sourceShimPaths?: readonly string[]
}

/**
 * Sandbox build-env materialization (P0). For repos whose build path needs env
 * help, inject the uv `[tool.uv.extra-build-dependencies]` table and/or apply
 * env-only source import shims BEFORE any repro/test exec.
 *
 * Contract:
 *  - ENV-ONLY: mutates only the targeted build files, and only sentinel-fenced
 *    regions whose revert path restores the original bytes.
 *  - IDEMPOTENT: safe to call repeatedly; a re-prep replaces the fenced block
 *    / shim rather than appending a duplicate copy.
 *  - MERGE-SAFE: any pre-existing `[tool.uv]` / pyproject content is preserved
 *    verbatim; the block is appended, never clobbering the repo's own tables,
 *    and non-shimmed source lines are left byte-identical.
 *  - DIFF-EXCLUDED: the block is sentinel-fenced so the candidate-capture seam
 *    strips it (see {@link revertProjectEnvSandbox} / the integrator wiring
 *    note) — these env-only mutations must NEVER reach the submitted patch.
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
  if (!repoNeedsProjectEnvMaterialization(repo)) return { materialized: false }
  let materialized = false
  let pyprojectPath: string | undefined
  const sourceShimPaths: string[] = []

  if (repoBuildDeps(repo) !== undefined) {
    const candidatePyprojectPath = join(sandbox, "pyproject.toml")
    if (await fs.exists(candidatePyprojectPath)) {
      const existing = await fs.readFile(candidatePyprojectPath)
      const next = materializeProjectEnvPyproject(repo, existing)
      if (next !== undefined && next !== existing) {
        await fs.writeFile(candidatePyprojectPath, next)
        pyprojectPath = candidatePyprojectPath
        materialized = true
      }
    }
  }

  for (const filePath of await collectProjectEnvSourceShimPaths(sandbox, repo, fs)) {
    const existing = await fs.readFile(filePath)
    const next = materializeProjectEnvSourceShimFile(repo, filePath, existing)
    if (next === undefined || next === existing) continue
    await fs.writeFile(filePath, next)
    sourceShimPaths.push(filePath)
    materialized = true
  }

  return {
    materialized,
    ...(pyprojectPath !== undefined ? { pyprojectPath } : {}),
    ...(sourceShimPaths.length > 0 ? { sourceShimPaths } : {}),
  }
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
  if (!repoNeedsProjectEnvMaterialization(repo)) return false
  let reverted = false

  if (repoBuildDeps(repo) !== undefined) {
    const pyprojectPath = join(sandbox, "pyproject.toml")
    if (await fs.exists(pyprojectPath)) {
      const existing = await fs.readFile(pyprojectPath)
      if (hasProjectEnvSandboxBlock(existing)) {
        await fs.writeFile(pyprojectPath, stripProjectEnvSandboxBlock(existing))
        reverted = true
      }
    }
  }

  for (const filePath of await collectProjectEnvSourceShimPaths(sandbox, repo, fs)) {
    const existing = await fs.readFile(filePath)
    if (!hasProjectEnvSourceShimBlock(existing)) continue
    await fs.writeFile(filePath, stripProjectEnvSourceShimBlocks(existing))
    reverted = true
  }

  return reverted
}
