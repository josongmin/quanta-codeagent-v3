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
    buildProjectEnvUvRunArgv(
      swebench.repo,
      swebench.version,
      ["pytest"],
      {
        PYTEST_ADDOPTS: "",
        PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1",
        PYTHONNOUSERSITE: "1",
      },
      swebench.createdAt,
    ),
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
  // RE-ENTRANCY GUARD (jun-28 xarray box-OOM, exit 137): the shim sits on PATH,
  // so a `python` SUBPROCESS spawned from inside the uv-run env (a pytest/
  // setuptools probe `python -I -B -c "import sys…"`, or a repro's own
  // subprocess) re-hits the shim → `uv run … python` → spawns another subprocess
  // → … an UNBOUNDED uv→python→uv recursion that leaked ~4700 live `uv` procs
  // (~30GB anon) and OOM-killed the box with NO verdict. On the FIRST entry we
  // wrap with `uv run` (which builds the env) and set a sentinel; any re-entry
  // execs the REAL interpreter directly (env already built) — preferring the
  // active venv, else the same name with our shim dir stripped from PATH. This
  // breaks the recursion AND skips the expensive `--with-editable .` rebuild per
  // subprocess. The behaviour is pinned by the shim hellgate test.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: these `${…}` are bash
  // parameter expansions in a GENERATED shell script, not JS template literals.
  const body = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'self_dir="$(cd "$(dirname "$0")" && pwd 2>/dev/null || echo)"',
    'name="${0##*/}"',
    'if [ -n "${QUANTA_PYENV_SHIM_ACTIVE:-}" ]; then',
    '  if [ -n "${VIRTUAL_ENV:-}" ] && [ -x "${VIRTUAL_ENV}/bin/${name}" ]; then',
    '    exec "${VIRTUAL_ENV}/bin/${name}" "$@"',
    "  fi",
    "  PATH=\"$(printf '%s' \"${PATH}\" | tr ':' '\\n' | grep -vxF \"${self_dir}\" | paste -sd: -)\"",
    "  export PATH",
    '  exec "${name}" "$@"',
    "fi",
    "export QUANTA_PYENV_SHIM_ACTIVE=1",
    `exec ${prefix} python "$@"`,
    "",
  ].join("\n")
  for (const name of PYTHON_SHIM_NAMES) {
    const path = join(dir, name)
    await writeFile(path, body)
    await chmod(path, 0o755)
  }
}
