/**
 * RFC06-2 / RFC02-5 front-door e2e — the `session worktree <id>` command is the
 * FIRST production caller of `transitionThreadToWorktree` AND the first real
 * operation-correlated activity producer.
 *
 * RED (pre-impl): the command did not exist → a real thread→worktree switch
 * produced NO correlated activity (no running→done observable through the real
 * spine/store). GREEN proves:
 *   - a real session command switches the current thread to a worktree →
 *     correlated running→done observed through the REAL ActivityStore.
 *   - git failure (non-repo cwd) → a single `failed` terminal (never a phantom
 *     done; the terminal comes only AFTER the effect settles).
 *   - intent persisted (creating) BEFORE the effect (ordering witness).
 *   - gate-OFF (no `activityStore`) ⇒ NO activity emitted (byte-identical
 *     spine) but the command still functions.
 *
 * Real git for the effect; the store is the real `createActivityStore`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createActivityStore, worktreeOpNodeId } from "@/activity"
import { runSessionCommand, type SessionCommandDeps } from "@/runner/session-ops"
import { runShell } from "@/runtime"
import { loadSessionById, type SessionMeta, saveSessionById } from "@/session"
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
  const dir = mkdtempSync(join(tmpdir(), "wt-cmd-repo-"))
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

interface Cap {
  out: string
  err: string
  deps: (extra?: Partial<SessionCommandDeps>) => SessionCommandDeps
}
const capture = (): Cap => {
  const c = { out: "", err: "" } as Cap
  c.deps = (extra) => ({
    out: (s) => {
      c.out += s
    },
    err: (s) => {
      c.err += s
    },
    confirm: async () => false,
    ...extra,
  })
  return c
}

describe("session worktree <id> — front-door activity e2e", () => {
  let sessionsDir: string
  const cleanups: string[] = []
  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "wt-cmd-sess-"))
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

  test.skipIf(!HAS_GIT)(
    "happy path: real switch → correlated running→done observed through the real store",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      await saveSessionById(mkMeta("s1", repo), { reason: "x", turns: 0, messages: [] })
      const store = createActivityStore()
      const cap = capture()
      const code = await runSessionCommand(["worktree", "s1"], cap.deps({ activityStore: store }))
      expect(code).toBe(0)

      // The correlated operation node settled to `done` through the REAL spine.
      const snap = store.snapshot()
      const opNodes = [...snap.byId.values()].filter((n) => n.correlation !== undefined)
      expect(opNodes.length).toBe(1)
      const op = opNodes[0]
      expect(op?.status).toBe("done")
      expect(op?.correlation?.threadId).toBe("s1")
      // Correlation stitches to the durable ownership authority (same op id).
      const saved = await loadSessionById("s1")
      const ownershipId = saved?.meta.workspaceOwnership?.ownershipId
      expect(ownershipId).toBeDefined()
      expect(op?.id).toBe(worktreeOpNodeId(ownershipId as string))
      expect(op?.correlation?.operationId).toBe(ownershipId)
      // Persisted record is `ready` (publish landed) and cwd points at worktree.
      expect(saved?.meta.workspaceOwnership?.state).toBe("ready")
      cleanups.push(saved?.meta.workspaceOwnership?.path as string)

      // Surface rendered the activity state (observable — north-star).
      expect(cap.out).toContain("worktree ready:")
      expect(cap.out).toContain("ACTIVITY")
      expect(cap.out).toContain("✓") // done glyph
      expect(cap.out).toContain(`op:${ownershipId}`)
    },
  )

  test.skipIf(!HAS_GIT)(
    "git failure (non-repo cwd) → a SINGLE `failed` terminal, never a phantom done",
    async () => {
      const notRepo = mkdtempSync(join(tmpdir(), "wt-cmd-notrepo-"))
      cleanups.push(notRepo)
      await saveSessionById(mkMeta("s2", notRepo), { reason: "x", turns: 0, messages: [] })
      const store = createActivityStore()
      const cap = capture()
      const code = await runSessionCommand(["worktree", "s2"], cap.deps({ activityStore: store }))
      expect(code).toBe(1)
      const snap = store.snapshot()
      const op = [...snap.byId.values()].find((n) => n.correlation !== undefined)
      expect(op?.status).toBe("failed")
      expect(cap.err).toContain("git failed")
      // Persisted record transitioned to `failed` (not left `creating`).
      const saved = await loadSessionById("s2")
      expect(saved?.meta.workspaceOwnership?.state).toBe("failed")
    },
  )

  test.skipIf(!HAS_GIT)(
    "intent-before-effect: the running node is emitted BEFORE the git effect settles",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      await saveSessionById(mkMeta("s3", repo), { reason: "x", turns: 0, messages: [] })
      const store = createActivityStore()
      // Ordering witness: intercept emits. At the OPEN event the node must be
      // `running`; AND — the strong intent-before-effect proof — the persisted
      // record must ALREADY be `creating` (durable intent) while it is NOT yet
      // `ready` (the git effect has not settled). We capture that record-read as
      // a promise at open-time and await it after the run.
      const seen: string[] = []
      const origEmit = store.emit.bind(store)
      let recordAtOpen: Promise<string | undefined> | undefined
      store.emit = (ev) => {
        origEmit(ev)
        if (ev.type === "node_open") {
          seen.push(store.snapshot().byId.get(ev.node.id)?.status ?? "?")
          // Read the durable record at the instant the `running` node opens.
          recordAtOpen = loadSessionById("s3").then((s) => s?.meta.workspaceOwnership?.state)
        }
        if (ev.type === "node_status") seen.push(ev.status)
      }
      const cap = capture()
      await runSessionCommand(["worktree", "s3"], cap.deps({ activityStore: store }))
      cleanups.push((await loadSessionById("s3"))?.meta.workspaceOwnership?.path as string)
      // The intent was DURABLE (`creating`) at the moment `running` was emitted,
      // and NOT already `ready` — the effect had not yet settled.
      const stateAtOpen = await recordAtOpen
      expect(stateAtOpen).toBe("creating")
      expect(seen).toEqual(["running", "done"]) // open first, terminal strictly after
    },
  )

  test.skipIf(!HAS_GIT)(
    "gate-OFF (no activityStore) ⇒ NO activity emitted, command still works",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      await saveSessionById(mkMeta("s4", repo), { reason: "x", turns: 0, messages: [] })
      const cap = capture()
      const code = await runSessionCommand(["worktree", "s4"], cap.deps()) // no store
      expect(code).toBe(0)
      // Command functioned: record published, cwd switched.
      const saved = await loadSessionById("s4")
      expect(saved?.meta.workspaceOwnership?.state).toBe("ready")
      cleanups.push(saved?.meta.workspaceOwnership?.path as string)
      // Byte-identical spine posture: NO activity render in the output.
      expect(cap.out).not.toContain("ACTIVITY")
      expect(cap.out).toContain("worktree ready:")
    },
  )

  test("rejected (session not found) → exit 1, no phantom activity", async () => {
    const store = createActivityStore()
    const cap = capture()
    const code = await runSessionCommand(["worktree", "nope"], cap.deps({ activityStore: store }))
    expect(code).toBe(1)
    expect(cap.err).toContain("not found")
    // No operation ever started ⇒ no correlated node.
    const op = [...store.snapshot().byId.values()].find((n) => n.correlation !== undefined)
    expect(op).toBeUndefined()
  })
})
