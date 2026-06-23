import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execArgv } from "@/runner/batch/eval/exec"
import { rescoreReproScripts, type RescoreReproDeps } from "@/runner/batch/eval/repro-rescore"
import { buildImportProbeInputs } from "@/runner/batch/eval/repro-rescore-run"
import { copyRepo, createSandbox } from "@/runner/batch/eval/sandbox"
import type { Instance } from "@/runner/batch/types"

/**
 * Integration: exercises the REAL evaluate-repro --probe path (createSandbox →
 * copyRepo → `git checkout <baseCommit>` → execArgv → import probe) against a
 * real temp git repo. Uses `python3` instead of `uv run` so it has no uv
 * dependency, but otherwise mirrors cmdEvaluateRepro's prepareSandbox wiring.
 * This catches runtime bugs the fake-port unit tests cannot (sandbox copy,
 * git checkout, cwd/import resolution).
 */

const git = async (cwd: string, ...a: string[]): Promise<void> => {
  const r = await execArgv(["git", ...a], cwd, 60_000)
  if (r.code !== 0) throw new Error(`git ${a.join(" ")} failed: ${r.stderr}`)
}

let repoRoot: string

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "probe-repo-"))
  // base commit: a clean importable `mypkg`
  await mkdir(join(repoRoot, "mypkg"), { recursive: true })
  await writeFile(join(repoRoot, "mypkg", "__init__.py"), "VALUE = 1\n")
  await git(repoRoot, "init", "-q")
  await git(repoRoot, "config", "user.email", "t@t")
  await git(repoRoot, "config", "user.name", "t")
  await git(repoRoot, "add", "-A")
  await git(repoRoot, "commit", "-q", "-m", "base")
})

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

const instanceFor = (baseCommit: string): Instance =>
  ({
    id: "x__mypkg-1",
    repoPath: repoRoot,
    problemStatement: "mypkg fails to import",
    testCmd: "true",
    swebench: { instanceId: "x__mypkg-1", repo: "x/mypkg", baseCommit },
  }) as Instance

// prepareSandbox mirrors cmdEvaluateRepro: createSandbox + copyRepo + checkout.
const probeDeps = (inst: Instance, sandboxes: string[]): RescoreReproDeps => ({
  prepareSandbox: async (input) => {
    const sb = await createSandbox(inst)
    await copyRepo(inst, sb)
    sandboxes.push(sb)
    const base = input.baseCommit
    if (base !== undefined) {
      const co = await execArgv(["git", "checkout", "-q", base], sb, 60_000)
      if (co.code !== 0) throw new Error(`checkout ${base} failed: ${co.stderr.slice(-200)}`)
    }
    return sb
  },
  exec: (argv, cwd, t) => execArgv(argv, cwd, t),
  // python3 instead of `uv run` — no uv dependency for the test.
  buildArgv: (_i, scriptPath) => ["python3", scriptPath],
})

describe("evaluate-repro --probe (real sandbox + git checkout + exec)", () => {
  test("PROBE-1: a clean importable package ⇒ reproduced (probe end-to-end works)", async () => {
    const headCommit = (await execArgv(["git", "rev-parse", "HEAD"], repoRoot, 30_000)).stdout.trim()
    const inputs = buildImportProbeInputs([
      { instanceId: "x__mypkg-1", repo: "x/mypkg", baseCommit: headCommit },
    ])
    const sandboxes: string[] = []
    const results = await rescoreReproScripts(inputs, probeDeps(instanceFor(headCommit), sandboxes))
    await Promise.all(sandboxes.map((s) => rm(join(s, ".."), { recursive: true, force: true })))
    expect(results[0]?.error).toBeUndefined()
    expect(results[0]?.outcomes).toEqual(["reproduced"])
    expect(results[0]?.reproducedCount).toBe(1)
  })

  test("PROBE-2: the BASE commit is actually checked out (the critical baseCommit fix)", async () => {
    // base commit = working pkg. Add a SECOND commit that breaks the import, so
    // HEAD is broken but base is clean. The probe must check out BASE and import OK.
    const baseCommit = (await execArgv(["git", "rev-parse", "HEAD"], repoRoot, 30_000)).stdout.trim()
    await writeFile(join(repoRoot, "mypkg", "__init__.py"), "import nonexistent_module_zzz\n")
    await git(repoRoot, "commit", "-qam", "break")
    // sanity: HEAD is now broken
    const headBroken = await execArgv(["python3", "-c", "import mypkg"], repoRoot, 30_000)
    expect(headBroken.code).not.toBe(0)

    const inputs = buildImportProbeInputs([
      { instanceId: "x__mypkg-1", repo: "x/mypkg", baseCommit },
    ])
    const sandboxes: string[] = []
    const results = await rescoreReproScripts(inputs, probeDeps(instanceFor(baseCommit), sandboxes))
    await Promise.all(sandboxes.map((s) => rm(join(s, ".."), { recursive: true, force: true })))
    // If baseCommit checkout works, the sandbox holds the CLEAN base ⇒ reproduced.
    // If checkout were skipped (copyRepo leaves HEAD), it would be exec_failed.
    expect(results[0]?.outcomes).toEqual(["reproduced"])
  })

  test("PROBE-3: a bad/absent base commit surfaces as result.error (not a silent miss)", async () => {
    const inputs = buildImportProbeInputs([
      { instanceId: "x__mypkg-1", repo: "x/mypkg", baseCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
    ])
    const sandboxes: string[] = []
    const results = await rescoreReproScripts(
      inputs,
      probeDeps(instanceFor("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"), sandboxes),
    )
    await Promise.all(sandboxes.map((s) => rm(join(s, ".."), { recursive: true, force: true })))
    expect(results[0]?.error).toBeDefined()
    expect(results[0]?.outcomes).toEqual([])
  })
})
