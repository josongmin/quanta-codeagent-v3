/**
 * Hellgate teeth for the candidate re-materialization seam (verify-and-select
 * TD hard-gate). REAL git repo, REAL `git apply` / reset — no mocks: the only
 * way to prove the probe observes `base + patch` (and that "theater" — probing
 * the wrong tree — cannot survive) is to read the actual worktree.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { applyCandidatePatch, resetToBase, withCandidatePatch } from "@/runner/batch/eval/rematerialize"

let repo: string
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "remat-"))
  git("init", "-q")
  git("config", "user.email", "t@t")
  git("config", "user.name", "t")
  writeFileSync(join(repo, "foo.txt"), "base\n")
  writeFileSync(join(repo, "keep.txt"), "keep\n")
  git("add", "-A")
  git("commit", "-q", "-m", "base")
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

const baseCommit = (): string => git("rev-parse", "HEAD")

/** Capture a real unified diff for a worktree edit, then revert it — yields a
 *  valid `diff --git a/… b/…` candidate patch without hand-authoring one. */
const diffFor = (edit: () => void): string => {
  edit()
  const patch = execFileSync("git", ["diff"], { cwd: repo, encoding: "utf8" })
  git("checkout", "--", ".")
  return patch
}

describe("withCandidatePatch — materializes base + patch for the probe", () => {
  test("probe OBSERVES the patched tree (the anti-theater invariant)", async () => {
    const patch = diffFor(() => writeFileSync(join(repo, "foo.txt"), "base\npatched\n"))
    let observed: string | null = null
    const ret = await withCandidatePatch({
      sandbox: repo,
      patch,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
      probe: async (sb) => {
        observed = readFileSync(join(sb, "foo.txt"), "utf8")
        return "probed"
      },
    })
    expect(ret).toBe("probed")
    // RED-ON-INJECTION: if the seam probed the wrong tree, this would be "base\n".
    expect(observed).toBe("base\npatched\n")
  })

  test("restores the sandbox to base AFTER the probe (fresh-readback)", async () => {
    const patch = diffFor(() => writeFileSync(join(repo, "foo.txt"), "base\npatched\n"))
    await withCandidatePatch({
      sandbox: repo,
      patch,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
      probe: async () => "x",
    })
    expect(readFileSync(join(repo, "foo.txt"), "utf8")).toBe("base\n")
    expect(git("status", "--porcelain")).toBe("")
  })

  test("the probe's value is returned faithfully", async () => {
    const patch = diffFor(() => writeFileSync(join(repo, "foo.txt"), "base\nx\n"))
    const ret = await withCandidatePatch({
      sandbox: repo,
      patch,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
      probe: async () => ({ votes: 3, k: 2 }),
    })
    expect(ret).toEqual({ votes: 3, k: 2 })
  })

  test("re-materializes from a DIRTY arriving sandbox (leading reset works)", async () => {
    // Simulate the executor leaving the prior candidate's edits in the tree.
    writeFileSync(join(repo, "foo.txt"), "STALE PRIOR CANDIDATE\n")
    writeFileSync(join(repo, "junk.txt"), "untracked junk\n")
    const patch = diffFor(() => {
      git("checkout", "--", "foo.txt") // diff must be vs base, so clean first
      writeFileSync(join(repo, "foo.txt"), "base\nfresh\n")
    })
    // restore the dirty state the executor would actually leave
    writeFileSync(join(repo, "foo.txt"), "STALE PRIOR CANDIDATE\n")
    let observed: string | null = null
    await withCandidatePatch({
      sandbox: repo,
      patch,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
      probe: async (sb) => {
        observed = readFileSync(join(sb, "foo.txt"), "utf8")
        return null
      },
    })
    // The leading reset wiped the stale tree → probe sees base+patch, not stacked.
    expect(observed).toBe("base\nfresh\n")
  })
})

describe("withCandidatePatch — FAIL-OPEN (null, never a false verdict)", () => {
  test("empty patch ⇒ null (no git ops, no probe)", async () => {
    let probed = false
    const ret = await withCandidatePatch({
      sandbox: repo,
      patch: "   \n",
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
      probe: async () => {
        probed = true
        return "x"
      },
    })
    expect(ret).toBeNull()
    expect(probed).toBe(false)
  })

  test("undefined baseCommit ⇒ null", async () => {
    const ret = await withCandidatePatch({
      sandbox: repo,
      patch: "diff --git a/foo.txt b/foo.txt\n",
      baseCommit: undefined,
      timeoutMs: 30_000,
      probe: async () => "x",
    })
    expect(ret).toBeNull()
  })

  test("non-applying patch ⇒ null + sandbox left clean at base", async () => {
    // A diff whose pre-image context does NOT match the base tree → git apply fails.
    const bogus =
      "diff --git a/foo.txt b/foo.txt\n--- a/foo.txt\n+++ b/foo.txt\n@@ -1,1 +1,1 @@\n-COMPLETELY DIFFERENT CONTEXT\n+nope\n"
    let probed = false
    const ret = await withCandidatePatch({
      sandbox: repo,
      patch: bogus,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
      probe: async () => {
        probed = true
        return "x"
      },
    })
    expect(ret).toBeNull()
    expect(probed).toBe(false) // probe never runs on a non-applied tree
    expect(readFileSync(join(repo, "foo.txt"), "utf8")).toBe("base\n")
    expect(git("status", "--porcelain")).toBe("")
    expect(existsSync(join(repo, ".quanta-cand.patch"))).toBe(false) // temp file cleaned
  })

  test("probe THROWS ⇒ sandbox still restored (finally reset)", async () => {
    const patch = diffFor(() => writeFileSync(join(repo, "foo.txt"), "base\nboom\n"))
    await expect(
      withCandidatePatch({
        sandbox: repo,
        patch,
        baseCommit: baseCommit(),
        timeoutMs: 30_000,
        probe: async () => {
          throw new Error("probe blew up")
        },
      }),
    ).rejects.toThrow("probe blew up")
    // finally reset ran despite the throw → tree clean at base.
    expect(readFileSync(join(repo, "foo.txt"), "utf8")).toBe("base\n")
    expect(git("status", "--porcelain")).toBe("")
  })
})

describe("primitives", () => {
  test("resetToBase wipes worktree edits + untracked files", async () => {
    writeFileSync(join(repo, "foo.txt"), "dirty\n")
    writeFileSync(join(repo, "untracked.txt"), "x\n")
    const ok = await resetToBase(repo, baseCommit(), 30_000)
    expect(ok).toBe(true)
    expect(readFileSync(join(repo, "foo.txt"), "utf8")).toBe("base\n")
    expect(existsSync(join(repo, "untracked.txt"))).toBe(false)
  })

  test("applyCandidatePatch returns false for a non-applying diff", async () => {
    const bad = "diff --git a/foo.txt b/foo.txt\n--- a/foo.txt\n+++ b/foo.txt\n@@ -9,1 +9,1 @@\n-x\n+y\n"
    expect(await applyCandidatePatch(repo, bad, 30_000)).toBe(false)
  })
})
