import { chmod, mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { LocalEnvSelection } from "@/runtime"
import { buildProjectEnvUvRunArgv } from "../corpus/project-env"
import type { Instance } from "../types"
import { shellJoin } from "./repro-command"

const SHIM_DIR_NAME = ".quanta-bin"
// Both `python` AND `python3` MUST be shimmed: agents reach for either spelling
// (esp. `python3 - <<'PY'` heredocs), and a shim that only intercepts `python`
// silently leaks `python3` repro scripts to the SYSTEM interpreter — which has
// no `--with-editable .` project build, so `import astropy`/extension_helpers
// raises ModuleNotFoundError and the candidate never validates (astropy-13033
// empty-patch root cause, jun-25). Same wrapper body for both; uv run selects
// the correct interpreter regardless of the invoked name.
const PYTHON_SHIM_NAMES = ["python", "python3"] as const

export const projectEnvPythonShimDir = (sandbox: string): string =>
  join(dirname(sandbox), SHIM_DIR_NAME)

const projectEnvPythonPrefix = (instance: Instance): string | undefined => {
  const swebench = instance.swebench
  if (swebench === undefined) return undefined
  return shellJoin(
    buildProjectEnvUvRunArgv(swebench.repo, swebench.version, ["pytest"], {
      PYTEST_ADDOPTS: "",
      PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1",
      PYTHONNOUSERSITE: "1",
    }),
  )
}

export const projectEnvPythonShimLocalEnv = (
  instance: Instance,
  sandbox: string,
): LocalEnvSelection | undefined =>
  instance.swebench === undefined
    ? undefined
    : { vars: {}, pathPrepend: [projectEnvPythonShimDir(sandbox)] }

export const installProjectEnvPythonShim = async (
  instance: Instance,
  sandbox: string,
): Promise<void> => {
  const prefix = projectEnvPythonPrefix(instance)
  if (prefix === undefined) return
  const dir = projectEnvPythonShimDir(sandbox)
  await mkdir(dir, { recursive: true })
  const body = ["#!/usr/bin/env bash", "set -euo pipefail", `exec ${prefix} python "$@"`, ""].join(
    "\n",
  )
  for (const name of PYTHON_SHIM_NAMES) {
    const path = join(dir, name)
    await writeFile(path, body)
    await chmod(path, 0o755)
  }
}
