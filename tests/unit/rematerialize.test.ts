/**
 * Hellgate teeth for the candidate re-materialization seam (verify-and-select
 * TD hard-gate). REAL git repo, REAL `git apply` / reset — no mocks: the only
 * way to prove the probe observes `base + patch` (and that "theater" — probing
 * the wrong tree — cannot survive) is to read the actual worktree.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  makeRegressionOracle,
  type RegressionExecPort,
  toRegressionGreen,
} from "@/runner/batch/eval/regression-oracle"
import {
  applyCandidatePatch,
  candidatePatchAppliesCleanly,
  resetToBase,
  withCandidatePatch,
} from "@/runner/batch/eval/rematerialize"

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

/** STAGED diff (`git add -A && git diff --cached`) — the EXACT shape the bench
 *  captures via `gitStageAndDiffCached`, so new-file (`--- /dev/null`) and
 *  delete-file sections appear. Reverts the edit + unstages afterward. */
const stagedDiffFor = (edit: () => void): string => {
  edit()
  git("add", "-A")
  const patch = execFileSync("git", ["diff", "--cached"], { cwd: repo, encoding: "utf8" })
  git("reset", "-q", "--hard", "HEAD")
  git("clean", "-qfdx")
  return patch
}

describe("withCandidatePatch — materializes base + patch for the probe", () => {
  test("probe OBSERVES the patched tree (the anti-theater invariant)", async () => {
    const patch = diffFor(() => writeFileSync(join(repo, "foo.txt"), "base\npatched\n"))
    const obs: { v: string } = { v: "" }
    const ret = await withCandidatePatch({
      sandbox: repo,
      patch,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
      probe: async (sb) => {
        obs.v = readFileSync(join(sb, "foo.txt"), "utf8")
        return "probed"
      },
    })
    expect(ret).toBe("probed")
    // RED-ON-INJECTION: if the seam probed the wrong tree, this would be "base\n".
    expect(obs.v).toBe("base\npatched\n")
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
    const obs: { v: string } = { v: "" }
    await withCandidatePatch({
      sandbox: repo,
      patch,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
      probe: async (sb) => {
        obs.v = readFileSync(join(sb, "foo.txt"), "utf8")
        return null
      },
    })
    // The leading reset wiped the stale tree → probe sees base+patch, not stacked.
    expect(obs.v).toBe("base\nfresh\n")
  })
})

