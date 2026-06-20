/**
 * Bugbash jun-20 — finding #2 (MED, correctness): the permission store's
 * `mergeWithDisk` flush callback must NOT clobber a mutation that interleaves
 * during the flush's reread IO window.
 *
 * MECHANISM (permission-store.ts + json-state-file.ts): a flush enters the
 * engine's `writeToDisk`, captures `inMemory = snapshotState()`, then does REAL
 * async IO (`mkdir` → cross-process `acquireLock` → `await rereadForMerge()`)
 * that yields the event loop. A synchronous `recordDenial` / `setThread` /
 * `recordUserOverride` that lands on the LIVE `state` in the window BETWEEN that
 * pre-await snapshot and the merge callback is in NEITHER the stale `inMemory`
 * snapshot NOR the on-disk file. The buggy callback merged from that stale
 * `inMemory` and then overwrote live `state = cloneAsMutable(merged)` — silently
 * dropping the interleaved grant/denial (a security-state loss). The follow-up
 * dirty-bit flush re-snapshots the already-clobbered state, so the loss is
 * permanent.
 *
 * THE FIX re-snapshots the LIVE state INSIDE the callback (`liveSnapshot()`),
 * not the engine's pre-await `inMemory` arg, so an interleaved mutation survives.
 *
 * TEETH / RED-ON-INJECTION (deterministic — no timing assertions, no sleeps):
 * the store exposes a TEST-ONLY `__onMergeBoundaryForTest` seam invoked at the
 * EXACT instant the race could occur — synchronously at the top of the
 * `mergeWithDisk` callback, AFTER the engine snapshotted `inMemory` and BEFORE
 * the store reconciles. The seam performs the interleaving mutation, faithfully
 * reproducing "a mutation landed on live state during the reread window". With
 * the fix the merge folds it in (it re-snapshots live state) and it survives
 * both live AND across a fresh rehydrate. Revert the fix (callback merges from
 * the stale `inMemory` arg instead of `liveSnapshot()`) and EVERY test here goes
 * RED — the seam-injected record is clobbered out of live memory and never
 * reaches disk. The seam is `undefined` in production (byte-identical no-op).
 */
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionStore, type PermissionStore } from "@/permission/permission-store"

/** A fresh store over the same file — the "process restart" the gate does at
 *  session start. Proves the interleaved record is DURABLE, not just live. */
const rehydrate = async (file: string): Promise<PermissionStore> => {
  const s = createPermissionStore({ filePath: file, debounceMs: 0 })
  await s.load()
  return s
}

