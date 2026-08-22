import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runShell } from "../../src/runtime"
import { isGitRepo, WorktreeError, withWorktree } from "../../src/runtime/worktree"

const gitAvailable = async (): Promise<boolean> => {
  try {
    const r = await runShell("git --version")
    return r.exitCode === 0
  } catch {
    return false
  }
}

/** Init a throwaway git repo with one commit; returns its absolute path. */
const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "wt-test-"))
  const sh = (c: string) => runShell(c, { cwd: dir })
  await sh("git init -q")
  await sh("git config user.email t@t.t && git config user.name t")
  await writeFile(join(dir, "README.md"), "hello\n")
  await sh("git add -A && git commit -q -m init")
  return dir
}

describe("withWorktree", () => {
  // git subprocess spawns are slow under the full parallel suite (62 files);
  // the default 5s timeout flakes there though each passes well under it in
  // isolation. Generous per-test budget keeps them deterministic under load.
  const GIT_TEST_TIMEOUT = 30_000

  test(
    "rejects a non-git directory",
    async () => {
      if (!(await gitAvailable())) return // env guard: skip when git absent
      const dir = await mkdtemp(join(tmpdir(), "wt-nogit-"))
      try {
        expect(isGitRepo(dir)).resolves.toBe(false)
        await expect(withWorktree("x", dir, async () => 1)).rejects.toBeInstanceOf(WorktreeError)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    "clean run auto-removes the worktree and returns the body value",
    async () => {
      if (!(await gitAvailable())) return
      const repo = await makeRepo()
      try {
        let ranIn = ""
        const { value, info } = await withWorktree("clean1", repo, async (p) => {
          ranIn = p
          return 42
        })
        expect(value).toBe(42)
        expect(ranIn).toBe(info.worktreePath)
        expect(info.branch).toBe("worktree-clean1")
        expect(info.removed).toBe(true)
        const list = await runShell("git worktree list", { cwd: repo })
        expect(list.stdout).not.toContain("agent-clean1")
      } finally {
        await rm(repo, { recursive: true, force: true })
      }
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    "dirty run keeps the worktree (removed=false)",
    async () => {
      if (!(await gitAvailable())) return
      const repo = await makeRepo()
      try {
        const { info } = await withWorktree("dirty1", repo, async (p) => {
          await writeFile(join(p, "new.txt"), "change\n")
          return "ok"
        })
        expect(info.removed).toBe(false)
        const list = await runShell("git worktree list", { cwd: repo })
        expect(list.stdout).toContain("agent-dirty1")
      } finally {
        await rm(repo, { recursive: true, force: true })
      }
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    "a throw in the body force-removes the worktree and rethrows",
    async () => {
      if (!(await gitAvailable())) return
      const repo = await makeRepo()
      try {
        await expect(
          withWorktree("boom1", repo, async () => {
            throw new Error("body failed")
          }),
        ).rejects.toThrow("body failed")
        const list = await runShell("git worktree list", { cwd: repo })
        expect(list.stdout).not.toContain("agent-boom1")
      } finally {
        await rm(repo, { recursive: true, force: true })
      }
    },
    GIT_TEST_TIMEOUT,
  )
})
