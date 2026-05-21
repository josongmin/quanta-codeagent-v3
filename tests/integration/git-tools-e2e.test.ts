/** Integration tests for `git_commit` + `git_branch_switch` against a real
 *  git repository in a tmpdir. Covers:
 *
 *    • wip-mode commit creates a real commit visible in `git log`
 *    • regular-mode commit creates a permanent commit with the user message
 *    • branch_switch + autoWip=true on a dirty tree commits a wip checkpoint
 *      and switches to the new branch
 *    • branch_switch + autoWip=false on a dirty tree returns ok:false
 *    • clean-tree branch_switch is a plain `git switch`
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultGitRunner, gitBranchSwitchTool, gitCommitTool } from "@/tool/git"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

interface ExecutableTool {
  execute(input: never, c: ToolContext): AsyncIterable<ToolEvent>
}

const collect = async (tool: ExecutableTool, input: unknown, cwd: string): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? "/tmp",
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
}

const git = async (
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
  const p = Bun.spawn(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  const code = await p.exited
  return { ok: code === 0, stdout, stderr }
}

const hasGit = async (): Promise<boolean> => {
  try {
    const p = Bun.spawn(["git", "--version"], { stdout: "pipe", stderr: "pipe" })
    const code = await p.exited
    return code === 0
  } catch {
    return false
  }
}

let gitAvailable = false
let repoDir = ""

beforeAll(async () => {
  gitAvailable = await hasGit()
  if (!gitAvailable) return
  repoDir = await mkdtemp(join(tmpdir(), "git-mut-e2e-"))
  await git(repoDir, ["init", "-q"])
  await git(repoDir, ["checkout", "-q", "-b", "main"])
  await writeFile(join(repoDir, "seed.txt"), "seed\n")
  await git(repoDir, ["add", "seed.txt"])
  await git(repoDir, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "seed"])
})

afterAll(async () => {
  if (repoDir) await rm(repoDir, { recursive: true, force: true })
})

describe("git_commit / git_branch_switch — e2e (real git)", () => {
  test.skipIf(!gitAvailable)("environment probe — git is available", () => {
    expect(gitAvailable).toBe(true)
  })

  test("git_commit({mode:'wip'}) creates a wip commit", async () => {
    if (!gitAvailable) return
    await writeFile(join(repoDir, "wip-a.txt"), "wip content A\n")
    const r = await collect(gitCommitTool(defaultGitRunner), { mode: "wip" }, repoDir)
    expect(r.ok).toBe(true)
    const log = await git(repoDir, ["log", "--oneline", "-1"])
    expect(log.ok).toBe(true)
    expect(log.stdout).toMatch(/wip:/)
  })

  test("git_commit({mode:'regular', message}) creates a named commit", async () => {
    if (!gitAvailable) return
    await writeFile(join(repoDir, "regular.txt"), "regular\n")
    const r = await collect(
      gitCommitTool(defaultGitRunner),
      { message: "feat: add regular file" },
      repoDir,
    )
    expect(r.ok).toBe(true)
    const log = await git(repoDir, ["log", "--oneline", "-1"])
    expect(log.stdout).toContain("feat: add regular file")
  })

  test("git_branch_switch dirty + autoWip:true commits + switches", async () => {
    if (!gitAvailable) return
    // Ensure we are back on main with a clean tree before this test.
    await git(repoDir, ["checkout", "-q", "main"])
    await writeFile(join(repoDir, "dirty.txt"), "dirty\n")

    const r = await collect(
      gitBranchSwitchTool(defaultGitRunner),
      { branch: "feat-via-tool", create: true, autoWip: true },
      repoDir,
    )
    expect(r.ok).toBe(true)

    // Confirm we are on the new branch.
    const head = await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])
    expect(head.stdout.trim()).toBe("feat-via-tool")

    // Confirm last commit is a wip commit (the autoWip checkpoint).
    const log = await git(repoDir, ["log", "--oneline", "-1"])
    expect(log.stdout).toMatch(/wip:/)
  })

  test("git_branch_switch dirty + autoWip:false ⇒ ok:false (no mutation)", async () => {
    if (!gitAvailable) return
    // Reset to a known-clean main.
    await git(repoDir, ["checkout", "-q", "main"])
    await writeFile(join(repoDir, "still-dirty.txt"), "x\n")

    const before = await git(repoDir, ["rev-parse", "HEAD"])
    const r = await collect(
      gitBranchSwitchTool(defaultGitRunner),
      { branch: "doesnt-matter", create: true, autoWip: false },
      repoDir,
    )
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/dirty|stash|autoWip/i)

    // HEAD unchanged + still on main.
    const after = await git(repoDir, ["rev-parse", "HEAD"])
    expect(after.stdout).toBe(before.stdout)
    const head = await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])
    expect(head.stdout.trim()).toBe("main")

    // Cleanup the untracked file so later tests start clean.
    await rm(join(repoDir, "still-dirty.txt"), { force: true })
  })

  test("git_branch_switch clean tree: plain switch (no wip)", async () => {
    if (!gitAvailable) return
    // Make sure we're clean on main.
    await git(repoDir, ["checkout", "-q", "main"])

    const beforeLog = await git(repoDir, ["log", "--oneline", "-1"])

    const r = await collect(
      gitBranchSwitchTool(defaultGitRunner),
      { branch: "clean-feat", create: true },
      repoDir,
    )
    expect(r.ok).toBe(true)

    const head = await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])
    expect(head.stdout.trim()).toBe("clean-feat")

    // No new commit added (we did not pass autoWip; tree was clean anyway).
    const afterLog = await git(repoDir, ["log", "--oneline", "-1"])
    expect(afterLog.stdout).toBe(beforeLog.stdout)
  })

  test("branch-name injection guard blocks shell metacharacters at schema layer", async () => {
    if (!gitAvailable) return
    const r = await collect(
      gitBranchSwitchTool(defaultGitRunner),
      { branch: "x;touch /tmp/quanta-pwned", create: true },
      repoDir,
    )
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/invalid input|branch/i)
  })
})
