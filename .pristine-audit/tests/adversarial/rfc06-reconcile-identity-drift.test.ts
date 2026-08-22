/**
 * ADVERSARIAL CORRECTNESS AUDIT (audit4) — aug-02 stateful features.
 *
 * Each test drives an adversarial crash/concurrency/TOCTOU/stale sequence
 * against the REAL owner and asserts the SAFE outcome. A failing assertion is a
 * finding (the code produced the UNSAFE state).
 */

import { describe, expect, test } from "bun:test"
import {
  executeRollback,
  type RollbackEffectPort,
  type RollbackRecordStore,
  type RollbackRecords,
  resumePendingRollback,
} from "@/agent/thread-rollback"
import type { TurnRegistrySnapshot } from "@/agent/turn-registry-snapshot"
import { createMcpToolReloadController } from "@/host/runtime/mcp-tool-reload"
import {
  ResumeRehydrateRefusedError,
  validateResumeSnapshot,
} from "@/sdk/runtime/session/rehydrate"
import type { SavedSession } from "@/session"
import { ROLLBACK_RECORD_VERSION, type RollbackOperationRecord } from "@/session"

/* ------------------------------------------------------------------ */
/* RFC04 reload controller — coalescing / lost-update / LKG            */
/* ------------------------------------------------------------------ */

/** A minimal snapshot with a controllable fingerprint. */
const snap = (id: number, fingerprint: string): TurnRegistrySnapshot =>
  ({
    id,
    protocolVersion: "x",
    // registry/specs are irrelevant to the controller's decision logic.
    registry: {} as never,
    specs: [],
    fingerprint,
  }) as TurnRegistrySnapshot

/** A plain publisher: a bare pointer, NO hidden LKG retention (so any
 *  "retained prior" behaviour must come from the controller, not the fake). */
const makePublisher = (initial: TurnRegistrySnapshot) => {
  let cur = initial
  const published: TurnRegistrySnapshot[] = []
  return {
    current: () => cur,
    publish: (n: TurnRegistrySnapshot) => {
      cur = n
      published.push(n)
    },
    published,
  }
}

