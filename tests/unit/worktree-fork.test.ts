import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runShell } from "../../src/runtime"
import {
  createPersistentWorktree,
  removeWorktree,
  WorktreeForkError,
} from "../../src/runtime/worktree-fork"

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
  const dir = mkdtempSync(join(tmpdir(), "wt-fork-"))
  const sh = (c: string) => runShell(c, { cwd: dir })
  await sh("git init -q")
  await sh("git config user.email t@t.t && git config user.name t")
  await writeFile(join(dir, "README.md"), "hello\n")
  await sh("git add -A && git commit -q -m init")
  return dir
}

// Slow path: every test spawns multiple `git` subprocesses; stay clear of the
// default 5s timeout under parallel suite load.
const GIT_TEST_TIMEOUT = 30_000

describe("createPersistentWorktree / removeWorktree", () => {
  const cleanups: string[] = []
  afterEach(() => {
    while (cleanups.length > 0) {
      const dir = cleanups.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test(
    "creates the worktree directory + branch on a real git repo",
    async () => {
      if (!(await gitAvailable())) return
      const repo = await makeRepo()
      cleanups.push(repo)

      const wt = await createPersistentWorktree("fork1", repo)
      expect(existsSync(wt.worktreePath)).toBe(true)

      const list = await runShell("git worktree list", { cwd: repo })
      expect(list.stdout).toContain(wt.worktreePath)

      const branches = await runShell("git branch --list", { cwd: repo })
      expect(branches.stdout).toContain("fork-fork1")
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    "places the worktree under .quanta/worktrees/<safeId>",
    async () => {
      if (!(await gitAvailable())) return
      const repo = await makeRepo()
      cleanups.push(repo)

      const wt = await createPersistentWorktree("place1", repo)
      expect(wt.worktreePath).toBe(`${repo}/.quanta/worktrees/place1`)
      expect(existsSync(`${repo}/.quanta/worktrees/place1`)).toBe(true)
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    "default branch name follows fork-<safeId>",
    async () => {
      if (!(await gitAvailable())) return
      const repo = await makeRepo()
      cleanups.push(repo)

      const wt = await createPersistentWorktree("branchdef", repo)
      expect(wt.branch).toBe("fork-branchdef")
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    "custom branch override is respected",
    async () => {
      if (!(await gitAvailable())) return
      const repo = await makeRepo()
      cleanups.push(repo)

      const wt = await createPersistentWorktree("custom1", repo, { branch: "my-custom-branch" })
      expect(wt.branch).toBe("my-custom-branch")
      const branches = await runShell("git branch --list", { cwd: repo })
      expect(branches.stdout).toContain("my-custom-branch")
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    "removeWorktree cleans up and returns true on success",
    async () => {
      if (!(await gitAvailable())) return
      const repo = await makeRepo()
      cleanups.push(repo)

      const wt = await createPersistentWorktree("rm1", repo)
      const ok = await removeWorktree(wt.worktreePath, repo, { branch: wt.branch })
      expect(ok).toBe(true)
      expect(existsSync(wt.worktreePath)).toBe(false)

      const list = await runShell("git worktree list", { cwd: repo })
      expect(list.stdout).not.toContain(wt.worktreePath)

      const branches = await runShell("git branch --list", { cwd: repo })
      expect(branches.stdout).not.toContain("fork-rm1")
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    "removeWorktree on an already-removed worktree returns false (no throw)",
    async () => {
      if (!(await gitAvailable())) return
      const repo = await makeRepo()
      cleanups.push(repo)

      const wt = await createPersistentWorktree("rm2", repo)
      const first = await removeWorktree(wt.worktreePath, repo, { branch: wt.branch })
      expect(first).toBe(true)

      const second = await removeWorktree(wt.worktreePath, repo, { branch: wt.branch })
      expect(second).toBe(false)
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    "throws WorktreeForkError on a non-git directory",
    async () => {
      if (!(await gitAvailable())) return
      const dir = mkdtempSync(join(tmpdir(), "wt-fork-nogit-"))
      cleanups.push(dir)

      await expect(createPersistentWorktree("x", dir)).rejects.toBeInstanceOf(WorktreeForkError)
    },
    GIT_TEST_TIMEOUT,
  )

  test(
    "sanitizes weird ids containing `/` or `;`",
    async () => {
      if (!(await gitAvailable())) return
      const repo = await makeRepo()
      cleanups.push(repo)

      // `foo/bar;rm` → safeId("foo/bar;rm") = "foo-bar-rm".
      const wt = await createPersistentWorktree("foo/bar;rm", repo)
      expect(wt.worktreePath).toBe(`${repo}/.quanta/worktrees/foo-bar-rm`)
      expect(wt.branch).toBe("fork-foo-bar-rm")
      expect(existsSync(wt.worktreePath)).toBe(true)
      // Confirm no stray `rm` artifact was executed at repo root.
      expect(existsSync(`${repo}/README.md`)).toBe(true)
    },
    GIT_TEST_TIMEOUT,
  )
})
