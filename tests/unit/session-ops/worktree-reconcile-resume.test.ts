/**
 * RFC-06 §RFC06-2 — crash-resume RECONCILIATION wire (turn-boundary follower).
 *
 * `reconcileCreatingWorktree` (the PURE verdict) was built with ZERO production
 * caller: a worktree create that crashes between the intent-persist (step 1) and
 * the ready-publish (step 3) leaves a durable `creating` ownership record that
 * NOTHING reconciles at restart — an orphan. This module wires + PERSISTS the
 * verdict at the resume/session-load boundary (the same turn chokepoint the cwd
 * pin follower runs at), gated by the SAME `QUANTA_WORKTREE_CWD_PIN` opt-in.
 *
 * These tests exercise the REAL session store + a REAL git repo so the registry
 * inspection is authoritative (never a fake that hides the wire). The wire's
 * effect is OBSERVED via the durable record read back FRESH from disk.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reconcileCreatingWorktreeAtResume } from "@/runner/orchestrate"
import { createPersistentWorktree } from "@/runtime"
import {
  loadSessionById,
  makeWorkspaceCreateIntent,
  type SessionMeta,
  saveSessionById,
  type WorkspaceOwnership,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

const PIN = "QUANTA_WORKTREE_CWD_PIN"
const PAYLOAD = { reason: "t", turns: 3, messages: [] }

const sh = async (cwd: string, cmd: string): Promise<void> => {
  const p = Bun.spawn(["bash", "-lc", cmd], { cwd, stdout: "pipe", stderr: "pipe" })
  const code = await p.exited
  if (code !== 0) {
    throw new Error(`cmd failed (${code}): ${cmd}\n${await new Response(p.stderr).text()}`)
  }
}

const mkRepo = async (): Promise<string> => {
  const repo = await mkdtemp(join(tmpdir(), "wt-recon-resume-"))
  await sh(repo, "git init -q && git config user.email a@b.c && git config user.name t")
  await sh(repo, "git commit -q --allow-empty -m init")
  return repo
}

/** Persist a session whose ownership is stuck in `creating` (crash mid-create),
 *  with the EXACT `{path,branch}` the create owner mints for `ownershipId`. */
const seedCreating = async (
  sessionId: string,
  repo: string,
  ownershipId: string,
  path: string,
  branch: string,
): Promise<void> => {
  const intent = makeWorkspaceCreateIntent({
    ownershipId,
    ownerThreadId: sessionId,
    repoRoot: repo,
    repoId: repo,
    path,
    branch,
    baseSha: "HEAD",
    now: 1,
  })
  const meta: SessionMeta = {
    id: sessionId,
    title: "t",
    cwd: repo,
    createdAt: 1,
    lastTouched: 1,
    archived: false,
    workspaceOwnership: intent,
  }
  await saveSessionById(meta, PAYLOAD)
}

const readOwnership = async (id: string): Promise<WorkspaceOwnership | undefined> =>
  (await loadSessionById(id))?.meta.workspaceOwnership

