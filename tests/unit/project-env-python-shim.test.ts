import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  installProjectEnvPythonShim,
  projectEnvPythonShimDir,
  projectEnvPythonShimLocalEnv,
} from "@/runner/batch/eval/project-env-python-shim"
import type { Instance } from "@/runner/batch/types"

let parent: string
let sandbox: string

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "pyshim-"))
  sandbox = join(parent, "repo")
})

afterEach(() => rmSync(parent, { recursive: true, force: true }))

const sweInstance = (): Instance => ({
  id: "django__django-11138",
  repoPath: "/tmp/repo",
  problemStatement: "bug",
  testCmd: "true",
  swebench: {
    instanceId: "django__django-11138",
    repo: "django/django",
    baseCommit: "abc",
    version: "3.0",
  },
})

describe("project-env python shim", () => {
  test("SWE-bench instance gets a PATH prepend outside the repo", () => {
    expect(projectEnvPythonShimLocalEnv(sweInstance(), sandbox)).toEqual({
      vars: {},
      pathPrepend: [join(parent, ".quanta-bin")],
    })
    expect(projectEnvPythonShimDir(sandbox)).toBe(join(parent, ".quanta-bin"))
  })

  test("non-SWE instance stays byte-identical", () => {
    expect(
      projectEnvPythonShimLocalEnv(
        {
          id: "local",
          repoPath: "/tmp/repo",
          problemStatement: "bug",
          testCmd: "true",
        },
        sandbox,
      ),
    ).toBeUndefined()
  })

  test("installed python shim routes arbitrary python argv through uv project env", async () => {
    await installProjectEnvPythonShim(sweInstance(), sandbox)
    const path = join(projectEnvPythonShimDir(sandbox), "python")
    const body = readFileSync(path, "utf8")

    expect(statSync(path).mode & 0o111).toBeGreaterThan(0)
    expect(body).toContain("uv run --no-project --python 3.9")
    expect(body).toContain("--with-editable .")
    expect(body).toContain("PYTEST_DISABLE_PLUGIN_AUTOLOAD=1")
    expect(body).toContain('python "$@"')
    expect(body).not.toContain("python reproduce_issue.py")
  })

  test("python3 is ALSO shimmed (agents reach for python3 heredocs)", async () => {
    // Regression guard: a python-only shim leaks `python3 - <<'PY'` repro scripts
    // to the system interpreter (no --with-editable . build) → ModuleNotFoundError
    // on import → empty patch (astropy-13033 root cause, jun-25).
    await installProjectEnvPythonShim(sweInstance(), sandbox)
    const dir = projectEnvPythonShimDir(sandbox)
    const py3 = join(dir, "python3")
    const py3Body = readFileSync(py3, "utf8")

    expect(statSync(py3).mode & 0o111).toBeGreaterThan(0)
    expect(py3Body).toContain("uv run --no-project --python 3.9")
    expect(py3Body).toContain("--with-editable .")
    // Both shims share the SAME project-env body — byte-identical routing.
    expect(py3Body).toBe(readFileSync(join(dir, "python"), "utf8"))
  })
})