describe("RFC04 reload controller — burst coalescing", () => {
  test("two list_changed during one in-flight relist ⇒ exactly one replay, no lost update", async () => {
    const pub = makePublisher(snap(0, "fp0"))
    // Sequence of fingerprints each rebuild() should return, in call order.
    const rebuildFps = ["fp1", "fp2", "fp3", "fp4"]
    let rebuildCalls = 0
    // Gate the FIRST rebuild so we can fire two more signals while it's in flight.
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r
    })
    const rebuild = async (): Promise<TurnRegistrySnapshot> => {
      const idx = rebuildCalls++
      if (idx === 0) await firstGate
      return snap(idx + 1, rebuildFps[idx] ?? `fpX${idx}`)
    }
    const ctl = createMcpToolReloadController(pub, rebuild)

    const a = ctl.requestReload() // starts drain → runOnce (gated)
    // Two more signals arrive DURING the in-flight rebuild.
    const b = ctl.requestReload()
    const c = ctl.requestReload()
    // Let the microtask queue settle so b,c have registered their dirty bit.
    await Promise.resolve()
    await Promise.resolve()
    releaseFirst()
    await Promise.all([a, b, c])

    // SAFE: one in-flight + exactly one dirty replay ⇒ 2 rebuilds total, and the
    // LATEST surface (fp2 from the replay) is published. NOT 3 parallel rebuilds,
    // and NOT a lost update where the replay never ran.
    expect(rebuildCalls).toBe(2)
    expect(pub.current().fingerprint).toBe("fp2")
    expect(pub.published.map((s) => s.fingerprint)).toEqual(["fp1", "fp2"])
  })

  test("signal arriving in the drain-exit window is not silently lost", async () => {
    // Attack the window between the final runOnce completing and inFlight=null.
    // We schedule a fresh requestReload() to fire from INSIDE the rebuild's
    // resolution continuation of the last drain iteration.
    const pub = makePublisher(snap(0, "fp0"))
    let rebuildCalls = 0
    let ctl!: ReturnType<typeof createMcpToolReloadController>
    let firedLate = false
    let lateReload: Promise<void> | undefined

    const rebuild = async (): Promise<TurnRegistrySnapshot> => {
      const idx = rebuildCalls++
      // On the FIRST rebuild's resolution, fire a brand-new signal right as the
      // rebuild settles — targeting the coalescing seam. Its surface (fpLate)
      // MUST eventually be published; if the controller loses it, current stays
      // at fp1 forever.
      if (idx === 0 && !firedLate) {
        firedLate = true
        // Fire on the next microtask so it lands while drain is finishing.
        queueMicrotask(() => {
          lateReload = ctl.requestReload()
        })
      }
      return snap(idx + 1, idx === 0 ? "fp1" : "fpLate")
    }
    ctl = createMcpToolReloadController(pub, rebuild)

    await ctl.requestReload()
    // Give the late signal a chance to run + settle.
    for (let i = 0; i < 10; i++) await Promise.resolve()
    if (lateReload) await lateReload

    // SAFE: the late signal produced a second rebuild and published fpLate.
    // If it were dropped, current would still be fp1 and rebuildCalls===1.
    expect(pub.current().fingerprint).toBe("fpLate")
    expect(rebuildCalls).toBe(2)
  })

  test("malformed relist (rebuild throws) ⇒ prior snapshot retained (LKG), no partial publish", async () => {
    const pub = makePublisher(snap(0, "good"))
    const rebuild = async (): Promise<TurnRegistrySnapshot> => {
      throw new Error("malformed page")
    }
    const ctl = createMcpToolReloadController(pub, rebuild)
    await ctl.requestReload()
    // SAFE: the throwing rebuild retained the prior good snapshot; nothing
    // published, no empty/partial surface.
    expect(pub.current().fingerprint).toBe("good")
    expect(pub.published.length).toBe(0)
  })

  test("unchanged fingerprint ⇒ no publish (no generation churn)", async () => {
    const pub = makePublisher(snap(0, "same"))
    const rebuild = async (): Promise<TurnRegistrySnapshot> => snap(9, "same")
    const ctl = createMcpToolReloadController(pub, rebuild)
    await ctl.requestReload()
    expect(pub.published.length).toBe(0)
    expect(pub.current().id).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* RFC01 ThreadRollback — intent→effect→receipt ordering & idempotency */
/* ------------------------------------------------------------------ */

/** A record store that logs every persisted operation-collection snapshot in
 *  order, so we can PROVE no success receipt was persisted before the effect. */
const makeLoggingStore = (records: RollbackRecords) => {
  let ops = [...records.operations]
  const writes: RollbackOperationRecord[][] = []
  const store: RollbackRecordStore = {
    async load() {
      return { checkpoints: records.checkpoints, operations: [...ops] }
    },
    async saveOperations(_id, operations) {
      ops = [...operations]
      writes.push([...operations])
    },
  }
  return { store, writes, snapshot: () => [...ops] }
}

const checkpoint = (turnId: string) => ({
  recordVersion: ROLLBACK_RECORD_VERSION,
  turnId,
  messageId: `${turnId}-msg`,
  checkpointSha: `sha-${turnId}`,
  expectedFileHashes: {},
})

const okEffect = (): RollbackEffectPort => ({
  async restoreToCheckpoint() {
    return { ok: true }
  },
})

describe("RFC01 ThreadRollback — crash/idempotency invariants", () => {
  test("crash BETWEEN intent-persist and effect ⇒ restart sees recovery_required, NO blind-retry, NO phantom success", async () => {
    // Model the crash: the effect NEVER completes on the first run (throws after
    // intent is durable). We then reload from the SAME durable ops and re-invoke
    // executeRollback (a naive restart) — it must NOT auto-succeed or re-run.
    const { store, snapshot } = makeLoggingStore({
      checkpoints: [checkpoint("t1")],
      operations: [],
    })
    // Crash model: a store whose SECOND save (the terminal) throws (disk gone) —
    // leaving exactly the intent durable, so restart sees a pending intent and
    // must NOT blind-retry the destructive restore.
    let saves = 0
    let frozen: RollbackOperationRecord[] = []
    const crashStore: RollbackRecordStore = {
      async load() {
        return { checkpoints: [checkpoint("t1")], operations: [...frozen] }
      },
      async saveOperations(_id, operations) {
        saves++
        if (saves === 1) {
          frozen = [...operations] // intent persisted durably
          return
        }
        throw new Error("crash: power lost before terminal receipt")
      },
    }
    let ran = 0
    const effect: RollbackEffectPort = {
      async restoreToCheckpoint() {
        ran++
        return { ok: true }
      },
    }
    const deps = { store: crashStore, effect, now: () => 1000 }
    await expect(
      executeRollback(deps, { sessionId: "s1", operationId: "op1", targetTurnId: "t1" }),
    ).rejects.toThrow(/power lost/)
    // The effect DID run once, but no terminal is durable.
    expect(ran).toBe(1)
    expect(frozen.map((o) => o.state)).toEqual(["requested"])

    // RESTART: a naive re-invocation of executeRollback must NOT blind-retry the
    // effect nor fabricate success — it surfaces recovery_required.
    let ran2 = 0
    const restartEffect: RollbackEffectPort = {
      async restoreToCheckpoint() {
        ran2++
        return { ok: true }
      },
    }
    const restartStore: RollbackRecordStore = {
      async load() {
        return { checkpoints: [checkpoint("t1")], operations: [...frozen] }
      },
      async saveOperations() {
        throw new Error("should not persist on a recovery_required short-circuit")
      },
    }
    const outcome = await executeRollback(
      { store: restartStore, effect: restartEffect, now: () => 2000 },
      { sessionId: "s1", operationId: "op1", targetTurnId: "t1" },
    )
    expect(outcome.kind).toBe("recovery_required")
    expect(ran2).toBe(0) // NO blind retry of the tree effect
    void snapshot
  })

  test("success receipt is persisted AFTER the effect — never before", async () => {
    let effectRan = false
    let terminalPersistedBeforeEffect = false
    const store: RollbackRecordStore = {
      async load() {
        return { checkpoints: [checkpoint("t1")], operations: [] }
      },
      async saveOperations(_id, operations) {
        const hasTerminal = operations.some((o) => o.state === "rolled_back")
        if (hasTerminal && !effectRan) terminalPersistedBeforeEffect = true
      },
    }
    const effect: RollbackEffectPort = {
      async restoreToCheckpoint() {
        effectRan = true
        return { ok: true }
      },
    }
    const out = await executeRollback(
      { store, effect, now: () => 1 },
      { sessionId: "s1", operationId: "op1", targetTurnId: "t1" },
    )
    expect(out.kind).toBe("rolled_back")
    expect(terminalPersistedBeforeEffect).toBe(false)
  })

  test("duplicate operationId after terminal ⇒ same receipt, NO second effect", async () => {
    const { store } = makeLoggingStore({ checkpoints: [checkpoint("t1")], operations: [] })
    let effectCalls = 0
    const effect: RollbackEffectPort = {
      async restoreToCheckpoint() {
        effectCalls++
        return { ok: true }
      },
    }
    const deps = { store, effect, now: () => 5 }
    const first = await executeRollback(deps, {
      sessionId: "s1",
      operationId: "dup",
      targetTurnId: "t1",
    })
    const second = await executeRollback(deps, {
      sessionId: "s1",
      operationId: "dup",
      targetTurnId: "t1",
    })
    expect(first.kind).toBe("rolled_back")
    expect(second.kind).toBe("rolled_back")
    expect(effectCalls).toBe(1) // idempotent — no duplicate tree mutation
  })

  test("missing checkpoint mapping ⇒ rollback_failed WITHOUT touching the tree", async () => {
    const { store } = makeLoggingStore({ checkpoints: [], operations: [] })
    let effectCalls = 0
    const effect: RollbackEffectPort = {
      async restoreToCheckpoint() {
        effectCalls++
        return { ok: true }
      },
    }
    const out = await executeRollback(
      { store, effect, now: () => 5 },
      { sessionId: "s1", operationId: "op1", targetTurnId: "unknown" },
    )
    expect(out.kind).toBe("rollback_failed")
    expect(effectCalls).toBe(0)
  })

  test("resumePendingRollback does NOT append a duplicate requested intent (idempotent history)", async () => {
    // Seed a pending intent (crash-after-intent state).
    const seeded: RollbackOperationRecord[] = [
      {
        recordVersion: ROLLBACK_RECORD_VERSION,
        operationId: "op1",
        targetTurnId: "t1",
        state: "requested",
        requestedAt: 100,
      },
    ]
    const { store, snapshot } = makeLoggingStore({
      checkpoints: [checkpoint("t1")],
      operations: seeded,
    })
    const out = await resumePendingRollback(
      { store, effect: okEffect(), now: () => 200 },
      { sessionId: "s1", operationId: "op1", targetTurnId: "t1" },
    )
    expect(out.kind).toBe("rolled_back")
    // History must have exactly ONE requested + ONE terminal for op1 — the resume
    // must not append a SECOND requested record (which pendingOperationIds would
    // otherwise mis-handle).
    const requestedCount = snapshot().filter(
      (o) => o.operationId === "op1" && o.state === "requested",
    ).length
    expect(requestedCount).toBe(1)
  })
})

/* ------------------------------------------------------------------ */
/* RFC01-4 rehydrate — fail-closed boundaries                          */
/* ------------------------------------------------------------------ */

const savedWith = (id: string, messages: unknown[]): SavedSession =>
  ({
    version: 2,
    meta: { id, title: "t", cwd: "/", createdAt: 0, lastTouched: 0, archived: false },
    reason: "x",
    turns: 0,
    messages,
  }) as SavedSession

describe("RFC01-4 rehydrate — fail-closed vs fresh boundaries", () => {
  test("ABSENT snapshot ⇒ fresh (undefined), NOT refuse", () => {
    expect(validateResumeSnapshot("sess", undefined)).toBeUndefined()
  })

  test("identity mismatch (swapped file) ⇒ REFUSE (fail-closed)", () => {
    const snap = savedWith("OTHER-ID", [])
    expect(() => validateResumeSnapshot("sess", snap)).toThrow(ResumeRehydrateRefusedError)
  })

  test("tampered transcript entry ⇒ REFUSE, never partial-merge", () => {
    const snap = savedWith("sess", [
      { role: "user", content: [] },
      { role: "NOT-A-ROLE", content: [] }, // tampered
    ])
    let err: unknown
    try {
      validateResumeSnapshot("sess", snap)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ResumeRehydrateRefusedError)
    expect((err as ResumeRehydrateRefusedError).component).toBe("transcript")
  })

  test("valid snapshot ⇒ returns the transcript verbatim (no silent-fresh)", () => {
    const msgs = [{ role: "user", content: [] }]
    const snap = savedWith("sess", msgs)
    const out = validateResumeSnapshot("sess", snap)
    expect(out).toBe(msgs as never)
  })

  test("ADVERSARIAL: content is an array of GARBAGE blocks (not real ContentBlocks) — does the gate catch it?", () => {
    // isMessage only checks Array.isArray(content); it does NOT validate each
    // block. A tampered transcript whose content array holds junk objects would
    // pass this boot-time gate. (The store-layer zod schema is the real defense;
    // this asserts what the rehydrate gate alone accepts.)
    const snap = savedWith("sess", [{ role: "user", content: [{ total: "garbage" }, 42, null] }])
    const out = validateResumeSnapshot("sess", snap)
    // Documenting observed behaviour: the rehydrate gate ACCEPTS it (defense is
    // deferred to the store zod schema at load time).
    expect(out).not.toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* RFC06-2 worktree reconcile — provisional-path vs created-path drift */
/* ------------------------------------------------------------------ */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join as pathJoin } from "node:path"
import { reconcileCreatingWorktree } from "@/runner/session-ops/current-thread-worktree"
import { createPersistentWorktree } from "@/runtime"
import { type SessionMeta, WORKSPACE_OWNERSHIP_VERSION } from "@/session"

const sh = async (cwd: string, cmd: string): Promise<void> => {
  const p = Bun.spawn(["bash", "-lc", cmd], { cwd, stdout: "pipe", stderr: "pipe" })
  const code = await p.exited
  if (code !== 0) {
    throw new Error(`cmd failed (${code}): ${cmd}\n${await new Response(p.stderr).text()}`)
  }
}

describe("RFC06-2 worktree reconcile — crash-between-effect-and-publish", () => {
  test("ADVERSARIAL: ownershipId that SLUGIFIES ⇒ real created worktree is mis-reconciled to FAILED (orphan leak)", async () => {
    const repo = await mkdtemp(pathJoin(tmpdir(), "wt-recon-"))
    try {
      await sh(repo, "git init -q && git config user.email a@b.c && git config user.name t")
      await sh(repo, "git commit -q --allow-empty -m init")

      // An ownershipId containing chars OUTSIDE [A-Za-z0-9._-] — e.g. a session id
      // that a caller minted with a "/" or ":" (or simply >48 chars). safeId() in
      // the create owner will transform this, so the ACTUAL created path differs
      // from the PROVISIONAL intent path the transition persists in step 1.
      const ownershipId = "thread:2026/08/04#run@x"

      // Step 2 effect: the REAL create owner mints its slugified path/branch.
      const created = await createPersistentWorktree(ownershipId, repo)

      // Step 1 intent, EXACTLY as transitionThreadToWorktree persists it BEFORE the
      // effect: provisional path = `${repoRoot}/.quanta/worktrees/${ownershipId}`
      // (raw id, NOT slugified) and provisional branch = `fork-${ownershipId}`.
      const provisionalPath = `${repo}/.quanta/worktrees/${ownershipId}`
      const provisionalBranch = `fork-${ownershipId}`
      // Sanity: the crash left a REAL registered worktree whose path/branch DIFFER
      // from the provisional record (that is the whole premise).
      expect(created.worktreePath).not.toBe(provisionalPath)
      expect(created.branch).not.toBe(provisionalBranch)

      const meta: SessionMeta = {
        id: "s1",
        title: "t",
        cwd: repo,
        createdAt: 0,
        lastTouched: 0,
        archived: false,
        workspaceOwnership: {
          recordVersion: WORKSPACE_OWNERSHIP_VERSION,
          ownershipId,
          ownerThreadId: "s1",
          repoRoot: repo,
          repoId: repo,
          path: provisionalPath,
          branch: provisionalBranch,
          baseSha: "HEAD",
          state: "creating",
          createdAt: 0,
          updatedAt: 0,
        },
      }

      // Restart reconciliation against the REAL live registry.
      const verdict = await reconcileCreatingWorktree(meta, () => 1000)

      // SAFE outcome (what the invariant promises): the effect LANDED (the worktree
      // IS registered), so reconcile should PROMOTE to ready — never mark a live,
      // registered worktree as failed. If it marks failed, the real worktree is
      // orphaned: the durable record says failed/quarantine (GC never reclaims a
      // path it can't match), and the git registry keeps a dangling worktree.
      expect(verdict.kind).toBe("promote_ready")
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})

describe("RFC06-2 worktree reconcile — user --branch sanitization drift (PRODUCTION-REACHABLE)", () => {
  test("ADVERSARIAL: UUID ownershipId (prod) + user --branch that safeBranch() rewrites ⇒ live worktree mis-reconciled to FAILED", async () => {
    const repo = await mkdtemp(pathJoin(tmpdir(), "wt-recon-br-"))
    try {
      await sh(repo, "git init -q && git config user.email a@b.c && git config user.name t")
      await sh(repo, "git commit -q --allow-empty -m init")

      // Production path: ownershipId is a randomUUID (safeId leaves it unchanged,
      // so the PATH matches). The only drift vector is the user-supplied --branch.
      const ownershipId = crypto.randomUUID()
      // A branch name with a char safeBranch() rewrites: `~` (and a space) →
      // sanitized to `-`. This is exactly `req.branch` in cmdWorktree.
      const userBranch = "feature~x y"

      // Step 2: real create owner sanitizes the branch.
      const created = await createPersistentWorktree(ownershipId, repo, { branch: userBranch })

      // Step 1 provisional intent as transitionThreadToWorktree persists it:
      // path uses the (unchanged) UUID; branch is the RAW user branch (NOT yet
      // sanitized — the code stores `req.branch ?? fork-${ownershipId}` verbatim).
      const provisionalPath = `${repo}/.quanta/worktrees/${ownershipId}`
      const provisionalBranch = userBranch

      // Path matches (UUID), but branch differs (safeBranch rewrote it).
      expect(created.worktreePath).toBe(provisionalPath)
      expect(created.branch).not.toBe(provisionalBranch)

      const meta: SessionMeta = {
        id: "s1",
        title: "t",
        cwd: repo,
        createdAt: 0,
        lastTouched: 0,
        archived: false,
        workspaceOwnership: {
          recordVersion: WORKSPACE_OWNERSHIP_VERSION,
          ownershipId,
          ownerThreadId: "s1",
          repoRoot: repo,
          repoId: repo,
          path: provisionalPath,
          branch: provisionalBranch,
          baseSha: "HEAD",
          state: "creating",
          createdAt: 0,
          updatedAt: 0,
        },
      }
      const verdict = await reconcileCreatingWorktree(meta, () => 1000)
      // SAFE: the worktree IS registered (path matches) ⇒ promote_ready. The branch
      // mismatch is a RECORD-vs-effect drift the transition itself introduced — it
      // must not cause a live worktree to be declared failed.
      expect(verdict.kind).toBe("promote_ready")
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})

describe("RFC06-2 reconcile — control: sanitized record reconciles correctly (proves branch-match is the discriminator)", () => {
  test("when the durable record stores the SANITIZED path+branch (the fix), reconcile promotes ready", async () => {
    const repo = await mkdtemp(pathJoin(tmpdir(), "wt-recon-fix-"))
    try {
      await sh(repo, "git init -q && git config user.email a@b.c && git config user.name t")
      await sh(repo, "git commit -q --allow-empty -m init")
      const ownershipId = crypto.randomUUID()
      const userBranch = "feature~x y"
      const created = await createPersistentWorktree(ownershipId, repo, { branch: userBranch })
      // Store the EXACT created path/branch (what a correct step-1 would derive).
      const meta: SessionMeta = {
        id: "s1",
        title: "t",
        cwd: repo,
        createdAt: 0,
        lastTouched: 0,
        archived: false,
        workspaceOwnership: {
          recordVersion: WORKSPACE_OWNERSHIP_VERSION,
          ownershipId,
          ownerThreadId: "s1",
          repoRoot: repo,
          repoId: repo,
          path: created.worktreePath,
          branch: created.branch,
          baseSha: "HEAD",
          state: "creating",
          createdAt: 0,
          updatedAt: 0,
        },
      }
      const verdict = await reconcileCreatingWorktree(meta, () => 1000)
      expect(verdict.kind).toBe("promote_ready") // fix passes ⇒ branch-match is the cause
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
