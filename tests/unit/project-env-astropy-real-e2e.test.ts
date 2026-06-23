/**
 * REAL astropy env/proof rail e2e (opt-in).
 *
 * P0's closure bar for `astropy__astropy-13033` is NOT "the model solved it";
 * it is narrower and deterministic:
 *
 *   1. on the REAL base commit, the repro command no longer dies in env/build
 *      (`extension_helpers`, `setuptools.dep_util`, or local clang C-extension
 *      compile collapse), and
 *   2. the candidate-proof seam (`withCandidatePatch`) re-materializes the same
 *      env successfully after reset/apply so the proof rail can actually run.
 *
 * This test uses the production surfaces only:
 *   - official repo/base commit checkout
 *   - `prepareProjectEnvSandbox(...)`
 *   - exact repro argv (`reproRunArgv(...)`)
 *   - exact proof rematerialization seam (`withCandidatePatch(...)`)
 *
 * It is intentionally opt-in and serial (`bun run test:real-toolchain`) because
 * it clones/builds a real upstream snapshot and may take several minutes.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareTaskRepo, type SwebenchTask } from "@/apps/bench/corpus"
import { reproRunArgv } from "@/runner/batch/corpus/dataset"
import {
  prepareProjectEnvSandbox,
  type ProjectEnvSandboxFs,
} from "@/runner/batch/corpus/project-env"
import { execArgv } from "@/runner/batch/eval/exec"
import { withCandidatePatch } from "@/runner/batch/eval/rematerialize"
import { gateOn } from "@/shared"

const has = (bin: string, ...args: string[]): boolean => {
  try {
    return Bun.spawnSync([bin, ...args], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}

const D =
  gateOn(process.env, "QUANTA_REAL_TOOLCHAIN_E2E") && has("git", "--version") && has("uv", "--version")
    ? describe
    : describe.skip

const ASTROPY_13033: SwebenchTask = {
  instanceId: "astropy__astropy-13033",
  repo: "astropy/astropy",
  baseCommit: "298ccb478e6bf092953bca67a3d29dc6c35f6752",
  environmentSetupCommit: "298ccb478e6bf092953bca67a3d29dc6c35f6752",
  problemStatement: "TimeSeries required-columns validation message is wrong after remove_column",
  raw: {},
}

const realFs: ProjectEnvSandboxFs = {
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, content) => writeFile(path, content),
  exists: async (path) => Bun.file(path).exists(),
  readdir: (path) => readdir(path),
  isDirectory: async (path) => (await stat(path)).isDirectory(),
}

const REPRO_SCRIPT = [
  "from astropy.time import Time",
  "from astropy.timeseries import TimeSeries",
  "import astropy.units as u",
  "",
  "ts = TimeSeries(time_start=Time('2016-03-22T12:30:31'), time_delta=3 * u.s, data={'a': [1, 2], 'b': [3, 4]})",
  "ts_2cols_required = ts.copy()",
  "ts_2cols_required._required_columns = ['time', 'a']",
  "",
  "try:",
  "    ts_2cols_required.remove_column('a')",
  "except ValueError as exc:",
  "    assert exc.args[0] == (",
  "        \"TimeSeries object is invalid - expected ['time', 'a'] as the first columns but found ['time', 'b']\"",
  "    )",
  "else:",
  "    raise AssertionError('expected ValueError from remove_column')",
  "",
].join("\n")

const runRepro = async (sandbox: string, scriptPath: string) =>
  execArgv(reproRunArgv(ASTROPY_13033.repo, "4.3", scriptPath), sandbox, 600_000)

const expectNoBuildCollapse = (stderr: string): void => {
  expect(stderr).not.toContain("No module named 'extension_helpers'")
  expect(stderr).not.toContain("No module named 'setuptools.dep_util'")
  expect(stderr).not.toContain("incompatible function pointer types")
}

const buildTrivialPatch = async (sandbox: string): Promise<string> => {
  const path = join(sandbox, "README.rst")
  const original = readFileSync(path, "utf8")
  const modified = original.includes(".. quanta-proof-e2e")
    ? original
    : original.replace(/\n/, "\n.. quanta-proof-e2e\n")
  writeFileSync(path, modified)
  const diff = await execArgv(["git", "diff", "--", "README.rst"], sandbox, 60_000)
  await execArgv(["git", "checkout", "-q", "--", "README.rst"], sandbox, 60_000)
  expect(diff.code).toBe(0)
  expect(diff.stdout).toContain("quanta-proof-e2e")
  return diff.stdout
}

D("project-env astropy real e2e", () => {
  test("base repro and candidate-proof probe both run past env/build on astropy__astropy-13033", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "astropy-13033-real-")))
    const sandbox = join(root, "repo")
    const scriptPath = join(root, "repro.py")
    try {
      await prepareTaskRepo(ASTROPY_13033, sandbox, async (cmd, cwd, timeoutMs) => {
        const out = await execArgv(["bash", "-lc", cmd], cwd, timeoutMs)
        return out
      })
      const prepared = await prepareProjectEnvSandbox(sandbox, ASTROPY_13033.repo, realFs)
      expect(prepared.materialized).toBe(true)

      writeFileSync(scriptPath, REPRO_SCRIPT)

      const base = await runRepro(sandbox, scriptPath)
      expect(base.code).not.toBe(0)
      expectNoBuildCollapse(base.stderr)
      expect(base.stderr).toContain("AssertionError")

      const trivialPatch = await buildTrivialPatch(sandbox)
      const proof = await withCandidatePatch({
        sandbox,
        patch: trivialPatch,
        baseCommit: ASTROPY_13033.baseCommit,
        timeoutMs: 600_000,
        repo: ASTROPY_13033.repo,
        probe: async (cwd) => runRepro(cwd, scriptPath),
      })
      expect(proof).not.toBeNull()
      expect(proof?.code).not.toBe(0)
      expectNoBuildCollapse(proof?.stderr ?? "")
      expect(proof?.stderr ?? "").toContain("AssertionError")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 1_200_000)
})
