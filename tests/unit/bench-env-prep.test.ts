/**
 * T4 — per-instance environment pre-preparation (Type-F root-cause fix).
 *
 * The harness must prepare the env BEFORE the agent runs and fail-fast on a
 * broken env so the agent never wastes turns on `pip install`/`apt`/`brew`.
 * Three behaviors are pinned here:
 *   1. Part A — `environment_setup_commit`, when present, is checked out during
 *      `prepareTaskRepo` (asserted against a real two-commit temp git repo).
 *   2. Default-OFF — an instance with no `setupCmd` runs the agent normally
 *      (byte-identical: prep is a no-op).
 *   3. Fail-fast — a failing `setupCmd` yields `verdict:"env_prep_failed"` and
 *      the agent runner is NEVER invoked (asserted via a spy LLM).
 *
 * Hermetic: pure local git + a fake LLM. No network, no Python, no Docker.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { runInstance } from "../../src/apps/bench/runner"
import { defaultExec, parseSwebenchJsonl, prepareTaskRepo } from "../../src/apps/bench/swebench-dataset"
import type { Instance } from "../../src/apps/bench/types"

const GIT = "git -c user.email=t@t -c user.name=t -c commit.gpgsign=false"

/** Fake LLM that records whether it was ever asked to stream. A single
 *  end_turn so any instance that DOES reach the agent terminates fast. */
