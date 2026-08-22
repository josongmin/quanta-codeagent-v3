import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runShell } from "../../src/runtime"
import {
  createPersistentWorktree,
  forceRemoveWorktree,
  removalReachedAbsence,
  removeWorktree,
  WorktreeForkError,
} from "../../src/runtime/worktree-fork"
import {
  findByExactPath,
  inspectWorktrees,
  parseWorktreePorcelain,
} from "../../src/runtime/worktree-inspect"

const gitAvailable = async (): Promise<boolean> => {
  try {
    const r = await runShell("git --version")
    return r.exitCode === 0
  } catch {
    return false
  }
}

// Probe git ONCE at module load (top-level await is allowed in Bun test files)
// so `test.skipIf(!HAS_GIT)` makes the runner emit a real `skipped` count when
// git is absent. The prior pattern (`if (!gitAvailable) return`) silently
// PASSED — making the suite green in environments where git was missing was
// indistinguishable from an actually-green suite.
const HAS_GIT = await gitAvailable()

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

  test.skipIf(!HAS_GIT)(
    "creates the worktree directory + branch on a real git repo",
    async () => {
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

  test.skipIf(!HAS_GIT)(
    "places the worktree under .quanta/worktrees/<safeId>",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)

      const wt = await createPersistentWorktree("place1", repo)
      expect(wt.worktreePath).toBe(`${repo}/.quanta/worktrees/place1`)
      expect(existsSync(`${repo}/.quanta/worktrees/place1`)).toBe(true)
    },
    GIT_TEST_TIMEOUT,
  )

  test.skipIf(!HAS_GIT)(
    "default branch name follows fork-<safeId>",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)

      const wt = await createPersistentWorktree("branchdef", repo)
      expect(wt.branch).toBe("fork-branchdef")
    },
    GIT_TEST_TIMEOUT,
  )

  test.skipIf(!HAS_GIT)(
    "custom branch override is respected",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)

      const wt = await createPersistentWorktree("custom1", repo, { branch: "my-custom-branch" })
      expect(wt.branch).toBe("my-custom-branch")
      const branches = await runShell("git branch --list", { cwd: repo })
      expect(branches.stdout).toContain("my-custom-branch")
    },
    GIT_TEST_TIMEOUT,
  )

  test.skipIf(!HAS_GIT)(
    "removeWorktree cleans up and returns true on success",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)

      const wt = await createPersistentWorktree("rm1", repo)
      const outcome = await removeWorktree(wt.worktreePath, repo, { branch: wt.branch })
      expect(outcome.kind).toBe("removed")
      expect(existsSync(wt.worktreePath)).toBe(false)

      const list = await runShell("git worktree list", { cwd: repo })
      expect(list.stdout).not.toContain(wt.worktreePath)

      const branches = await runShell("git branch --list", { cwd: repo })
      expect(branches.stdout).not.toContain("fork-rm1")
    },
    GIT_TEST_TIMEOUT,
  )

  test.skipIf(!HAS_GIT)(
    "removeWorktree on an already-removed worktree is idempotent (returns true, no throw)",
    async () => {
      // Idempotency contract: callers depend on "worktree dir is gone" as
      // success. A second remove on a missing path therefore must also
      // succeed — the desired state is already reached. (See audit MEDIUM-4:
      // partial-failure orchestration relies on this primitive being safe to
      // retry.)
      const repo = await makeRepo()
      cleanups.push(repo)

      const wt = await createPersistentWorktree("rm2", repo)
      const first = await removeWorktree(wt.worktreePath, repo, { branch: wt.branch })
      expect(first.kind).toBe("removed")

      // Second remove: the exact path is no longer registered ⇒ porcelain
      // ABSENCE (idempotent success), NOT a stderr-substring guess.
      const second = await removeWorktree(wt.worktreePath, repo, { branch: wt.branch })
      expect(second.kind).toBe("absent")
      expect(removalReachedAbsence(second)).toBe(true)
    },
    GIT_TEST_TIMEOUT,
  )

  test.skipIf(!HAS_GIT)(
    "throws WorktreeForkError on a non-git directory",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "wt-fork-nogit-"))
      cleanups.push(dir)

      await expect(createPersistentWorktree("x", dir)).rejects.toBeInstanceOf(WorktreeForkError)
    },
    GIT_TEST_TIMEOUT,
  )

  test.skipIf(!HAS_GIT)(
    "sanitizes weird ids containing `/` or `;`",
    async () => {
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

/* RFC-06 §RFC06-1 — porcelain parser (pure, no git subprocess). */
describe("parseWorktreePorcelain", () => {
  test("parses a multi-worktree registry with branch/detached/locked/bare", () => {
    const stdout = [
      "worktree /repo",
      "HEAD aaaa",
      "branch refs/heads/main",
      "bare",
      "",
      "worktree /repo/.quanta/worktrees/wt1",
      "HEAD bbbb",
      "branch refs/heads/fork-wt1",
      "",
      "worktree /repo/.claude/worktrees/agent-x",
      "HEAD cccc",
      "detached",
      "locked pid 1234 crashed",
      "",
    ].join("\n")
    const parsed = parseWorktreePorcelain(stdout)
    expect(parsed.length).toBe(3)

    expect(parsed[0]?.path).toBe("/repo")
    expect(parsed[0]?.branch).toBe("main")
    expect(parsed[0]?.bare).toBe(true)
    expect(parsed[0]?.detached).toBe(false)

    expect(parsed[1]?.path).toBe("/repo/.quanta/worktrees/wt1")
    expect(parsed[1]?.branch).toBe("fork-wt1") // refs/heads/ stripped
    expect(parsed[1]?.locked).toBe(false)

    expect(parsed[2]?.detached).toBe(true)
    expect(parsed[2]?.branch).toBeUndefined() // detached ⇒ no branch
    expect(parsed[2]?.locked).toBe(true)
    expect(parsed[2]?.lockedReason).toBe("pid 1234 crashed")
  })

  test("handles a `locked` marker with no reason (empty reason, still locked)", () => {
    const parsed = parseWorktreePorcelain("worktree /w\nHEAD ff\nbranch refs/heads/b\nlocked\n")
    expect(parsed[0]?.locked).toBe(true)
    expect(parsed[0]?.lockedReason).toBe("")
  })

  test("parses a `prunable` worktree", () => {
    const parsed = parseWorktreePorcelain(
      "worktree /gone\nHEAD ff\nbranch refs/heads/b\nprunable gitdir file points to non-existent location\n",
    )
    expect(parsed[0]?.prunable).toBe(true)
  })

  test("blank / malformed input yields []", () => {
    expect(parseWorktreePorcelain("").length).toBe(0)
    expect(parseWorktreePorcelain("\n\n\n").length).toBe(0)
    // a group with no `worktree` header is skipped
    expect(parseWorktreePorcelain("HEAD ff\nbranch refs/heads/b\n").length).toBe(0)
  })

  test("an unknown label cannot upgrade a worktree (ignored)", () => {
    const parsed = parseWorktreePorcelain(
      "worktree /w\nHEAD ff\nbranch refs/heads/b\nnonsense-label value\n",
    )
    expect(parsed.length).toBe(1)
    expect(parsed[0]?.locked).toBe(false)
    expect(parsed[0]?.prunable).toBe(false)
  })

  test("findByExactPath requires a VERBATIM match (no substring/prefix)", () => {
    const wts = parseWorktreePorcelain(
      "worktree /repo/.quanta/worktrees/wt1\nHEAD ff\nbranch refs/heads/b\n",
    )
    expect(findByExactPath(wts, "/repo/.quanta/worktrees/wt1")).toBeDefined()
    // a prefix must NOT match — no path inference.
    expect(findByExactPath(wts, "/repo/.quanta/worktrees")).toBeUndefined()
    expect(findByExactPath(wts, "/repo/.quanta/worktrees/wt1/sub")).toBeUndefined()
  })
})

/* RFC-06 §RFC06-1 — hardened removeWorktree crash/dirty/locked/unowned matrix
 * against a REAL git repo. Proves: non-force default, porcelain-exact target,
 * refuse-not-force on dirty/locked, idempotent absence, and inspectWorktrees. */
describe("hardened removeWorktree (non-force, porcelain-exact)", () => {
  const cleanups: string[] = []
  afterEach(() => {
    while (cleanups.length > 0) {
      const dir = cleanups.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(!HAS_GIT)(
    "REFUSES a DIRTY worktree (non-force) — never discards uncommitted work",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      const wt = await createPersistentWorktree("dirty1", repo)
      // Make the worktree dirty (untracked file).
      await writeFile(join(wt.worktreePath, "scratch.txt"), "uncommitted\n")

      const outcome = await removeWorktree(wt.worktreePath, repo, { branch: wt.branch })
      expect(outcome.kind).toBe("refused")
      if (outcome.kind === "refused") expect(outcome.reason).toBe("dirty")
      // The worktree + its uncommitted file MUST still be on disk (not forced).
      expect(existsSync(wt.worktreePath)).toBe(true)
      expect(existsSync(join(wt.worktreePath, "scratch.txt"))).toBe(true)
      // Confirm it is still registered (realpath-normalized: macOS /tmp →
      // /private/tmp, so match by basename against the porcelain registry).
      const inspected = await inspectWorktrees(repo)
      expect(inspected.ok).toBe(true)
      if (inspected.ok) {
        const stillThere = inspected.worktrees.some((w) => w.path.endsWith("/dirty1"))
        expect(stillThere).toBe(true)
      }
    },
    GIT_TEST_TIMEOUT,
  )

  test.skipIf(!HAS_GIT)(
    "REFUSES a LOCKED worktree (never force) — report, do not delete",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      const wt = await createPersistentWorktree("locked1", repo)
      await runShell(`git worktree lock -- "${wt.worktreePath}"`, { cwd: repo })

      const outcome = await removeWorktree(wt.worktreePath, repo, { branch: wt.branch })
      expect(outcome.kind).toBe("refused")
      if (outcome.kind === "refused") expect(outcome.reason).toBe("locked")
      expect(existsSync(wt.worktreePath)).toBe(true)
    },
    GIT_TEST_TIMEOUT,
  )

  test.skipIf(!HAS_GIT)(
    "an UNOWNED path (never registered) resolves to absent, deletes nothing",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      // A path that was never a worktree.
      const bogus = `${repo}/.quanta/worktrees/never-existed`
      const outcome = await removeWorktree(bogus, repo, { branch: "fork-never" })
      expect(outcome.kind).toBe("absent")
      expect(removalReachedAbsence(outcome)).toBe(true)
    },
    GIT_TEST_TIMEOUT,
  )

  test.skipIf(!HAS_GIT)(
    "clean owned worktree: removed + branch deleted as a SEPARATE step",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      const wt = await createPersistentWorktree("clean1", repo)

      const outcome = await removeWorktree(wt.worktreePath, repo, { branch: wt.branch })
      expect(outcome.kind).toBe("removed")
      if (outcome.kind === "removed") expect(outcome.branchDeleted).toBe(true)
      expect(existsSync(wt.worktreePath)).toBe(false)
      const branches = await runShell("git branch --list", { cwd: repo })
      expect(branches.stdout).not.toContain("fork-clean1")
    },
    GIT_TEST_TIMEOUT,
  )

  test.skipIf(!HAS_GIT)(
    "forceRemoveWorktree (throwaway owner) DOES discard a dirty tree — distinct lifecycle",
    async () => {
      // Proves the two removers are genuinely different: the throwaway force
      // path discards dirty work (its callers intend that), while the hardened
      // user-session remove above REFUSES the same dirty state.
      const repo = await makeRepo()
      cleanups.push(repo)
      const wt = await createPersistentWorktree("force-dirty", repo)
      await writeFile(join(wt.worktreePath, "scratch.txt"), "uncommitted\n")

      const ok = await forceRemoveWorktree(wt.worktreePath, repo, { branch: wt.branch })
      expect(ok).toBe(true)
      expect(existsSync(wt.worktreePath)).toBe(false)
    },
    GIT_TEST_TIMEOUT,
  )
})
