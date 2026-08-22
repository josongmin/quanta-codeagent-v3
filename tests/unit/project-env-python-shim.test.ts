import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
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

/**
 * Per-test DEADLOCK BACKSTOP. These cases do REAL work — write an executable
 * shim, then fork bash (which itself forks `tr`/`grep`/`paste` and execs the
 * stubbed `uv`/`python`). None of that is instant, and none of it is what the
 * cases assert: the verdict is the CALL LOG the stubs write. bun's implicit 5s
 * default was silently acting as the verdict instead — under full-suite
 * congestion these subprocess round trips land 5-12s out and the cases went red
 * with the shim behaving perfectly. The backstop is generous enough that only a
 * genuinely wedged subprocess (the unbounded uv→python→uv fork storm this file
 * exists to prevent) can trip it.
 */
const BACKSTOP_MS = 120_000

/**
 * Run the installed shim and AWAIT the child's real exit signal (not a blocking
 * `spawnSync`, which pins the loop and hides the completion event). Returns the
 * exit code so a case can pin it; the call log the stubs append is only
 * complete once this resolves.
 */
const runShim = async (shimPath: string, env: Record<string, string>): Promise<number> => {
  const proc = Bun.spawn([shimPath, "-c", "pass"], {
    env,
    stdout: "ignore",
    stderr: "ignore",
  })
  return await proc.exited
}

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

  test(
    "installed python shim routes arbitrary python argv through uv project env",
    async () => {
      await installProjectEnvPythonShim(sweInstance(), sandbox)
      const path = join(projectEnvPythonShimDir(sandbox), "python")
      const body = readFileSync(path, "utf8")

      expect(statSync(path).mode & 0o111).toBeGreaterThan(0)
      expect(body).toContain("uv run --no-project --python 3.9")
      expect(body).toContain("--with-editable .")
      expect(body).toContain("PYTEST_DISABLE_PLUGIN_AUTOLOAD=1")
      expect(body).toContain('python "$@"')
      expect(body).not.toContain("python reproduce_issue.py")
    },
    BACKSTOP_MS,
  )

  test(
    "RE-ENTRANCY GUARD: a subprocess inside uv-run execs real python, NOT uv (no recursion)",
    async () => {
      // jun-28 xarray box-OOM regression guard. WITHOUT the sentinel guard, a
      // `python` subprocess spawned from inside the uv-run env re-hits the shim →
      // `uv run … python` → another subprocess → … an unbounded uv→python→uv fork
      // storm (~4700 live `uv`, ~30GB anon) that OOM-killed the box with no verdict.
      await installProjectEnvPythonShim(sweInstance(), sandbox)
      const shimDir = projectEnvPythonShimDir(sandbox)

      // Stub `uv` and `python` on PATH; each appends its name to a log so we can
      // see which one the shim actually execs.
      const stubDir = join(parent, "stubs")
      const log = join(parent, "calls.log")
      mkdirSync(stubDir, { recursive: true })
      for (const [n, label] of [
        ["uv", "UV"],
        ["python", "REALPY"],
      ] as const) {
        const p = join(stubDir, n)
        writeFileSync(p, `#!/usr/bin/env bash\necho ${label} >> ${log}\n`)
        chmodSync(p, 0o755)
      }
      // stubs FIRST (win over any system uv/python), then system bin so the shim's
      // own coreutils (bash/tr/grep/paste) resolve.
      const env = { PATH: `${shimDir}:${stubDir}:/usr/bin:/bin` }
      const run = (extra: Record<string, string>) =>
        runShim(join(shimDir, "python"), { ...env, ...extra })

      // FIRST entry (no sentinel): MUST wrap with uv (build the env). Awaiting the
      // child's exit is the real "the log is written now" signal.
      expect(await run({})).toBe(0)
      let calls = readFileSync(log, "utf8")
      expect(calls).toContain("UV")
      expect(calls).not.toContain("REALPY")

      // RE-ENTRY (sentinel set, as it is inside uv-run): MUST exec the real python
      // directly and NOT re-invoke uv. A revert of the guard makes this call uv → fail.
      rmSync(log, { force: true })
      expect(await run({ QUANTA_PYENV_SHIM_ACTIVE: "1" })).toBe(0)
      calls = readFileSync(log, "utf8")
      expect(calls).toContain("REALPY")
      expect(calls).not.toContain("UV")
    },
    BACKSTOP_MS,
  )

  test(
    "RE-ENTRY prefers the active venv interpreter ($VIRTUAL_ENV/bin) — the prod branch",
    async () => {
      // The branch that ACTUALLY fires in production: uv run sets VIRTUAL_ENV to its
      // ephemeral build venv (which has the --with-editable . deps). Re-entry must
      // exec THAT interpreter, not a bare PATH python.
      await installProjectEnvPythonShim(sweInstance(), sandbox)
      const shimDir = projectEnvPythonShimDir(sandbox)
      const log = join(parent, "calls.log")
      const venv = join(parent, "venv")
      mkdirSync(join(venv, "bin"), { recursive: true })
      writeFileSync(join(venv, "bin", "python"), `#!/usr/bin/env bash\necho VENVPY >> ${log}\n`)
      chmodSync(join(venv, "bin", "python"), 0o755)
      // a DIFFERENT python on PATH that must NOT be chosen when the venv exists
      const stubDir = join(parent, "stubs")
      mkdirSync(stubDir, { recursive: true })
      writeFileSync(join(stubDir, "python"), `#!/usr/bin/env bash\necho PATHPY >> ${log}\n`)
      chmodSync(join(stubDir, "python"), 0o755)

      expect(
        await runShim(join(shimDir, "python"), {
          PATH: `${shimDir}:${stubDir}:/usr/bin:/bin`,
          QUANTA_PYENV_SHIM_ACTIVE: "1",
          VIRTUAL_ENV: venv,
        }),
      ).toBe(0)
      const calls = readFileSync(log, "utf8")
      expect(calls).toContain("VENVPY")
      expect(calls).not.toContain("PATHPY")
    },
    BACKSTOP_MS,
  )

  test(
    "PROPAGATION: sentinel survives uv-run into the subprocess → recursion breaks (uv runs ONCE)",
    async () => {
      // The load-bearing real-world property: the FIRST shim entry sets the sentinel
      // and execs uv; uv PRESERVES env into the python it runs; that python's `python`
      // subprocess re-hits the shim, sees the propagated sentinel, and bypasses uv.
      // This end-to-end test (vs. the manual-sentinel one above) would catch a
      // regression where the sentinel stops reaching the subprocess.
      await installProjectEnvPythonShim(sweInstance(), sandbox)
      const shimDir = projectEnvPythonShimDir(sandbox)
      const stubDir = join(parent, "stubs")
      const log = join(parent, "calls.log")
      const ctr = join(parent, "uv.count")
      mkdirSync(stubDir, { recursive: true })
      // stub `uv` modelling the VERIFIED behaviour: preserve env (so the sentinel
      // propagates) and run `python <args>`. A circuit breaker (exit after 3) makes a
      // BROKEN guard fail FAST (≥4 uv calls) instead of recursing forever / hanging.
      writeFileSync(
        join(stubDir, "uv"),
        [
          "#!/usr/bin/env bash",
          `n=$(( $(cat ${ctr} 2>/dev/null || echo 0) + 1 )); echo $n > ${ctr}`,
          `echo UV >> ${log}`,
          '[ "$n" -gt 3 ] && exit 99',
          'while [ $# -gt 0 ] && [ "$1" != "python" ]; do shift; done; shift || true',
          'exec python "$@"',
          "",
        ].join("\n"),
      )
      chmodSync(join(stubDir, "uv"), 0o755)
      // the REAL interpreter a correct re-entry must reach (does not recurse further)
      writeFileSync(join(stubDir, "python"), `#!/usr/bin/env bash\necho REALPY >> ${log}\n`)
      chmodSync(join(stubDir, "python"), 0o755)

      // NO sentinel in the launch env — the first entry must set it itself.
      await runShim(join(shimDir, "python"), { PATH: `${shimDir}:${stubDir}:/usr/bin:/bin` })
      const calls = readFileSync(log, "utf8")
      const uvRuns = (calls.match(/UV/g) ?? []).length
      expect(uvRuns).toBe(1) // wrapped once; the propagated sentinel bypassed the re-entry
      expect(calls).toContain("REALPY")
    },
    BACKSTOP_MS,
  )

  test(
    "python3 is ALSO shimmed (agents reach for python3 heredocs)",
    async () => {
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
    },
    BACKSTOP_MS,
  )
})