class SpyLLM implements LLMPort {
  invoked = false
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.invoked = true
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const DEPS = { maxTurns: 3, timeoutMs: 30000 }

describe("bench env-prep (T4)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-env-prep-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("Part A: environment_setup_commit is checked out by prepareTaskRepo", async () => {
    // Build an origin repo with TWO commits:
    //   commit 1 (env): writes setup.py  →  this is environment_setup_commit
    //   commit 2 (base): adds bug.py, leaves setup.py  →  base_commit
    const origin = join(dir, "origin", "lib.git")
    await mkdir(origin, { recursive: true })
    await writeFile(join(origin, "setup.py"), "# env-setup manifest\nname = 'lib'\n")
    const c1 = await defaultExec(
      `git init -q . && ${GIT} add -A && ${GIT} commit -q -m env-setup`,
      origin,
      30000,
    )
    expect(c1.code).toBe(0)
    const envRev = (await defaultExec("git rev-parse HEAD", origin, 30000)).stdout.trim()

    await writeFile(join(origin, "bug.py"), "def f():\n    return 1\n")
    const c2 = await defaultExec(`${GIT} add -A && ${GIT} commit -q -m base`, origin, 30000)
    expect(c2.code).toBe(0)
    const baseRev = (await defaultExec("git rev-parse HEAD", origin, 30000)).stdout.trim()
    expect(baseRev).not.toBe(envRev)

    const task = parseSwebenchJsonl(
      JSON.stringify({
        instance_id: "local__lib-1",
        repo: "origin/lib",
        base_commit: baseRev,
        environment_setup_commit: envRev,
        problem_statement: "fix bug.py",
      }),
    )[0]
    expect(task?.environmentSetupCommit).toBe(envRev)
    if (!task) return

    // Spy the exec to PROVE the env-setup-commit is checked out before base.
    const seen: string[] = []
    const tracingExec = async (cmd: string, cwd: string, timeoutMs: number) => {
      if (cmd.startsWith("git checkout")) seen.push(cmd)
      return defaultExec(cmd, cwd, timeoutMs)
    }

    const dest = join(dir, "checkout")
    await prepareTaskRepo(task, dest, tracingExec, join(dir), 30000)

    // env-setup-commit checked out FIRST, base_commit SECOND.
    expect(seen).toEqual([`git checkout -q ${envRev}`, `git checkout -q ${baseRev}`])
    // Final working tree is base_commit (bug.py present) AND setup.py survives.
    const head = (await defaultExec("git rev-parse HEAD", dest, 30000)).stdout.trim()
    expect(head).toBe(baseRev)
    const ls = await defaultExec("ls", dest, 30000)
    expect(ls.stdout).toContain("setup.py")
    expect(ls.stdout).toContain("bug.py")
  }, 60000)

  test("default-OFF: no env_setup_commit ⇒ only base_commit checkout (byte-identical)", async () => {
    const origin = join(dir, "origin", "plain.git")
    await mkdir(origin, { recursive: true })
    await writeFile(join(origin, "a.py"), "x = 1\n")
    await defaultExec(`git init -q . && ${GIT} add -A && ${GIT} commit -q -m base`, origin, 30000)
    const baseRev = (await defaultExec("git rev-parse HEAD", origin, 30000)).stdout.trim()

    const task = parseSwebenchJsonl(
      JSON.stringify({
        instance_id: "local__plain-1",
        repo: "origin/plain",
        base_commit: baseRev,
        problem_statement: "noop",
      }),
    )[0]
    expect(task?.environmentSetupCommit).toBeUndefined()
    if (!task) return

    const seen: string[] = []
    const tracingExec = async (cmd: string, cwd: string, timeoutMs: number) => {
      if (cmd.startsWith("git checkout")) seen.push(cmd)
      return defaultExec(cmd, cwd, timeoutMs)
    }
    await prepareTaskRepo(task, join(dir, "checkout"), tracingExec, join(dir), 30000)
    // Exactly one checkout (base_commit) — unchanged from pre-T4 behavior.
    expect(seen).toEqual([`git checkout -q ${baseRev}`])
  }, 60000)

  test("no setupCmd ⇒ agent runs normally (prep is a no-op)", async () => {
    const repo = join(dir, "repo")
    await mkdir(repo, { recursive: true })
    await writeFile(join(repo, "a.txt"), "hello\n")
    const instance: Instance = {
      id: "no-setup",
      repoPath: repo,
      problemStatement: "do nothing",
      testCmd: "true",
    }
    const llm = new SpyLLM()
    const result = await runInstance(instance, { ...DEPS, llm })
    expect(result.verdict).toBeUndefined()
    expect(result.error).toBeUndefined()
    expect(llm.invoked).toBe(true) // agent WAS invoked
  }, 60000)

  test("failing setupCmd ⇒ verdict env_prep_failed AND agent NOT invoked", async () => {
    const repo = join(dir, "repo")
    await mkdir(repo, { recursive: true })
    await writeFile(join(repo, "a.txt"), "hello\n")
    const instance: Instance = {
      id: "bad-setup",
      repoPath: repo,
      problemStatement: "do nothing",
      setupCmd: "exit 7",
      testCmd: "true",
    }
    const llm = new SpyLLM()
    const result = await runInstance(instance, { ...DEPS, llm })
    expect(result.verdict).toBe("env_prep_failed")
    expect(result.passed).toBe(false)
    expect(result.turns).toBe(0)
    expect(result.error).toContain("env prep")
    expect(result.error).toContain("code 7")
    expect(llm.invoked).toBe(false) // FAIL-FAST: agent never saw the broken env
  }, 60000)

  test("succeeding setupCmd ⇒ agent runs (env prepared host-clean inside sandbox)", async () => {
    const repo = join(dir, "repo")
    await mkdir(repo, { recursive: true })
    await writeFile(join(repo, "a.txt"), "hello\n")
    const instance: Instance = {
      id: "good-setup",
      repoPath: repo,
      problemStatement: "do nothing",
      // host-clean: writes only inside the sandbox copy, no global install.
      setupCmd: "echo prepared > .prep-marker",
      testCmd: "test -f .prep-marker",
    }
    const llm = new SpyLLM()
    const result = await runInstance(instance, { ...DEPS, llm })
    expect(result.verdict).toBeUndefined()
    expect(result.passed).toBe(true)
    expect(llm.invoked).toBe(true)
  }, 60000)
})
