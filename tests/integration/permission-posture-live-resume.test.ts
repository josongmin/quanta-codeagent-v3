/**
 * RFC-05 E3 (durable resume) — the LIVE posture authority persists to E2's
 * on-disk `PermissionStore` and a FRESH runtime RESTORES the last effective
 * posture across a restart.
 *
 * The E3 "behavior-live cutover AND RESTART" half was BUILT (E2's
 * `createStorePosturePersistence` / `createStorePermissionDefaults`) but had ZERO
 * production callers: the live authority used an in-memory `Map` seeded only from
 * `runtime.mode`, so a restart RESET posture/mode/askOutsidePlan to the env/CLI
 * default. This suite is the RFC write-set that proves the wire is closed:
 *
 *   1. RESUME — a posture set in one runtime, persisted, is restored EXACTLY
 *      (effectiveMode / sandbox / reviewer / askOutsidePlan) by a FRESH runtime
 *      constructed over the SAME durable store (reloaded from disk — a true
 *      restart, not a shared in-memory cell).
 *   2. DEFAULT-OFF byte-identity — with NO posture mutation, a durable runtime
 *      over a fresh (empty) store reads `initialMode` (the on-absent SEED), so a
 *      clean machine is byte-identical to the legacy in-memory seed.
 *   3. CONCURRENT-KEY — two sessions keyed by DISTINCT session ids over the SAME
 *      shared on-disk store do NOT clobber each other (the fix that retires the
 *      `LIVE_POSTURE_THREAD_ID = "session"` constant for the durable path).
 *   4. FAIL-CLOSE — a corrupt/unknown-version on-disk record restores the
 *      current-behavior seed (never the corrupt bytes).
 *
 * RED-ON-INJECTION: revert `buildLivePosture` to the in-memory seed
 * (`createSeededPosturePersistence`) and test (1)/(3) go RED (the fresh runtime
 * resets to `initialMode`; the two sessions read the same cell).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildLivePostureRuntime,
  resolveDurableLivePosture,
} from "@/host/bootstrap/live-posture-runtime"
import { createPermissionStore, type PermissionStore } from "@/permission/permission-store"
import type { PosturePatch } from "@/permission/posture/types"
import { POSTURE_SCHEMA_VERSION } from "@/permission/posture-persistence"
import type { LivePostureDurableStore } from "@/runner/assemble/session-authorities"

let dir: string
let filePath: string

const freshStore = async (): Promise<PermissionStore> => {
  const store = createPermissionStore({ filePath, debounceMs: 0 })
  await store.load()
  return store
}

/** A lossless patch that moves EVERY resolved axis off its current-behavior
 *  default so a restore that silently reset to the default would be caught. */
