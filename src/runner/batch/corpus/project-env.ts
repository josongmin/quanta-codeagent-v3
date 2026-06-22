import { pythonForRepoVersion } from "./repo-version-python"

const BASE_PROJECT_ENV_DEPS = ["setuptools"] as const

/**
 * Per-repo env-prep override (NOT answer-key logic): each entry compensates for
 * a known import/build failure of a repo's OLD bench snapshot under uv, keyed on
 * the exact `owner/name` slug. This is dependency materialization, not source-
 * path/keyword matching against the gold patch.
 *
 * Each entry carries a one-line comment naming the failing import it fixes so a
 * future reader can verify it against current snapshots and retire it once the
 * official dependency authority makes it unnecessary.
 */
interface RepoEnvOverride {
  /** Extra `--with <dep>` pins forced into the uv env. */
  readonly pinnedDeps?: readonly string[]
  /** Extra `uv run` flags (e.g. `--no-build-isolation`). */
  readonly buildFlags?: readonly string[]
}

const REPO_ENV_OVERRIDES: Record<string, RepoEnvOverride> = {
  // Legacy astropy setup imports `setuptools.dep_util` + `extension_helpers`
  // during the editable install; old snapshots declare neither for uv, and build
  // isolation hides the pinned setuptools<60 (the last to still ship dep_util)
  // from the build backend — so pin both and disable isolation.
  "astropy/astropy": {
    pinnedDeps: ["setuptools<60", "extension_helpers"],
    buildFlags: ["--no-build-isolation"],
  },
  // xarray still imports `np.unicode_` on older bench snapshots; numpy 2 removed
  // it, so keep xarray on numpy 1.x until env-prep materializes the official deps.
  "pydata/xarray": {
    pinnedDeps: ["numpy<2"],
  },
}

const repoPinnedDeps = (repo: string): readonly string[] =>
  REPO_ENV_OVERRIDES[repo]?.pinnedDeps ?? []

const repoBuildFlags = (repo: string): readonly string[] =>
  REPO_ENV_OVERRIDES[repo]?.buildFlags ?? []

/**
 * Shared SWE-bench project env prefix for repo-local repro / verifier commands.
 *
 * `setuptools` is forced into the `uv run` env because older repos still import
 * `pkg_resources` during module import, even when pytest itself is present.
 * `--no-project` keeps uv from switching into the repo's own project-managed
 * environment, which otherwise hides `--with` dependencies behind the project
 * layer; we install the repo explicitly via `--with-editable .` instead.
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
  argv.push(...repoBuildFlags(repo))
  for (const dep of deps) argv.push("--with", dep)
  argv.push("--with-editable", ".")
  return argv
}
