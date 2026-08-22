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

// Probe git ONCE at module load (top-level await is allowed in Bun test files)
// so `test.skipIf(!HAS_GIT)` makes the runner emit a real `skipped` count when
// git is absent. The prior pattern (`if (!HAS_GIT) return`) silently
// PASSED — making the suite green in environments where git was missing was
// indistinguishable from an actually-green suite.
const HAS_GIT = await hasGit()
let repoDir = ""

beforeAll(async () => {
  if (!HAS_GIT) return
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
  test.skipIf(!HAS_GIT)("environment probe — git is available", () => {
    expect(HAS_GIT).toBe(true)
  })

  test.skipIf(!HAS_GIT)("git_commit({mode:'wip'}) creates a wip commit", async () => {
    await writeFile(join(repoDir, "wip-a.txt"), "wip content A\n")
    const r = await collect(gitCommitTool(defaultGitRunner), { mode: "wip" }, repoDir)
    expect(r.ok).toBe(true)
    const log = await git(repoDir, ["log", "--oneline", "-1"])
    expect(log.ok).toBe(true)
    expect(log.stdout).toMatch(/wip:/)
  })

  test.skipIf(!HAS_GIT)(
    "git_commit({mode:'regular', message}) creates a named commit",
    async () => {
      await writeFile(join(repoDir, "regular.txt"), "regular\n")
      const r = await collect(
        gitCommitTool(defaultGitRunner),
        { message: "feat: add regular file" },
        repoDir,
      )
      expect(r.ok).toBe(true)
      const log = await git(repoDir, ["log", "--oneline", "-1"])
      expect(log.stdout).toContain("feat: add regular file")
    },
  )

  test.skipIf(!HAS_GIT)("git_branch_switch dirty + autoWip:true commits + switches", async () => {
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

  test.skipIf(!HAS_GIT)(
    "git_branch_switch dirty + autoWip:false ⇒ ok:false (no mutation)",
    async () => {
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
    },
  )

  test.skipIf(!HAS_GIT)("git_branch_switch clean tree: plain switch (no wip)", async () => {
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

  test.skipIf(!HAS_GIT)(
    "branch-name injection guard blocks shell metacharacters at schema layer",
    async () => {
      const r = await collect(
        gitBranchSwitchTool(defaultGitRunner),
        { branch: "x;touch /tmp/quanta-pwned", create: true },
        repoDir,
      )
      expect(r.ok).toBe(false)
      expect(r.output).toMatch(/invalid input|branch/i)
    },
  )
})

// §7.4 3-WAY dirty-checkout — drive each action end-to-end against real git.
describe("git_branch_switch — §7.4 dirtyAction e2e (real git)", () => {
  test.skipIf(!HAS_GIT)(
    "dirtyAction:'commit-wip' commits a wip checkpoint then switches",
    async () => {
      await git(repoDir, ["checkout", "-q", "main"])
      // tracked edit + untracked file ⇒ dirty.
      await writeFile(join(repoDir, "seed.txt"), "seed mutated for commit-wip\n")
      await writeFile(join(repoDir, "cw-untracked.txt"), "untracked\n")

      const r = await collect(
        gitBranchSwitchTool(defaultGitRunner),
        { branch: "feat-commit-wip", create: true, dirtyAction: "commit-wip" },
        repoDir,
      )
      expect(r.ok).toBe(true)
      expect(r.output).toMatch(/wip checkpoint/i)

      const head = await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])
      expect(head.stdout.trim()).toBe("feat-commit-wip")
      const log = await git(repoDir, ["log", "--oneline", "-1"])
      expect(log.stdout).toMatch(/wip:/)
      // The wip commit captured both the tracked edit and the untracked file.
      const clean = await git(repoDir, ["status", "--porcelain"])
      expect(clean.stdout.trim()).toBe("")
    },
  )

  test.skipIf(!HAS_GIT)(
    "dirtyAction:'stash' stashes the dirty tree then switches (recoverable)",
    async () => {
      await git(repoDir, ["checkout", "-q", "main"])
      const headSha = await git(repoDir, ["rev-parse", "HEAD"])
      await writeFile(join(repoDir, "seed.txt"), "seed mutated for stash\n")
      await writeFile(join(repoDir, "stash-untracked.txt"), "to be stashed\n")

      const r = await collect(
        gitBranchSwitchTool(defaultGitRunner),
        { branch: "feat-stash", create: true, dirtyAction: "stash" },
        repoDir,
      )
      expect(r.ok).toBe(true)
      expect(r.output).toMatch(/stash/i)

      const head = await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])
      expect(head.stdout.trim()).toBe("feat-stash")
      // No new commit was made (stash, not commit).
      const afterSha = await git(repoDir, ["rev-parse", "HEAD"])
      expect(afterSha.stdout).toBe(headSha.stdout)
      // Tree is clean post-stash on the new branch.
      const status = await git(repoDir, ["status", "--porcelain"])
      expect(status.stdout.trim()).toBe("")
      // The stash is recoverable: an identifiable branch-switch entry exists.
      const stashList = await git(repoDir, ["stash", "list"])
      expect(stashList.stdout).toMatch(/branch-switch/)
      // Pop it back to prove non-destructiveness, then clean up.
      const pop = await git(repoDir, ["stash", "pop"])
      expect(pop.ok).toBe(true)
      const restored = await git(repoDir, ["status", "--porcelain"])
      expect(restored.stdout).toMatch(/stash-untracked\.txt/)
      // Reset the new branch to pristine for isolation.
      await git(repoDir, ["checkout", "--", "."])
      await git(repoDir, ["clean", "-fd"])
    },
  )

  test.skipIf(!HAS_GIT)(
    "dirtyAction:'discard' irreversibly drops tracked + untracked then switches",
    async () => {
      await git(repoDir, ["checkout", "-q", "main"])
      // Pristine seed content baseline.
      await git(repoDir, ["checkout", "--", "."])
      await git(repoDir, ["clean", "-fd"])
      const seedBefore = await Bun.file(join(repoDir, "seed.txt")).text()

      // Dirty: mutate a tracked file + add an untracked file.
      await writeFile(join(repoDir, "seed.txt"), "DESTROY ME\n")
      await writeFile(join(repoDir, "discard-untracked.txt"), "DESTROY ME TOO\n")

      const r = await collect(
        gitBranchSwitchTool(defaultGitRunner),
        { branch: "feat-discard", create: true, dirtyAction: "discard" },
        repoDir,
      )
      expect(r.ok).toBe(true)
      expect(r.output).toMatch(/discard/i)

      const head = await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])
      expect(head.stdout.trim()).toBe("feat-discard")
      // Tracked edit reverted to committed content.
      const seedAfter = await Bun.file(join(repoDir, "seed.txt")).text()
      expect(seedAfter).toBe(seedBefore)
      // Untracked file is GONE.
      expect(await Bun.file(join(repoDir, "discard-untracked.txt")).exists()).toBe(false)
      // Tree is clean.
      const status = await git(repoDir, ["status", "--porcelain"])
      expect(status.stdout.trim()).toBe("")
    },
  )

  test.skipIf(!HAS_GIT)(
    "dirtyAction ABSENT on dirty tree ⇒ ok:false (byte-identical legacy reject)",
    async () => {
      await git(repoDir, ["checkout", "-q", "main"])
      await writeFile(join(repoDir, "legacy-dirty.txt"), "x\n")
      const before = await git(repoDir, ["rev-parse", "HEAD"])

      const r = await collect(
        gitBranchSwitchTool(defaultGitRunner),
        { branch: "feat-legacy", create: true }, // no dirtyAction, no autoWip
        repoDir,
      )
      expect(r.ok).toBe(false)

      const after = await git(repoDir, ["rev-parse", "HEAD"])
      expect(after.stdout).toBe(before.stdout)
      const head = await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])
      expect(head.stdout.trim()).toBe("main")
      await rm(join(repoDir, "legacy-dirty.txt"), { force: true })
    },
  )
})
