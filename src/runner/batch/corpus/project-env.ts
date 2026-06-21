import { pythonForRepoVersion } from "./repo-version-python"

const BASE_PROJECT_ENV_DEPS = ["setuptools"] as const

const repoPinnedDeps = (repo: string): readonly string[] => {
  // Legacy astropy setup imports setuptools.dep_util and extension_helpers
  // during editable install, but older snapshots don't declare both for uv.
  if (repo === "astropy/astropy") return ["setuptools<60", "extension_helpers"]
  // xarray still imports `np.unicode_` on older bench snapshots; numpy 2 removes it.
  // Until env-prep materializes the official dependency authority, keep xarray on numpy 1.x.
  if (repo === "pydata/xarray") return ["numpy<2"]
  return []
}

const repoBuildFlags = (repo: string): readonly string[] => {
  // Astropy imports setuptools.dep_util while building the editable install.
  // Build isolation hides the pinned setuptools, so disable it only for astropy.
  if (repo === "astropy/astropy") return ["--no-build-isolation"]
  return []
}

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
