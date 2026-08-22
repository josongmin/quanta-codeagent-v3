/**
 * RFC-04 D4 — live CLI worktree progress: PRE-COMPLETION timing hellgate.
 *
 * The `session worktree <id>` front door is the first production caller of
 * `transitionThreadToWorktree`. PRE-D4 it awaits the ENTIRE transition and only
 * THEN renders one final `renderActivity` snapshot — so the first progress render
 * happens strictly AFTER the operation resolves (a spinner, not live progress).
 *
 * D4 subscribes to the session store ATOMICALLY BEFORE invoking the transition
 * and renders each materialized staged change (workspace → checkout → …) as it
 * arrives, so the FIRST activity render precedes command completion.
 *
 * TIMING PROOF (write-order, not wall-clock — deterministic): the command writes
 * the `worktree ready:` line SYNCHRONOUSLY right after the transition resolves.
 * Every `deps.out` call is recorded in order. A live render fired DURING the
 * transition therefore has a write index STRICTLY LESS than the `worktree ready:`
 * index; a post-completion render does not. This is independent of git speed: the
 * subscription flushes synchronously at the `running` open, which the transaction
 * emits BEFORE the `createPersistentWorktree` await.
 *
 *   RED (pre-D4): first ACTIVITY render index > `worktree ready:` index.
 *   GREEN (D4, gate ON): first ACTIVITY render index < `worktree ready:` index.
 *
 * Gate-OFF byte-identity: with progress absent the command renders exactly ONE
 * ACTIVITY block, AFTER `worktree ready:` — identical to the legacy path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createActivityStore } from "@/activity"
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
  const dir = mkdtempSync(join(tmpdir(), "wt-live-repo-"))
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

/** Ordered write recorder: every `out` call is one entry, in call order. */
const orderedCapture = (): {
  writes: string[]
  deps: (extra?: Partial<SessionCommandDeps>) => SessionCommandDeps
} => {
  const writes: string[] = []
  return {
    writes,
    deps: (extra) => ({
      out: (s) => {
        writes.push(s)
      },
      err: () => undefined,
      confirm: async () => false,
      ...extra,
    }),
  }
}

const firstIndex = (writes: readonly string[], re: RegExp): number =>
  writes.findIndex((w) => re.test(w))

describe("RFC-04 D4 — worktree live progress pre-completion timing", () => {
  let sessionsDir: string
  const cleanups: string[] = []
  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "wt-live-sess-"))
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
    "gate ON: first ACTIVITY render precedes the `worktree ready:` line (pre-completion)",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      await saveSessionById(mkMeta("live1", repo), { reason: "x", turns: 0, messages: [] })
      const store = createActivityStore()
      const cap = orderedCapture()
      const code = await runSessionCommand(
        ["worktree", "live1"],
        cap.deps({ activityStore: store, worktreeProgress: true }),
      )
      expect(code).toBe(0)
      cleanups.push((await loadSessionById("live1"))?.meta.workspaceOwnership?.path as string)

      const readyIdx = firstIndex(cap.writes, /worktree ready:/)
      const activityIdx = firstIndex(cap.writes, /ACTIVITY/)
      expect(readyIdx).toBeGreaterThanOrEqual(0)
      expect(activityIdx).toBeGreaterThanOrEqual(0)
      // THE hellgate: a live progress render happened BEFORE the command settled.
      expect(activityIdx).toBeLessThan(readyIdx)
      // Staged children were materialized (workspace/checkout stages visible).
      const joined = cap.writes.join("")
      expect(joined).toContain("Preparing workspace")
      expect(joined).toContain("Checking out files")
    },
  )

  test.skipIf(!HAS_GIT)(
    "gate OFF: single final ACTIVITY block AFTER `worktree ready:` (byte-identical legacy)",
    async () => {
      const repo = await makeRepo()
      cleanups.push(repo)
      await saveSessionById(mkMeta("live2", repo), { reason: "x", turns: 0, messages: [] })
      const store = createActivityStore()
      const cap = orderedCapture()
      const code = await runSessionCommand(
        ["worktree", "live2"],
        cap.deps({ activityStore: store }),
      )
      expect(code).toBe(0)
      cleanups.push((await loadSessionById("live2"))?.meta.workspaceOwnership?.path as string)

      const readyIdx = firstIndex(cap.writes, /worktree ready:/)
      const activityIdx = firstIndex(cap.writes, /ACTIVITY/)
      expect(readyIdx).toBeGreaterThanOrEqual(0)
      expect(activityIdx).toBeGreaterThan(readyIdx) // legacy: render only after
      // Exactly one ACTIVITY header (no live pre-renders) — legacy posture.
      expect(cap.writes.filter((w) => /ACTIVITY/.test(w)).length).toBe(1)
      // Gate OFF ⇒ no staged children (coarse single op node only).
      const joined = cap.writes.join("")
      expect(joined).not.toContain("Preparing workspace")
    },
  )
})
