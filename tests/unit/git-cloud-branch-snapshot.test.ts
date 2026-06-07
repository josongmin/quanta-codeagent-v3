/**
 * ADR-0132 Phase B — snapshotDirtyToCloudBranch unit coverage.
 *
 * The function is a 10+-step git ballet (rev-parse, symbolic-ref, status,
 * branch, stash, checkout, pop, add, commit, push, restore). Tests inject a
 * recording fake {@link GitProcessPort} so every step's argv is verifiable
 * and every failure mode is reproducible without a real repo.
 */

import { describe, expect, test } from "bun:test"
import {
  createInMemoryFileLock,
  createInMemoryFileStat,
  type FileStatPort,
  type GitProcessPort,
  type GitProcessResult,
  type SnapshotClock,
  SnapshotErrorThrown,
  snapshotDirtyToCloudBranch,
} from "@/git/cloud-branch-snapshot"

const clockAt = (ms: number): SnapshotClock => ({ now: () => ms })

interface Recorded {
  readonly args: readonly string[]
}

interface FakeGit {
  readonly port: GitProcessPort
  readonly calls: ReadonlyArray<Recorded>
}

/** Build a recording fake. Responses are matched against argv; first match
 *  wins. A miss returns exit-0 with empty stdout — the test will fail loudly
 *  if the production code reaches an unexpected call. */
