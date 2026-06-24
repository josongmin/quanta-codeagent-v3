import { chmod, mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { LocalEnvSelection } from "@/runtime"
import { buildProjectEnvUvRunArgv } from "../corpus/project-env"
import type { Instance } from "../types"
import { shellJoin } from "./repro-command"

const SHIM_DIR_NAME = ".quanta-bin"
const PYTHON_SHIM_NAME = "python"

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
  const path = join(dir, PYTHON_SHIM_NAME)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path,
    ["#!/usr/bin/env bash", "set -euo pipefail", `exec ${prefix} python "$@"`, ""].join("\n"),
  )
  await chmod(path, 0o755)
}