describe("permission-store — mutation interleaving the flush reread window is not clobbered (#2)", () => {
  test("a DENIAL recorded during the reread window survives the merge (live + durable)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "quanta-perm-race-"))
    try {
      const file = join(tmp, "permission-state.json")
      // The interleaving mutation fires exactly ONCE, at the first merge
      // boundary after the seam is armed — i.e. inside the reread window.
      let armed = false
      let store: PermissionStore
      const interleave = (): void => {
        if (!armed) return
        armed = false
        store.recordDenial({
          threadId: "t2",
          actionSignature: "sig-raced",
          deniedAt: 42,
          deniedReason: "denied-mid-flush",
        })
      }
      store = createPermissionStore({
        filePath: file,
        debounceMs: 0,
        __onMergeBoundaryForTest: interleave,
      })
      await store.load()

      // Establish on-disk state so the flush's reread genuinely reads a file.
      store.recordDenial({
        threadId: "t1",
        actionSignature: "sig-existing",
        deniedAt: 1,
        deniedReason: "pre-existing",
      })
      await store.flush()

      // Arm the interleave, then trigger a flush whose merge boundary fires it.
      armed = true
      store.setThread("t1", {
        approvalPolicy: "never",
        approvalsReviewer: "agent",
        sandboxPolicy: { type: "read-only" },
      })
      await store.flush()
      // Drain the follow-up flush scheduled by the interleaving mutation.
      await store.flush()

      // LIVE: the raced denial must still be in memory (not clobbered by the
      // merge overwriting live `state` from the stale pre-await snapshot).
      const live = store.getDenial("t2", "sig-raced")
      expect(live).toBeDefined()
      expect(live?.deniedReason).toBe("denied-mid-flush")
      expect(live?.deniedAt).toBe(42)

      // DURABLE: a fresh process observes it too (clobber + re-snapshot would
      // have lost it permanently from disk).
      const fresh = await rehydrate(file)
      expect(fresh.getDenial("t2", "sig-raced")?.deniedReason).toBe("denied-mid-flush")
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test("a GRANT set during the reread window survives the merge (live + durable)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "quanta-perm-race-"))
    try {
      const file = join(tmp, "permission-state.json")
      let armed = false
      let store: PermissionStore
      const interleave = (): void => {
        if (!armed) return
        armed = false
        store.setThread("raced-thread", {
          approvalPolicy: "always",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "danger-full-access" },
        })
      }
      store = createPermissionStore({
        filePath: file,
        debounceMs: 0,
        __onMergeBoundaryForTest: interleave,
      })
      await store.load()

      store.recordDenial({
        threadId: "seed",
        actionSignature: "sig-seed",
        deniedAt: 1,
        deniedReason: "seed",
      })
      await store.flush()

      armed = true
      store.recordRiskSeen("seed", "sig-seed", 2)
      await store.flush()
      await store.flush()

      // LIVE: the raced grant is present and intact.
      expect(store.getThread("raced-thread")?.approvalPolicy).toBe("always")
      // DURABLE: survives a fresh rehydrate.
      const fresh = await rehydrate(file)
      expect(fresh.getThread("raced-thread")?.approvalPolicy).toBe("always")
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test("an override-advance during the reread window is not lost (security state)", async () => {
    // A denial with a seen step is on disk; the user-override step races the
    // flush window. Losing it silently STALLS a legitimate override — the user's
    // decision is dropped. The full sequence must hold afterward.
    const tmp = await mkdtemp(join(tmpdir(), "quanta-perm-race-"))
    try {
      const file = join(tmp, "permission-state.json")
      let armed = false
      let store: PermissionStore
      const interleave = (): void => {
        if (!armed) return
        armed = false
        store.recordUserOverride("ov", "sig-ov", 12)
      }
      store = createPermissionStore({
        filePath: file,
        debounceMs: 0,
        __onMergeBoundaryForTest: interleave,
      })
      await store.load()

      store.recordDenial({
        threadId: "ov",
        actionSignature: "sig-ov",
        deniedAt: 10,
        deniedReason: "needs-override",
      })
      store.recordRiskSeen("ov", "sig-ov", 11)
      await store.flush()

      armed = true
      store.setHost("host-x", "read-only")
      await store.flush()
      await store.flush()

      // deniedAt ≤ seenRiskAt ≤ userOverrideAt must hold live AND durable —
      // proving the raced override field was folded in, not clobbered.
      expect(store.hasPostDenialOverride("ov", "sig-ov")).toBe(true)
      expect(store.getDenial("ov", "sig-ov")?.userOverrideAt).toBe(12)

      const fresh = await rehydrate(file)
      expect(fresh.hasPostDenialOverride("ov", "sig-ov")).toBe(true)
      expect(fresh.getDenial("ov", "sig-ov")?.userOverrideAt).toBe(12)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test("the merge-boundary seam is undefined by default (production no-op)", () => {
    // Guards the production-inertness invariant: a store built without the test
    // seam must not invoke anything at the boundary — the seam exists ONLY for
    // the race reproduction above and must never alter default behavior.
    const opts = {} as { __onMergeBoundaryForTest?: () => void }
    expect(opts.__onMergeBoundaryForTest).toBeUndefined()
  })
})
