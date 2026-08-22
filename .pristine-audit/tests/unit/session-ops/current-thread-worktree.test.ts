import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  reconcileCreatingWorktree,
  transitionThreadToWorktree,
} from "@/runner/session-ops/current-thread-worktree"
import { runShell } from "@/runtime"
import {
  loadSessionById,
  makeWorkspaceCreateIntent,
  type SessionMeta,
  saveSessionById,
  transitionWorkspaceState,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

/* RFC-06 §RFC06-2 — current-thread transition transaction + crash reconcile.
 * Real git for the effect; a fake clock for determinism. */

const gitAvailable = async (): Promise<boolean> => {
  try {
    return (await runShell("git --version")).exitCode === 0
  } catch {
    return false
  }
}
const HAS_GIT = await gitAvailable()

const makeRepo = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "ctw-repo-"))
  const sh = (c: string) => runShell(c, { cwd: dir })
  await sh("git init -q")
  await sh("git config user.email t@t.t && git config user.name t")
  await writeFile(join(dir, "README.md"), "hello\n")
  await sh("git add -A && git commit -q -m init")
  return dir
}

const mkMeta = (id: string, cwd: string): SessionMeta => ({
  id,
  title: "t",
  cwd,
  createdAt: 1,
  lastTouched: 1,
  archived: false,
})

let tick = 0
const clock = () => {
  tick += 1000
  return tick
}

describe("transitionThreadToWorktree (durable transaction)", () => {
  let sessionsDir: string
  const cleanups: string[] = []
  beforeEach(() => {
    tick = 0
    sessionsDir = mkdtempSync(join(tmpdir(), "ctw-sess-"))
    process.env.QUANTA_SESSIONS_DIR = sessionsDir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
    delete process.env.QUANTA_SESSIONS_DIR
    __resetRuntimeConfig()
    while (cleanups.length > 0) {
      const d = cleanups.pop()
      if (d) rmSync(d, { recursive: true, force: true })
    }
  })

  const req = (repo: string, sessionId: string, ownershipId: string) => ({
    sessionId,
    ownerThreadId: sessionId,
    repoRoot: repo,
    repoId: repo,
    ownershipId,
    baseSha: "HEAD",
  })

  test.skipIf(!HAS_GIT)(
    "happy path: persists creating→ready, creates worktree, returns nextCwd (no mid-turn swap)",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      await saveSessionById(mkMeta("t1", repo), { reason: "x", turns: 0, messages: [] })

      const uid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
      const res = await transitionThreadToWorktree(req(repo, "t1", uid), clock)
      expect(res.kind).toBe("ready")
      if (res.kind !== "ready") return
      expect(existsSync(res.nextCwd)).toBe(true)
      expect(res.ownership.state).toBe("ready")
      expect(res.ownership.path).toBe(res.nextCwd)

      // The persisted session carries the ready ownership + the new cwd. The
      // caller pins nextCwd at the next turn boundary; the record is durable now.
      const reloaded = await loadSessionById("t1")
      expect(reloaded?.meta.workspaceOwnership?.state).toBe("ready")
      expect(reloaded?.meta.cwd).toBe(res.nextCwd)
      expect(reloaded?.meta.workspaceOwnership?.branch).toBe(`fork-${uid}`)
    },
    30_000,
  )

  test.skipIf(!HAS_GIT)(
    "git effect failure: records intent, transitions to failed, cleans safe target",
    async () => {
      // A non-git cwd makes createPersistentWorktree throw.
      const notRepo = mkdtempSync(join(tmpdir(), "ctw-nogit-"))
      cleanups.push(notRepo)
      await saveSessionById(mkMeta("t2", notRepo), { reason: "x", turns: 0, messages: [] })

      const res = await transitionThreadToWorktree(
        req(notRepo, "t2", "ffffffff-1111-2222-3333-444444444444"),
        clock,
      )
      expect(res.kind).toBe("failed")
      // The persisted ownership walked creating→failed (durable, not silently
      // dropped) and the cwd was NOT swapped.
      const reloaded = await loadSessionById("t2")
      expect(reloaded?.meta.workspaceOwnership?.state).toBe("failed")
      expect(reloaded?.meta.workspaceOwnership?.lastErrorCode).toBe("worktree_create_failed")
      expect(reloaded?.meta.cwd).toBe(notRepo) // unchanged
    },
    30_000,
  )

  test.skipIf(!HAS_GIT)(
    "rejects a second transition on a thread that already owns a live worktree (one owner)",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      await saveSessionById(mkMeta("t3", repo), { reason: "x", turns: 0, messages: [] })
      const first = await transitionThreadToWorktree(
        req(repo, "t3", "11111111-2222-3333-4444-555555555555"),
        clock,
      )
      expect(first.kind).toBe("ready")
      // A second transition must be rejected (no duplicate ownership/branch).
      const second = await transitionThreadToWorktree(
        req(repo, "t3", "99999999-8888-7777-6666-555555555555"),
        clock,
      )
      expect(second.kind).toBe("rejected")
      if (second.kind === "rejected") expect(second.reason).toContain("already owns")
    },
    30_000,
  )

  test("rejects a missing session", async () => {
    const res = await transitionThreadToWorktree(req("/nope", "ghost", "id-1"), clock)
    expect(res.kind).toBe("rejected")
    if (res.kind === "rejected") expect(res.reason).toContain("not found")
  })
})