describe("reconcileCreatingWorktreeAtResume (RFC06-2 crash-resume wire)", () => {
  let sessionsDir: string
  let repo: string | undefined
  beforeEach(async () => {
    sessionsDir = await mkdtemp(join(tmpdir(), "wtr-sess-"))
    process.env.QUANTA_SESSIONS_DIR = sessionsDir
    __resetRuntimeConfig()
    delete process.env[PIN]
  })
  afterEach(async () => {
    await rm(sessionsDir, { recursive: true, force: true }).catch(() => undefined)
    if (repo !== undefined) await rm(repo, { recursive: true, force: true }).catch(() => undefined)
    repo = undefined
    delete process.env.QUANTA_SESSIONS_DIR
    delete process.env[PIN]
    __resetRuntimeConfig()
  })

  const env = (): Record<string, string | undefined> => ({ ...process.env })

  test("gate ON + `creating` record whose worktree IS on disk ⇒ resume PROMOTES it to ready (orphan resolved)", async () => {
    repo = await mkRepo()
    const ownershipId = crypto.randomUUID()
    // Simulate the create effect landing (step 2) then a crash before publish:
    const created = await createPersistentWorktree(ownershipId, repo)
    await seedCreating("s1", repo, ownershipId, created.worktreePath, created.branch)
    // Pre-condition: the durable record is orphaned in `creating`.
    expect((await readOwnership("s1"))?.state).toBe("creating")

    process.env[PIN] = "1"
    await reconcileCreatingWorktreeAtResume({ sessionId: "s1", env: env(), now: () => 1000 })

    // GREEN: resume reconciled the orphan — the record is now `ready` on disk.
    expect((await readOwnership("s1"))?.state).toBe("ready")
  })

  test("gate ON + `creating` record with NO worktree on disk ⇒ resume rolls it back to failed (clean terminal)", async () => {
    repo = await mkRepo()
    const ownershipId = crypto.randomUUID()
    // Crash BEFORE the git effect: a `creating` record but no registered worktree.
    await seedCreating(
      "s1",
      repo,
      ownershipId,
      `${repo}/.quanta/worktrees/${ownershipId}`,
      `fork-${ownershipId}`,
    )
    expect((await readOwnership("s1"))?.state).toBe("creating")

    process.env[PIN] = "1"
    await reconcileCreatingWorktreeAtResume({ sessionId: "s1", env: env(), now: () => 1000 })

    // GREEN: the effect never landed ⇒ the orphan record is a clean terminal.
    const rec = await readOwnership("s1")
    expect(rec?.state).toBe("failed")
    expect(rec?.lastErrorCode).toBe("reconcile_no_worktree")
  })

  test("RED-ON-INJECTION / gate OFF ⇒ NO reconciliation: the `creating` orphan persists unresolved (byte-identical)", async () => {
    // A deliberately nonexistent repository makes this a stronger no-touch
    // assertion than provisioning a real worktree: any registry inspection on
    // the disabled path would fail the test immediately.
    const untouchedRepo = join(sessionsDir, "must-not-be-read")
    const ownershipId = crypto.randomUUID()
    await seedCreating(
      "s1",
      untouchedRepo,
      ownershipId,
      join(untouchedRepo, ".quanta", "worktrees", ownershipId),
      `fork-${ownershipId}`,
    )

    // Gate unset (default-OFF) — the wire must be a transparent no-op.
    await reconcileCreatingWorktreeAtResume({ sessionId: "s1", env: env(), now: () => 1000 })

    // The orphan is STILL `creating` — nothing ran. (This is exactly the state a
    // removed wire leaves: it is the red-on-injection witness. With the gate ON
    // the sibling test above asserts `ready`; removing the wire body makes THAT
    // test read `creating` too.)
    expect((await readOwnership("s1"))?.state).toBe("creating")
  })

  test("SAFETY: a `ready` (non-creating) record is NEVER touched at resume — no accidental transition", async () => {
    const untouchedRepo = join(sessionsDir, "ready-repo-must-not-be-read")
    const ownershipId = crypto.randomUUID()
    // Seed a ready ownership record — the steady-state, not a crash. The path
    // intentionally does not exist because this state must not touch Git.
    const intent = makeWorkspaceCreateIntent({
      ownershipId,
      ownerThreadId: "s1",
      repoRoot: untouchedRepo,
      repoId: untouchedRepo,
      path: join(untouchedRepo, ".quanta", "worktrees", ownershipId),
      branch: `fork-${ownershipId}`,
      baseSha: "HEAD",
      now: 1,
    })
    const meta: SessionMeta = {
      id: "s1",
      title: "t",
      cwd: untouchedRepo,
      createdAt: 1,
      lastTouched: 1,
      archived: false,
      // Manually place it in `ready` (the transition owner already validated it).
      workspaceOwnership: { ...intent, state: "ready", updatedAt: 2 },
    }
    await saveSessionById(meta, PAYLOAD)

    process.env[PIN] = "1"
    await reconcileCreatingWorktreeAtResume({ sessionId: "s1", env: env(), now: () => 9999 })

    const rec = await readOwnership("s1")
    expect(rec?.state).toBe("ready")
    // updatedAt untouched (no persist happened) — proves the noop path did not write.
    expect(rec?.updatedAt).toBe(2)
  })

  test("SAFETY: gate ON but NO ownership at all ⇒ no-op (nothing persisted)", async () => {
    const untouchedRepo = join(sessionsDir, "unowned-repo-must-not-be-read")
    const meta: SessionMeta = {
      id: "s1",
      title: "t",
      cwd: untouchedRepo,
      createdAt: 1,
      lastTouched: 1,
      archived: false,
    }
    await saveSessionById(meta, PAYLOAD)
    process.env[PIN] = "1"
    await reconcileCreatingWorktreeAtResume({ sessionId: "s1", env: env(), now: () => 1000 })
    expect(await readOwnership("s1")).toBeUndefined()
  })

  test("IDEMPOTENT: reconciling twice ⇒ the second pass is a no-op (already-terminal record unchanged)", async () => {
    repo = await mkRepo()
    const ownershipId = crypto.randomUUID()
    const created = await createPersistentWorktree(ownershipId, repo)
    await seedCreating("s1", repo, ownershipId, created.worktreePath, created.branch)
    process.env[PIN] = "1"

    await reconcileCreatingWorktreeAtResume({ sessionId: "s1", env: env(), now: () => 1000 })
    const afterFirst = await readOwnership("s1")
    expect(afterFirst?.state).toBe("ready")

    // Second pass: the record is `ready` (not `creating`) ⇒ noop verdict ⇒ no write.
    await reconcileCreatingWorktreeAtResume({ sessionId: "s1", env: env(), now: () => 5000 })
    const afterSecond = await readOwnership("s1")
    expect(afterSecond?.state).toBe("ready")
    // updatedAt is the FIRST reconcile's stamp (1000), not the second (5000) —
    // proving the second pass wrote nothing.
    expect(afterSecond?.updatedAt).toBe(1000)
  })

  test("CLOBBER-SAFE: a transcript change committed between verdict-load and persist is PRESERVED (fold re-reads under lock)", async () => {
    repo = await mkRepo()
    const ownershipId = crypto.randomUUID()
    const created = await createPersistentWorktree(ownershipId, repo)
    await seedCreating("s1", repo, ownershipId, created.worktreePath, created.branch)

    // Simulate a concurrent writer that advanced the transcript AFTER our verdict
    // snapshot would have been read but BEFORE the fold: mutate turns/messages via
    // a fresh save. The fold must carry THIS forward, not overwrite it with the
    // stale (turns:3) snapshot.
    const prior = await loadSessionById("s1")
    if (prior === undefined) throw new Error("seed missing")
    await saveSessionById(prior.meta, {
      reason: "advanced",
      turns: 99,
      messages: [{ role: "user", content: [{ type: "text", text: "concurrent" }] }] as never,
    })

    process.env[PIN] = "1"
    await reconcileCreatingWorktreeAtResume({ sessionId: "s1", env: env(), now: () => 1000 })

    const after = await loadSessionById("s1")
    // Ownership was reconciled to ready...
    expect(after?.meta.workspaceOwnership?.state).toBe("ready")
    // ...AND the concurrent transcript survived (turns:99, not the stale 3).
    expect(after?.turns).toBe(99)
    expect(after?.reason).toBe("advanced")
  })

  test("SAFETY: reconciliation NEVER removes the on-disk worktree (dirty-preservation invariant)", async () => {
    repo = await mkRepo()
    const ownershipId = crypto.randomUUID()
    const created = await createPersistentWorktree(ownershipId, repo)
    // Make the worktree DIRTY (uncommitted file) — reconcile must not delete it.
    await sh(created.worktreePath, "echo dirty > uncommitted.txt")
    await seedCreating("s1", repo, ownershipId, created.worktreePath, created.branch)
    process.env[PIN] = "1"

    await reconcileCreatingWorktreeAtResume({ sessionId: "s1", env: env(), now: () => 1000 })

    // The worktree dir + its dirty file still exist (reconcile only touches the
    // OWNED record; it never invokes any git removal).
    expect(await Bun.file(join(created.worktreePath, "uncommitted.txt")).exists()).toBe(true)
    // And the record was promoted (the worktree IS registered).
    expect((await readOwnership("s1"))?.state).toBe("ready")
  })
})