describe("withCandidatePatch — git apply covers all diff shapes", () => {
  test("NEW-FILE patch (--- /dev/null) materializes the added file", async () => {
    const patch = stagedDiffFor(() => writeFileSync(join(repo, "added.py"), "x = 1\n"))
    const obs: { v: boolean } = { v: false }
    await withCandidatePatch({
      sandbox: repo,
      patch,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
      probe: async (sb) => {
        obs.v = existsSync(join(sb, "added.py"))
        return null
      },
    })
    expect(obs.v).toBe(true) // file was created by the patch
    expect(existsSync(join(repo, "added.py"))).toBe(false) // reset removed it
  })

  test("DELETE-FILE patch removes the file, reset restores it", async () => {
    const patch = stagedDiffFor(() => rmSync(join(repo, "keep.txt")))
    const obs: { v: boolean } = { v: true }
    await withCandidatePatch({
      sandbox: repo,
      patch,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
      probe: async (sb) => {
        obs.v = existsSync(join(sb, "keep.txt"))
        return null
      },
    })
    expect(obs.v).toBe(false) // patch deleted it
    expect(existsSync(join(repo, "keep.txt"))).toBe(true) // reset restored it
    expect(readFileSync(join(repo, "keep.txt"), "utf8")).toBe("keep\n")
  })

  test("MULTI-FILE patch applies every section atomically", async () => {
    const patch = stagedDiffFor(() => {
      writeFileSync(join(repo, "foo.txt"), "base\nA\n")
      writeFileSync(join(repo, "keep.txt"), "keep\nB\n")
    })
    const obs: { foo: string; keep: string } = { foo: "", keep: "" }
    await withCandidatePatch({
      sandbox: repo,
      patch,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
      probe: async (sb) => {
        obs.foo = readFileSync(join(sb, "foo.txt"), "utf8")
        obs.keep = readFileSync(join(sb, "keep.txt"), "utf8")
        return null
      },
    })
    expect(obs.foo).toBe("base\nA\n")
    expect(obs.keep).toBe("keep\nB\n")
  })

  test("the temp patch file is NOT visible to the probe", async () => {
    const patch = diffFor(() => writeFileSync(join(repo, "foo.txt"), "base\nz\n"))
    const obs: { v: boolean } = { v: true }
    await withCandidatePatch({
      sandbox: repo,
      patch,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
      probe: async (sb) => {
        // the patch is applied via a temp file that MUST be removed before the
        // probe runs — else a pytest collection would pick up stray repo state.
        obs.v = existsSync(join(sb, ".quanta-cand.patch"))
        return null
      },
    })
    expect(obs.v).toBe(false)
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

describe("composition — re-materialize + regression oracle → regressionGreen (the driver port's exact chain)", () => {
  const oracle = makeRegressionOracle()
  // Fake exec that READS the materialized tree: a candidate whose foo.txt
  // contains "GOOD" passes (exit 0), else the impacted test "fails" (exit 1).
  // Base foo.txt is "base\n" (NO "GOOD") — so a GREEN result is ONLY possible if
  // the oracle ran against base+candidate.patch. If it probed base/last (theater),
  // the green case would read "base\n", fail, and this test would go RED.
  const fakeExec: RegressionExecPort = async (_argv, cwd, _t) => {
    const content = readFileSync(join(cwd, "foo.txt"), "utf8")
    return content.includes("GOOD")
      ? { code: 0, stdout: "1 passed", stderr: "" }
      : { code: 1, stdout: "FAILED foo.py::test_x", stderr: "" }
  }
  const runPort = (patch: string): Promise<boolean | null> =>
    withCandidatePatch({
      sandbox: repo,
      patch,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
      probe: async (sb) => {
        const r = await oracle.run({
          tests: ["foo.py::test_x"],
          sandbox: sb,
          exec: fakeExec,
          timeoutMs: 30_000,
          buildArgv: (t) => ["pytest", ...t],
        })
        return toRegressionGreen(["foo.py::test_x"], r)
      },
    })

  test("candidate that keeps tests GREEN ⇒ regressionGreen=true", async () => {
    const patch = diffFor(() => writeFileSync(join(repo, "foo.txt"), "base\nGOOD\n"))
    expect(await runPort(patch)).toBe(true)
  })

  test("candidate that BREAKS a test ⇒ regressionGreen=false (the gate ENGAGES)", async () => {
    const patch = diffFor(() => writeFileSync(join(repo, "foo.txt"), "base\nBROKEN\n"))
    expect(await runPort(patch)).toBe(false)
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
    const bad =
      "diff --git a/foo.txt b/foo.txt\n--- a/foo.txt\n+++ b/foo.txt\n@@ -9,1 +9,1 @@\n-x\n+y\n"
    expect(await applyCandidatePatch(repo, bad, 30_000)).toBe(false)
  })

  // Self-review fix: `Bun.write` THROWS when the patch file cannot be created —
  // that is a re-materialization failure (must be `false`, never propagate out
  // and crash the regression port, which does not wrap withCandidatePatch in a
  // try/catch). Force the throw with a FILE as the sandbox's parent (Bun.write
  // mkdir-p's a missing dir, but `<file>/.quanta-cand.patch` is ENOTDIR).
  test("applyCandidatePatch returns false (never throws) when the patch file can't be written", async () => {
    const fileAsDir = join(repo, "keep.txt") // a real file → child path is ENOTDIR
    let threw = false
    let result: boolean | undefined
    try {
      result = await applyCandidatePatch(fileAsDir, "diff --git a/x b/x\n", 30_000)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(result).toBe(false)
  })

  test("candidatePatchAppliesCleanly distinguishes applies / non-applies / unavailable", async () => {
    const good = diffFor(() => writeFileSync(join(repo, "foo.txt"), "base\nGOOD\n"))
    const bad =
      "diff --git a/foo.txt b/foo.txt\n--- a/foo.txt\n+++ b/foo.txt\n@@ -9,1 +9,1 @@\n-x\n+y\n"

    expect(
      await candidatePatchAppliesCleanly({
        sandbox: repo,
        patch: good,
        baseCommit: baseCommit(),
        timeoutMs: 30_000,
      }),
    ).toBe(true)
    expect(readFileSync(join(repo, "foo.txt"), "utf8")).toBe("base\n")
    expect(
      await candidatePatchAppliesCleanly({
        sandbox: repo,
        patch: bad,
        baseCommit: baseCommit(),
        timeoutMs: 30_000,
      }),
    ).toBe(false)
    expect(
      await candidatePatchAppliesCleanly({
        sandbox: repo,
        patch: good,
        baseCommit: undefined,
        timeoutMs: 30_000,
      }),
    ).toBeNull()
  })
})