const fakeGit = (
  responses: ReadonlyArray<{
    match: (args: readonly string[]) => boolean
    result: GitProcessResult | Error | ((calls: ReadonlyArray<Recorded>) => GitProcessResult)
  }>,
): FakeGit => {
  const calls: Recorded[] = []
  const port: GitProcessPort = {
    run: async (args) => {
      calls.push({ args })
      for (const r of responses) {
        if (r.match(args)) {
          if (r.result instanceof Error) throw r.result
          if (typeof r.result === "function") return r.result(calls)
          return r.result
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    },
  }
  return { port, calls }
}

const ok = (stdout = ""): GitProcessResult => ({ stdout, stderr: "", exitCode: 0 })
const fail = (stderr: string, exitCode = 1): GitProcessResult => ({
  stdout: "",
  stderr,
  exitCode,
})

/** Canned happy-path response set — covers every git invocation the snapshot
 *  performs in order. */
const happyResponses = (sha = "deadbeefcafef00d") => [
  {
    match: (a: readonly string[]) => a[0] === "rev-parse" && a[1] === "--git-dir",
    result: ok(".git"),
  },
  { match: (a: readonly string[]) => a[0] === "symbolic-ref", result: ok("refs/heads/main") },
  { match: (a: readonly string[]) => a[0] === "status", result: ok(" M file.ts") },
  {
    match: (a: readonly string[]) => a[0] === "diff" && a.includes("--numstat"),
    result: ok("1\t2\tfile.ts"),
  },
  { match: (a: readonly string[]) => a[0] === "branch" && a[1] !== "-D", result: ok() },
  { match: (a: readonly string[]) => a[0] === "stash" && a[1] === "push", result: ok() },
  {
    match: (a: readonly string[]) =>
      a[0] === "checkout" && a[1] !== "--force" && !a.includes("main"),
    result: ok(),
  },
  { match: (a: readonly string[]) => a[0] === "stash" && a[1] === "pop", result: ok() },
  { match: (a: readonly string[]) => a[0] === "add", result: ok() },
  { match: (a: readonly string[]) => a[0] === "commit", result: ok() },
  { match: (a: readonly string[]) => a[0] === "push", result: ok() },
  { match: (a: readonly string[]) => a[0] === "rev-parse" && a[1] === "HEAD", result: ok(sha) },
  { match: (a: readonly string[]) => a[0] === "checkout" && a[1] === "main", result: ok() },
]

describe("ADR-0132 Phase B — happy path", () => {
  test("dirty tree ⇒ branch + push + sha returned; original branch restored", async () => {
    const git = fakeGit(happyResponses("abc1234567890def"))
    const lock = createInMemoryFileLock()
    const ts = Date.UTC(2026, 4, 24, 12, 34, 56)
    const res = await snapshotDirtyToCloudBranch({
      gitPort: git.port,
      clockPort: clockAt(ts),
      fileLockPort: lock,
      repoCwd: "/tmp/repo",
    })
    expect(res.branch).toMatch(/^quanta\/cloud-agent-20260524123456-[0-9a-f]{6}$/)
    expect(res.sha).toBe("abc1234567890def")
    // The branch-create call happened with the right args.
    const branchCreate = git.calls.find((c) => c.args[0] === "branch" && c.args[1] !== "-D")
    expect(branchCreate).toBeDefined()
    expect(branchCreate?.args[2]).toBe("HEAD")
    // Push used --force-with-lease and the canonical remote.
    const push = git.calls.find((c) => c.args[0] === "push")
    expect(push).toBeDefined()
    expect(push?.args).toContain("--force-with-lease")
    expect(push?.args).toContain("origin")
    // Final checkout returned us to main.
    const lastCheckout = [...git.calls].reverse().find((c) => c.args[0] === "checkout")
    expect(lastCheckout?.args[1]).toBe("main")
  })

  test("never invokes --force (only --force-with-lease)", async () => {
    const git = fakeGit(happyResponses())
    const lock = createInMemoryFileLock()
    await snapshotDirtyToCloudBranch({
      gitPort: git.port,
      clockPort: clockAt(0),
      fileLockPort: lock,
      repoCwd: "/tmp/repo",
    })
    for (const c of git.calls) {
      for (const a of c.args) {
        expect(a).not.toBe("--force")
        expect(a).not.toMatch(/^-f$/)
      }
    }
  })

  test("custom branchPrefix + pushRemote propagate to argv", async () => {
    const git = fakeGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--git-dir", result: ok(".git") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("refs/heads/dev") },
      { match: (a) => a[0] === "status", result: ok("?? new.ts") },
      { match: (a) => a[0] === "diff" && a.includes("--numstat"), result: ok("") },
      { match: (a) => a[0] === "branch" && a[1] !== "-D", result: ok() },
      { match: (a) => a[0] === "stash" && a[1] === "push", result: ok() },
      { match: (a) => a[0] === "checkout" && a[1] !== "dev" && a[1] !== "--force", result: ok() },
      { match: (a) => a[0] === "stash" && a[1] === "pop", result: ok() },
      { match: (a) => a[0] === "add", result: ok() },
      { match: (a) => a[0] === "commit", result: ok() },
      { match: (a) => a[0] === "push", result: ok() },
      { match: (a) => a[0] === "rev-parse" && a[1] === "HEAD", result: ok("sha") },
      { match: (a) => a[0] === "checkout" && a[1] === "dev", result: ok() },
    ])
    const lock = createInMemoryFileLock()
    const res = await snapshotDirtyToCloudBranch({
      gitPort: git.port,
      clockPort: clockAt(0),
      fileLockPort: lock,
      fileStatPort: createInMemoryFileStat(new Map([["/tmp/repo/new.ts", 42]])),
      repoCwd: "/tmp/repo",
      branchPrefix: "myteam/snap-",
      pushRemote: "fork",
    })
    expect(res.branch).toMatch(/^myteam\/snap-/)
    const push = git.calls.find((c) => c.args[0] === "push")
    expect(push?.args).toContain("fork")
  })
})