describe("reconcileCreatingWorktree (crash between intent and publish)", () => {
  let sessionsDir: string
  const cleanups: string[] = []
  beforeEach(() => {
    tick = 0
    sessionsDir = mkdtempSync(join(tmpdir(), "ctw-rec-"))
    process.env.QUANTA_SESSIONS_DIR = sessionsDir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
    delete process.env.QUANTA_SESSIONS_DIR
    __resetRuntimeConfig()
    while (cleanups.length > 0) {
      const d = cleanups.pop()
      if (d) rmSync(d, { recursive: true, force: true })
    }
  })

  const creatingMeta = (repo: string, path: string, branch: string): SessionMeta => ({
    ...mkMeta("rec", repo),
    workspaceOwnership: makeWorkspaceCreateIntent({
      ownershipId: "rec-own",
      ownerThreadId: "rec",
      repoRoot: repo,
      repoId: repo,
      path,
      branch,
      baseSha: "HEAD",
      now: 500,
    }),
  })

  test("noop when there is no ownership or it is not creating", async () => {
    const ready = transitionWorkspaceState(
      makeWorkspaceCreateIntent({
        ownershipId: "o",
        ownerThreadId: "r",
        repoRoot: "/r",
        repoId: "/r",
        path: "/r/wt",
        branch: "b",
        baseSha: "HEAD",
        now: 1,
      }),
      "ready",
      2,
    )
    const meta: SessionMeta = {
      ...mkMeta("rec", "/r"),
      ...(ready.ok ? { workspaceOwnership: ready.record } : {}),
    }
    const v = await reconcileCreatingWorktree(meta, clock)
    expect(v.kind).toBe("noop")
  })

  test.skipIf(!HAS_GIT)(
    "crash AFTER git add, BEFORE publish: worktree registered ⇒ promote_ready",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      // Simulate the effect having landed: actually create the worktree, but
      // leave the persisted record in `creating` (publish was lost to a crash).
      const branch = "fork-rec-own"
      const path = join(repo, ".quanta", "worktrees", "rec-own")
      await runShell(`git worktree add --no-track -B ${branch} -- "${path}" HEAD`, { cwd: repo })
      expect(existsSync(path)).toBe(true)

      const v = await reconcileCreatingWorktree(creatingMeta(repo, path, branch), clock)
      expect(v.kind).toBe("promote_ready")
      if (v.kind === "promote_ready") expect(v.ownership.state).toBe("ready")
    },
    30_000,
  )

  test.skipIf(!HAS_GIT)(
    "crash AFTER intent, BEFORE git add: no worktree registered ⇒ mark_failed",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      // The record claims a worktree path that was never created.
      const path = join(repo, ".quanta", "worktrees", "rec-own")
      const v = await reconcileCreatingWorktree(creatingMeta(repo, path, "fork-rec-own"), clock)
      expect(v.kind).toBe("mark_failed")
      if (v.kind === "mark_failed") {
        expect(v.ownership.state).toBe("failed")
        expect(v.ownership.lastErrorCode).toBe("reconcile_no_worktree")
      }
    },
    30_000,
  )

  test("registry unreadable (non-git repoRoot) ⇒ quarantine (never assumed ready)", async () => {
    const notRepo = mkdtempSync(join(tmpdir(), "ctw-recnogit-"))
    cleanups.push(notRepo)
    const path = join(notRepo, ".quanta", "worktrees", "rec-own")
    const v = await reconcileCreatingWorktree(creatingMeta(notRepo, path, "fork-rec-own"), clock)
    expect(v.kind).toBe("quarantine")
    if (v.kind === "quarantine") {
      expect(v.ownership.state).toBe("quarantined")
      expect(v.ownership.lastErrorCode).toBe("reconcile_inspect_failed")
    }
  })
})