const ELEVATED: PosturePatch = {
  mode: "acceptEdits",
  approvalPolicy: "never",
  approvalsReviewer: "agent",
  sandboxPolicy: { type: "workspace-write", writableRoots: ["/repo"], networkAccess: true },
  askOutsidePlan: false,
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "posture-resume-"))
  filePath = join(dir, "permission-state.json")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("RFC-05 E3 — durable posture resume", () => {
  test("a posture set in one runtime is RESTORED by a fresh runtime across a restart", async () => {
    const SID = "session-alpha"
    const store1 = await freshStore()
    const rt1 = buildLivePostureRuntime("default", { store: store1, sessionId: SID })
    // Sanity: before any mutation the fresh authority reads the seeded initialMode.
    expect(rt1.permissionModeState.get()).toBe("default")

    const outcome = await rt1.postureControl.apply({ patch: ELEVATED, scope: "current" })
    expect(outcome.ok).toBe(true)
    // The write is persist-observing (flushDurable); the bytes are on disk now.

    // TRUE RESTART: a brand-new store instance reloaded from the SAME file, and a
    // FRESH runtime over it — no shared in-memory cell survives.
    const store2 = await freshStore()
    const rt2 = buildLivePostureRuntime("default", { store: store2, sessionId: SID })

    // effectiveMode restored (NOT reset to the "default" initialMode).
    expect(rt2.permissionModeState.get()).toBe("acceptEdits")
    const eff = rt2.postureControl.read().effective
    expect(eff.effectiveMode).toBe("acceptEdits")
    // sandbox axis restored.
    expect(eff.threadPermission.sandboxPolicy.type).toBe("workspace-write")
    // approval + reviewer axes restored.
    expect(eff.threadPermission.approvalPolicy).toBe("never")
    expect(eff.threadPermission.approvalsReviewer).toBe("agent")
    // askOutsidePlan (the E5 question knob) restored — NOT the current-behavior true.
    expect(eff.askOutsidePlan).toBe(false)
    // The E5 question guard reads the SAME restored askOutsidePlan.
    expect(rt2.questionGuard.askOutsidePlan()).toBe(false)
  })

  test("DEFAULT-OFF byte-identity: a durable runtime over a fresh store reads initialMode (on-absent seed)", async () => {
    const store = await freshStore()
    // No prior record for this session id ⇒ the on-absent SEED yields initialMode,
    // byte-identical to the legacy in-memory seed (clean machine).
    const durable = buildLivePostureRuntime("acceptEdits", { store, sessionId: "s-fresh" })
    const memory = buildLivePostureRuntime("acceptEdits")
    expect(durable.permissionModeState.get()).toBe("acceptEdits")
    expect(durable.permissionModeState.get()).toBe(memory.permissionModeState.get())
    // The full effective view matches the legacy in-memory seed on a fresh machine.
    expect(durable.postureControl.read().effective).toEqual(memory.postureControl.read().effective)
    // No write happened (read-only on the default path) — disk stays empty for it.
    expect(store.getPosture("s-fresh")).toBeUndefined()
  })

  test("CONCURRENT-KEY: two sessions over the SAME store do NOT clobber each other", async () => {
    const store1 = await freshStore()
    const rtA = buildLivePostureRuntime("default", { store: store1, sessionId: "sess-A" })
    const outcome = await rtA.postureControl.apply({ patch: ELEVATED, scope: "current" })
    expect(outcome.ok).toBe(true)

    // Reload from disk; both a resumed A and a brand-new B read the SHARED store.
    const store2 = await freshStore()
    const rtAResumed = buildLivePostureRuntime("default", { store: store2, sessionId: "sess-A" })
    const rtB = buildLivePostureRuntime("default", { store: store2, sessionId: "sess-B" })

    // A resumed its elevated posture; B is untouched at its own initialMode.
    expect(rtAResumed.permissionModeState.get()).toBe("acceptEdits")
    expect(rtB.permissionModeState.get()).toBe("default")
    expect(rtB.postureControl.read().effective.askOutsidePlan).toBe(true)
    // Sanity: the two records are stored under distinct keys.
    expect(store2.getPosture("sess-A")).toBeDefined()
    expect(store2.getPosture("sess-B")).toBeUndefined()
  })

  test("FAIL-CLOSE: a corrupt on-disk record restores the current-behavior seed, not the bytes", async () => {
    const SID = "sess-corrupt"
    // Hand-write a state file with a corrupt posture record (unknown schemaVersion).
    const rawState = {
      version: 1,
      perThread: {},
      perHost: {},
      deniedActions: {},
      posture: {
        perThread: {
          [SID]: {
            requestedPatch: { mode: "bypass" },
            boundAskOutsidePlan: false,
            revision: 9,
            schemaVersion: POSTURE_SCHEMA_VERSION + 999,
          },
        },
        default: null,
      },
    }
    await writeFile(filePath, JSON.stringify(rawState), "utf8")

    const store = await freshStore()
    // The corrupt record is DROPPED at load ⇒ the on-absent seed = initialMode
    // (current behavior), never the corrupt "bypass"/rev-9.
    const rt = buildLivePostureRuntime("default", { store, sessionId: SID })
    expect(rt.permissionModeState.get()).toBe("default")
    expect(rt.postureControl.read().effective.askOutsidePlan).toBe(true)
  })
})

/**
 * The PRODUCTION wiring decision (`resolveDurableLivePosture`) — the assembler's
 * gate + per-session keying, exercised without a full bootstrap. It proves: the
 * durable path is DEFAULT-OFF (no gate ⇒ in-memory bind), it requires BOTH the
 * gate AND a supplied store, and when active it keys the record by the RESOLVED
 * session id (NOT the "session" constant).
 */
describe("RFC-05 E3 — resolveDurableLivePosture (production gate + keying)", () => {
  const captureBind = () => {
    let seen: LivePostureDurableStore | undefined | "unset" = "unset"
    const bind = (durable?: LivePostureDurableStore) => {
      seen = durable
      return buildLivePostureRuntime("default", durable)
    }
    return { bind, seenOf: () => seen }
  }

  test("DEFAULT-OFF: gate unset ⇒ in-memory bind (no durable store), even with a store present", async () => {
    const store = await freshStore()
    const { bind, seenOf } = captureBind()
    await resolveDurableLivePosture({
      bind,
      loadPermissionStore: async () => store,
      env: {}, // QUANTA_POSTURE_DURABLE_RESUME unset ⇒ default-OFF
      sessionId: "s1",
    })
    expect(seenOf()).toBeUndefined()
  })

  test("gate ON + store ⇒ durable bind keyed by the RESOLVED session id (not the 'session' constant)", async () => {
    const store = await freshStore()
    const { bind, seenOf } = captureBind()
    await resolveDurableLivePosture({
      bind,
      loadPermissionStore: async () => store,
      env: { QUANTA_POSTURE_DURABLE_RESUME: "1" },
      sessionId: "resolved-sid-123",
    })
    const seen = seenOf()
    expect(seen).not.toBe("unset")
    expect(seen).toBeDefined()
    expect((seen as LivePostureDurableStore).store).toBe(store)
    expect((seen as LivePostureDurableStore).sessionId).toBe("resolved-sid-123")
    expect((seen as LivePostureDurableStore).sessionId).not.toBe("session")
  })

  test("gate ON but NO loadPermissionStore dep ⇒ in-memory bind (surface opted out)", async () => {
    const { bind, seenOf } = captureBind()
    await resolveDurableLivePosture({
      bind,
      env: { QUANTA_POSTURE_DURABLE_RESUME: "1" },
      sessionId: "s2",
    })
    expect(seenOf()).toBeUndefined()
  })
})