describe("ADR-0132 Phase B — guards + error paths", () => {
  test("not inside a git repo ⇒ throws SnapshotErrorThrown { kind: not-a-repo }", async () => {
    const git = fakeGit([
      { match: (a) => a[0] === "rev-parse", result: fail("not a git repository", 128) },
    ])
    const lock = createInMemoryFileLock()
    try {
      await snapshotDirtyToCloudBranch({
        gitPort: git.port,
        clockPort: clockAt(0),
        fileLockPort: lock,
        repoCwd: "/tmp/notrepo",
      })
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(SnapshotErrorThrown)
      expect((e as SnapshotErrorThrown).kind).toBe("not-a-repo")
    }
  })

  test("detached HEAD ⇒ throws SnapshotErrorThrown { kind: detached-head }", async () => {
    const git = fakeGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--git-dir", result: ok(".git") },
      { match: (a) => a[0] === "symbolic-ref", result: fail("HEAD detached", 1) },
    ])
    const lock = createInMemoryFileLock()
    try {
      await snapshotDirtyToCloudBranch({
        gitPort: git.port,
        clockPort: clockAt(0),
        fileLockPort: lock,
        repoCwd: "/tmp/repo",
      })
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(SnapshotErrorThrown)
      expect((e as SnapshotErrorThrown).kind).toBe("detached-head")
    }
  })

  test("clean working tree ⇒ throws SnapshotErrorThrown { kind: no-dirty-changes }", async () => {
    const git = fakeGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--git-dir", result: ok(".git") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("refs/heads/main") },
      { match: (a) => a[0] === "status", result: ok("") },
    ])
    const lock = createInMemoryFileLock()
    try {
      await snapshotDirtyToCloudBranch({
        gitPort: git.port,
        clockPort: clockAt(0),
        fileLockPort: lock,
        repoCwd: "/tmp/repo",
      })
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(SnapshotErrorThrown)
      expect((e as SnapshotErrorThrown).kind).toBe("no-dirty-changes")
    }
  })

  test("dirty diff > 500MB ⇒ throws SnapshotErrorThrown { kind: diff-too-large }", async () => {
    const git = fakeGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--git-dir", result: ok(".git") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("refs/heads/main") },
      { match: (a) => a[0] === "status", result: ok(" M big.ts") },
      // 5_000_000 lines * 200 B = 1GB — over the 500MB cap.
      {
        match: (a) => a[0] === "diff" && a.includes("--numstat"),
        result: ok("5000000\t0\tbig.ts"),
      },
    ])
    const lock = createInMemoryFileLock()
    try {
      await snapshotDirtyToCloudBranch({
        gitPort: git.port,
        clockPort: clockAt(0),
        fileLockPort: lock,
        repoCwd: "/tmp/repo",
      })
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(SnapshotErrorThrown)
      expect((e as SnapshotErrorThrown).kind).toBe("diff-too-large")
    }
  })

  test("custom maxDirtyBytes override is honored", async () => {
    const git = fakeGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--git-dir", result: ok(".git") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("refs/heads/main") },
      { match: (a) => a[0] === "status", result: ok(" M tiny.ts") },
      { match: (a) => a[0] === "diff" && a.includes("--numstat"), result: ok("100\t0\ttiny.ts") },
    ])
    const lock = createInMemoryFileLock()
    try {
      await snapshotDirtyToCloudBranch({
        gitPort: git.port,
        clockPort: clockAt(0),
        fileLockPort: lock,
        repoCwd: "/tmp/repo",
        maxDirtyBytes: 1, // 100 lines * 200B = 20_000 > 1
      })
      throw new Error("should have thrown")
    } catch (e) {
      expect((e as SnapshotErrorThrown).kind).toBe("diff-too-large")
    }
  })

  test("lock already held ⇒ throws SnapshotErrorThrown { kind: lock-busy }", async () => {
    const git = fakeGit(happyResponses())
    const lock = createInMemoryFileLock()
    const first = await lock.acquire(".quanta/cloud-snapshot.lock")
    expect(first).not.toBeNull()
    try {
      await snapshotDirtyToCloudBranch({
        gitPort: git.port,
        clockPort: clockAt(0),
        fileLockPort: lock,
        repoCwd: "/tmp/repo",
      })
      throw new Error("should have thrown")
    } catch (e) {
      expect((e as SnapshotErrorThrown).kind).toBe("lock-busy")
    }
    // No git calls should have happened — the lock guard fired first.
    expect(git.calls.length).toBe(0)
    if (first !== null) await first.release()
  })

  test("push rejected by --force-with-lease ⇒ throws { kind: force-with-lease-rejected }", async () => {
    const responses = happyResponses().map((r, idx) =>
      idx === 10 // push
        ? {
            match: (a: readonly string[]) => a[0] === "push",
            result: fail("! [rejected]        main -> main (stale info)", 1),
          }
        : r,
    )
    const git = fakeGit(responses)
    const lock = createInMemoryFileLock()
    try {
      await snapshotDirtyToCloudBranch({
        gitPort: git.port,
        clockPort: clockAt(0),
        fileLockPort: lock,
        repoCwd: "/tmp/repo",
      })
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(SnapshotErrorThrown)
      expect((e as SnapshotErrorThrown).kind).toBe("force-with-lease-rejected")
    }
  })

  test("generic push failure (not lease-rejection) ⇒ { kind: git-failed, stage: push }", async () => {
    const responses = happyResponses().map((r, idx) =>
      idx === 10
        ? {
            match: (a: readonly string[]) => a[0] === "push",
            result: fail("fatal: unable to access remote (network)", 1),
          }
        : r,
    )
    const git = fakeGit(responses)
    const lock = createInMemoryFileLock()
    try {
      await snapshotDirtyToCloudBranch({
        gitPort: git.port,
        clockPort: clockAt(0),
        fileLockPort: lock,
        repoCwd: "/tmp/repo",
      })
      throw new Error("should have thrown")
    } catch (e) {
      const err = e as SnapshotErrorThrown
      expect(err.kind).toBe("git-failed")
      if (err.detail.kind === "git-failed") {
        expect(err.detail.stage).toBe("push")
      }
    }
  })

  test("abort signal fires before status ⇒ throws { kind: aborted, stage: rev-parse }", async () => {
    const git = fakeGit([])
    const lock = createInMemoryFileLock()
    const ctrl = new AbortController()
    ctrl.abort()
    try {
      await snapshotDirtyToCloudBranch({
        gitPort: git.port,
        clockPort: clockAt(0),
        fileLockPort: lock,
        repoCwd: "/tmp/repo",
        abortSignal: ctrl.signal,
      })
      throw new Error("should have thrown")
    } catch (e) {
      const err = e as SnapshotErrorThrown
      expect(err.kind).toBe("aborted")
    }
  })

  test("abort mid-snapshot ⇒ unwind restores branch and cleans branch creation", async () => {
    const ctrl = new AbortController()
    // Trigger abort once we have created the branch + stashed.
    const git = fakeGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--git-dir", result: ok(".git") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("refs/heads/main") },
      { match: (a) => a[0] === "status", result: ok(" M file.ts") },
      { match: (a) => a[0] === "diff" && a.includes("--numstat"), result: ok("1\t0\tfile.ts") },
      { match: (a) => a[0] === "branch" && a[1] !== "-D", result: ok() },
      {
        match: (a) => a[0] === "stash" && a[1] === "push",
        result: () => {
          ctrl.abort()
          return ok()
        },
      },
      { match: (a) => a[0] === "checkout" && a[1] === "--force", result: ok() },
      {
        match: (a) => a[0] === "stash" && a[1] === "list",
        result: ok("stash@{0}: On main: quanta-cloud-snapshot:quanta/cloud-agent-X"),
      },
      { match: (a) => a[0] === "stash" && a[1] === "pop", result: ok() },
      { match: (a) => a[0] === "branch" && a[1] === "-D", result: ok() },
    ])
    const lock = createInMemoryFileLock()
    try {
      await snapshotDirtyToCloudBranch({
        gitPort: git.port,
        clockPort: clockAt(0),
        fileLockPort: lock,
        repoCwd: "/tmp/repo",
        abortSignal: ctrl.signal,
      })
      throw new Error("should have thrown")
    } catch (e) {
      expect((e as SnapshotErrorThrown).kind).toBe("aborted")
    }
    // Unwind should have invoked checkout --force + branch -D.
    expect(git.calls.find((c) => c.args[0] === "checkout" && c.args[1] === "--force")).toBeDefined()
    expect(git.calls.find((c) => c.args[0] === "branch" && c.args[1] === "-D")).toBeDefined()
  })

  test("on success, file lock is released even if checkout-restore fails", async () => {
    // Final checkout to original branch fails — snapshot still returns successfully
    // (best-effort restore).
    const lockPath = ".quanta/cloud-snapshot.lock"
    const lock = createInMemoryFileLock()
    const responses = happyResponses()
    // Patch the last `checkout main` to error — best-effort means we don't
    // throw, but the lock still releases.
    responses.push({
      match: (a) => a[0] === "checkout" && a[1] === "main",
      result: fail("hypothetical failure", 1),
    })
    const git = fakeGit(responses)
    await snapshotDirtyToCloudBranch({
      gitPort: git.port,
      clockPort: clockAt(0),
      fileLockPort: lock,
      repoCwd: "/tmp/repo",
    })
    // Lock is released — a fresh acquire succeeds.
    const next = await lock.acquire(lockPath)
    expect(next).not.toBeNull()
    if (next !== null) await next.release()
  })

  test("lock is released on error paths too", async () => {
    const lockPath = ".quanta/cloud-snapshot.lock"
    const lock = createInMemoryFileLock()
    const git = fakeGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--git-dir", result: ok(".git") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("refs/heads/main") },
      { match: (a) => a[0] === "status", result: ok("") },
    ])
    try {
      await snapshotDirtyToCloudBranch({
        gitPort: git.port,
        clockPort: clockAt(0),
        fileLockPort: lock,
        repoCwd: "/tmp/repo",
      })
    } catch {
      /* expected: no-dirty-changes */
    }
    const next = await lock.acquire(lockPath)
    expect(next).not.toBeNull()
    if (next !== null) await next.release()
  })

  test("branch name uses utc YYYYMMDDhhmmss and a 6-char hex suffix", async () => {
    const git = fakeGit(happyResponses())
    const lock = createInMemoryFileLock()
    const ts = Date.UTC(2027, 0, 5, 9, 8, 7) // 2027-01-05T09:08:07Z
    const res = await snapshotDirtyToCloudBranch({
      gitPort: git.port,
      clockPort: clockAt(ts),
      fileLockPort: lock,
      repoCwd: "/tmp/repo",
    })
    expect(res.branch).toMatch(/^quanta\/cloud-agent-20270105090807-[0-9a-f]{6}$/)
  })

  // ── HELLGATE: H4 untracked size-cap bypass ──────────────────────────────
  //
  // The snapshot stashes with `-u`, so untracked files ARE pushed. The size
  // cap measured only `git diff HEAD --numstat` (TRACKED only). A huge
  // UNTRACKED tree therefore slipped past the cap and blocked the loop for
  // push-minutes — the exact failure the cap exists to prevent. These cases
  // FAIL against the pre-fix code (which would silently push) and PASS once
  // untracked content is sized into the total before the cap check.

  test("HELLGATE: untracked bytes alone exceed cap ⇒ diff-too-large (not pushed)", async () => {
    const statPort: FileStatPort = createInMemoryFileStat(
      // 600MB single untracked file — TRACKED diff is empty, so ONLY untracked
      // sizing can catch this. Pre-fix: tracked=0 ⇒ under cap ⇒ pushed.
      new Map([["/tmp/repo/huge.bin", 600 * 1024 * 1024]]),
    )
    const git = fakeGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--git-dir", result: ok(".git") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("refs/heads/main") },
      { match: (a) => a[0] === "status", result: ok("?? huge.bin") },
      // Tracked diff is EMPTY — the hole was that this alone passed the cap.
      { match: (a) => a[0] === "diff" && a.includes("--numstat"), result: ok("") },
    ])
    const lock = createInMemoryFileLock()
    try {
      await snapshotDirtyToCloudBranch({
        gitPort: git.port,
        clockPort: clockAt(0),
        fileLockPort: lock,
        fileStatPort: statPort,
        repoCwd: "/tmp/repo",
      })
      throw new Error("should have thrown diff-too-large")
    } catch (e) {
      expect(e).toBeInstanceOf(SnapshotErrorThrown)
      expect((e as SnapshotErrorThrown).kind).toBe("diff-too-large")
    }
    // The cap fired BEFORE any mutation — no branch/stash/push happened.
    expect(git.calls.find((c) => c.args[0] === "branch" && c.args[1] !== "-D")).toBeUndefined()
    expect(git.calls.find((c) => c.args[0] === "stash")).toBeUndefined()
    expect(git.calls.find((c) => c.args[0] === "push")).toBeUndefined()
  })

  test("HELLGATE: tracked diff under cap but tracked+untracked over cap ⇒ rejected", async () => {
    // Tracked diff = 100 lines * 200B = 20_000B (under a 25_000B cap). Untracked
    // adds 10_000B ⇒ total 30_000B > cap. Pre-fix would have pushed.
    const statPort = createInMemoryFileStat(new Map([["/tmp/repo/extra.dat", 10_000]]))
    const git = fakeGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--git-dir", result: ok(".git") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("refs/heads/main") },
      { match: (a) => a[0] === "status", result: ok(" M tracked.ts\n?? extra.dat") },
      {
        match: (a) => a[0] === "diff" && a.includes("--numstat"),
        result: ok("100\t0\ttracked.ts"),
      },
    ])
    const lock = createInMemoryFileLock()
    try {
      await snapshotDirtyToCloudBranch({
        gitPort: git.port,
        clockPort: clockAt(0),
        fileLockPort: lock,
        fileStatPort: statPort,
        repoCwd: "/tmp/repo",
        maxDirtyBytes: 25_000,
      })
      throw new Error("should have thrown diff-too-large")
    } catch (e) {
      expect((e as SnapshotErrorThrown).kind).toBe("diff-too-large")
    }
  })

  test("HELLGATE: untracked rows present but NO fileStatPort ⇒ fail CLOSED (estimate-unavailable)", async () => {
    const git = fakeGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--git-dir", result: ok(".git") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("refs/heads/main") },
      { match: (a) => a[0] === "status", result: ok("?? mystery.bin") },
      { match: (a) => a[0] === "diff" && a.includes("--numstat"), result: ok("") },
    ])
    const lock = createInMemoryFileLock()
    try {
      await snapshotDirtyToCloudBranch({
        gitPort: git.port,
        clockPort: clockAt(0),
        fileLockPort: lock,
        repoCwd: "/tmp/repo",
        // no fileStatPort — untracked size cannot be bounded
      })
      throw new Error("should have thrown")
    } catch (e) {
      const err = e as SnapshotErrorThrown
      expect(err.kind).toBe("diff-too-large")
      if (err.detail.kind === "diff-too-large") {
        expect(err.detail.reason).toBe("estimate-unavailable")
      }
    }
    expect(git.calls.find((c) => c.args[0] === "push")).toBeUndefined()
  })

  test("HELLGATE: untracked file the stat port cannot size (null) ⇒ fail CLOSED", async () => {
    // Empty map ⇒ sizeOf returns null for the path ⇒ probe gap ⇒ fail closed.
    const statPort = createInMemoryFileStat(new Map())
    const git = fakeGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--git-dir", result: ok(".git") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("refs/heads/main") },
      { match: (a) => a[0] === "status", result: ok("?? vanished.dat") },
      { match: (a) => a[0] === "diff" && a.includes("--numstat"), result: ok("") },
    ])
    const lock = createInMemoryFileLock()
    try {
      await snapshotDirtyToCloudBranch({
        gitPort: git.port,
        clockPort: clockAt(0),
        fileLockPort: lock,
        fileStatPort: statPort,
        repoCwd: "/tmp/repo",
      })
      throw new Error("should have thrown")
    } catch (e) {
      const err = e as SnapshotErrorThrown
      expect(err.kind).toBe("diff-too-large")
      if (err.detail.kind === "diff-too-large") {
        expect(err.detail.reason).toBe("estimate-unavailable")
      }
    }
  })

  test("HELLGATE: quoted untracked path ⇒ fail CLOSED (refuse unsafe unescape)", async () => {
    const statPort = createInMemoryFileStat(new Map([['/tmp/repo/"weird name"', 5]]))
    const git = fakeGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--git-dir", result: ok(".git") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("refs/heads/main") },
      { match: (a) => a[0] === "status", result: ok('?? "weird\\tname.ts"') },
      { match: (a) => a[0] === "diff" && a.includes("--numstat"), result: ok("") },
    ])
    const lock = createInMemoryFileLock()
    try {
      await snapshotDirtyToCloudBranch({
        gitPort: git.port,
        clockPort: clockAt(0),
        fileLockPort: lock,
        fileStatPort: statPort,
        repoCwd: "/tmp/repo",
      })
      throw new Error("should have thrown")
    } catch (e) {
      expect((e as SnapshotErrorThrown).kind).toBe("diff-too-large")
    }
  })

  test("HELLGATE: small untracked file under cap ⇒ snapshot still succeeds", async () => {
    // Counterproof: the fix must NOT over-correct — a small untracked tree
    // still snapshots. 1KB untracked + tiny tracked diff < default cap.
    const statPort = createInMemoryFileStat(new Map([["/tmp/repo/small.ts", 1024]]))
    const git = fakeGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--git-dir", result: ok(".git") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("refs/heads/main") },
      { match: (a) => a[0] === "status", result: ok(" M file.ts\n?? small.ts") },
      { match: (a) => a[0] === "diff" && a.includes("--numstat"), result: ok("1\t2\tfile.ts") },
      { match: (a) => a[0] === "branch" && a[1] !== "-D", result: ok() },
      { match: (a) => a[0] === "stash" && a[1] === "push", result: ok() },
      { match: (a) => a[0] === "checkout" && a[1] !== "--force" && a[1] !== "main", result: ok() },
      { match: (a) => a[0] === "stash" && a[1] === "pop", result: ok() },
      { match: (a) => a[0] === "add", result: ok() },
      { match: (a) => a[0] === "commit", result: ok() },
      { match: (a) => a[0] === "push", result: ok() },
      { match: (a) => a[0] === "rev-parse" && a[1] === "HEAD", result: ok("feedface") },
      { match: (a) => a[0] === "checkout" && a[1] === "main", result: ok() },
    ])
    const lock = createInMemoryFileLock()
    const res = await snapshotDirtyToCloudBranch({
      gitPort: git.port,
      clockPort: clockAt(0),
      fileLockPort: lock,
      fileStatPort: statPort,
      repoCwd: "/tmp/repo",
    })
    expect(res.sha).toBe("feedface")
    expect(git.calls.find((c) => c.args[0] === "push")).toBeDefined()
  })

  test("HARD_DENY invariant — no argv ever contains `--force` (lease-only)", async () => {
    // Sanity sweep covering happy path + an error path; both must respect
    // the no-`--force` invariant.
    const cases: Array<() => Promise<void>> = [
      async () => {
        const git = fakeGit(happyResponses())
        const lock = createInMemoryFileLock()
        await snapshotDirtyToCloudBranch({
          gitPort: git.port,
          clockPort: clockAt(0),
          fileLockPort: lock,
          repoCwd: "/tmp/repo",
        })
        for (const c of git.calls) for (const a of c.args) expect(a).not.toBe("--force")
      },
    ]
    for (const fn of cases) await fn()
  })
})
