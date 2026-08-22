/**
 * RFC-04 D1 — staged worktree transition hellgate (aug-22 absorption).
 *
 * Real git (temp repo) + the REAL `createActivityStore` drive
 * `transitionThreadToWorktree` with `staged: true`, proving the coarse op node
 * becomes a PARENT CONTAINER with `workspace`/`checkout` child stages materialized
 * through the real spine — and that the default (`staged` off / absent) path stays
 * BYTE-IDENTICAL to the pre-D1 single-node behavior (the container-regression fence).
 *
 * Per jul-13/jul-15: a fake sink hides seam bugs, so this uses the real store +
 * real git — the same discipline as the existing front-door e2e.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ActivitySnapshot,
  createActivityStore,
  worktreeOpNodeId,
  worktreeStepId,
} from "@/activity"
import { transitionThreadToWorktree } from "@/runner/session-ops/current-thread-worktree"
import { runShell } from "@/runtime"
import { type SessionMeta, saveSessionById } from "@/session"
import { __resetRuntimeConfig } from "@/shared"

const gitAvailable = async (): Promise<boolean> => {
  try {
    return (await runShell("git --version")).exitCode === 0
  } catch {
    return false
  }
}
const HAS_GIT = await gitAvailable()

const makeRepo = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "wt-staged-repo-"))
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

const opRow = (snap: ActivitySnapshot) =>
  [...snap.byId.values()].find((n) => n.correlation !== undefined)

describe("transitionThreadToWorktree — RFC-04 D1 staged children", () => {
  let sessionsDir: string
  const cleanups: string[] = []
  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "wt-staged-sess-"))
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

  const req = (repo: string, id: string, ownershipId: string) => ({
    sessionId: id,
    ownerThreadId: id,
    repoRoot: repo,
    repoId: repo,
    ownershipId,
    baseSha: "HEAD",
  })

  test.skipIf(!HAS_GIT)(
    "staged:true — real switch materializes workspace+checkout children; container derives done; ONE op row",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      await saveSessionById(mkMeta("s1", repo), { reason: "x", turns: 0, messages: [] })
      const store = createActivityStore()
      const r = await transitionThreadToWorktree(req(repo, "s1", "own-1"), clock, {
        store,
        staged: true,
      })
      expect(r.kind).toBe("ready")
      if (r.kind === "ready") cleanups.push(r.nextCwd)

      const snap = store.snapshot()
      const parent = worktreeOpNodeId("own-1")
      // The op node is a CONTAINER with the two D1 stages as leaf children.
      expect(snap.childIds.get(parent)).toEqual([
        worktreeStepId("own-1", "workspace"),
        worktreeStepId("own-1", "checkout"),
      ])
      expect(snap.byId.get(worktreeStepId("own-1", "workspace"))?.status).toBe("done")
      expect(snap.byId.get(worktreeStepId("own-1", "checkout"))?.status).toBe("done")
      // Container status is DERIVED from the all-done children.
      expect(snap.byId.get(parent)?.status).toBe("done")
      // Correlation fence: exactly ONE op row (children carry no correlation).
      const opRows = [...snap.byId.values()].filter((n) => n.correlation !== undefined)
      expect(opRows.length).toBe(1)
    },
  )

  test.skipIf(!HAS_GIT)(
    "staged:true — git failure settles the checkout child failed → container derives failed",
    async () => {
      const notRepo = mkdtempSync(join(tmpdir(), "wt-staged-notrepo-"))
      cleanups.push(notRepo)
      await saveSessionById(mkMeta("s2", notRepo), { reason: "x", turns: 0, messages: [] })
      const store = createActivityStore()
      const r = await transitionThreadToWorktree(req(notRepo, "s2", "own-2"), clock, {
        store,
        staged: true,
      })
      expect(r.kind).toBe("failed")
      const snap = store.snapshot()
      expect(snap.byId.get(worktreeStepId("own-2", "checkout"))?.status).toBe("failed")
      expect(snap.byId.get(worktreeOpNodeId("own-2"))?.status).toBe("failed")
    },
  )

  test.skipIf(!HAS_GIT)(
    "staged OFF (default) — BYTE-IDENTICAL single coarse leaf node; agent aggregate unchanged",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      // Two sibling sessions off the same repo so ownership ids differ.
      await saveSessionById(mkMeta("s3", repo), { reason: "x", turns: 0, messages: [] })
      await saveSessionById(mkMeta("s4", repo), { reason: "x", turns: 0, messages: [] })

      // (a) staged omitted entirely (existing caller shape).
      const off = createActivityStore()
      const rOff = await transitionThreadToWorktree(req(repo, "s3", "own-3"), clock, { store: off })
      if (rOff.kind === "ready") cleanups.push(rOff.nextCwd)
      const offSnap = off.snapshot()
      // No children — the op node is a LEAF with its asserted status (pre-D1).
      expect(offSnap.childIds.get(worktreeOpNodeId("own-3")) ?? []).toEqual([])
      expect(offSnap.byId.get(worktreeOpNodeId("own-3"))?.status).toBe("done")

      // (b) staged:true — children appear, but the AGGREGATE (agents/running/
      // stuck) is INVARIANT vs the off path (phase-kind stages, not agent).
      const on = createActivityStore()
      const rOn = await transitionThreadToWorktree(req(repo, "s4", "own-4"), clock, {
        store: on,
        staged: true,
      })
      if (rOn.kind === "ready") cleanups.push(rOn.nextCwd)
      const onSnap = on.snapshot()
      expect((onSnap.childIds.get(worktreeOpNodeId("own-4")) ?? []).length).toBe(2)
      expect(onSnap.aggregate.agents).toBe(offSnap.aggregate.agents)
      expect(onSnap.aggregate.running).toBe(offSnap.aggregate.running)
      expect(onSnap.aggregate.stuck).toBe(offSnap.aggregate.stuck)
    },
  )

  test.skipIf(!HAS_GIT)(
    "gate control — a sink with staged off emits NO step nodes (sink presence is not the gate)",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      await saveSessionById(mkMeta("s5", repo), { reason: "x", turns: 0, messages: [] })
      const store = createActivityStore()
      // Sink present, staged explicitly false ⇒ still byte-identical (no children).
      const r = await transitionThreadToWorktree(req(repo, "s5", "own-5"), clock, {
        store,
        staged: false,
      })
      if (r.kind === "ready") cleanups.push(r.nextCwd)
      const snap = store.snapshot()
      expect(opRow(snap)).toBeDefined() // the coarse op node still emitted
      expect(snap.childIds.get(worktreeOpNodeId("own-5")) ?? []).toEqual([])
    },
  )
})
