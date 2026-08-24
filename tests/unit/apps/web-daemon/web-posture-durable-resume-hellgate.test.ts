/**
 * ★ HELLGATE — web-daemon DURABLE posture resume (RFC-05 E3, web parity with the
 * CLI E3 restart-resume).
 *
 * THE GAP: the WebSocket daemon minted its live posture from an in-memory
 * `buildLivePostureRuntime("default")` with NO durable store, so a daemon restart
 * RESET the operator's last effective mode/sandbox/reviewer/askOutsidePlan back to
 * the "default" seed. The CLI door already resumes durably (gate
 * QUANTA_POSTURE_DURABLE_RESUME) off the on-disk permission store; web did not.
 *
 * FIX: `resolveWebLivePosture` reuses the SAME `resolveDurableLivePosture` seam the
 * CLI/stdio bootstrap uses (ONE authority; NO second posture authority; NO
 * re-implementation of the store seeding), threading the CLI's `getDefaultPermissionStore`
 * loader and keying the daemon's posture by the STABLE daemon identity
 * `WEB_DAEMON_POSTURE_KEY` (the daemon has no resolved per-session id at build). Both
 * gates default-OFF ⇒ byte-identical in-memory seed with NO store I/O.
 *
 * RED-on-injection: revert `resolveWebLivePosture` to the in-memory
 * `buildLivePostureRuntime("default")` (drop the durable thread) ⇒ [E3W-1] flips (the
 * fresh build reads "default", NOT the mutated posture) while every control below
 * stays green — the exact restart-amnesia this hellgate closes.
 *
 * Invariants proven:
 *   [E3W-1] BOTH gates ON ⇒ a posture mutation persisted to a temp store is RESTORED
 *           by a FRESH factory build over the SAME store (simulated restart) — the
 *           mutated effective posture, NOT the "default" seed.
 *   [E3W-2] DURABLE_RESUME OFF (selector ON) ⇒ the fresh build is "default"
 *           (byte-identical) AND NO store record is written (no file touched).
 *   [E3W-3] SELECTOR ON but NO loadPermissionStore dep ⇒ in-memory seed (byte-identical).
 *   [E3W-4] corrupt on-disk record ⇒ fail-soft to the current-behavior seed (never
 *           the corrupt bytes; never a crash).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  resolveWebLivePosture,
  WEB_DAEMON_POSTURE_KEY,
} from "@/apps/web-daemon/runtime-factory/session-collaborators"
import { createPermissionStore, type PermissionStore } from "@/permission/permission-store"
import type { PosturePatch } from "@/permission/posture/types"
import { POSTURE_SCHEMA_VERSION } from "@/permission/posture-persistence"

let dir: string
let filePath: string

const freshStore = async (): Promise<PermissionStore> => {
  const store = createPermissionStore({ filePath, debounceMs: 0 })
  await store.load()
  return store
}

/** A lossless patch that moves the resolved axes off their current-behavior default
 *  so a restore that silently reset to "default" would be caught. */
const ELEVATED: PosturePatch = {
  mode: "acceptEdits",
  askOutsidePlan: false,
  sandboxPolicy: { type: "danger-full-access" },
}

const BOTH_ON = { QUANTA_POSTURE_SELECTOR: "1", QUANTA_POSTURE_DURABLE_RESUME: "1" }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "web-posture-durable-"))
  filePath = join(dir, "permission-state.json")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("RFC-05 E3w — web-daemon durable posture resume", () => {
  test("[E3W-1] both gates ON ⇒ a mutated posture is RESTORED by a FRESH factory build (restart)", async () => {
    const store1 = await freshStore()
    const live1 = await resolveWebLivePosture(BOTH_ON, async () => store1)
    expect(live1.postureControl).toBeDefined()
    // Baseline: the current-behavior default before any mutation.
    expect(live1.postureControl?.read().effective.effectiveMode).toBe("default")
    expect(live1.postureControl?.read().effective.askOutsidePlan).toBe(true)

    // Mutate the daemon's live posture (askOutsidePlan=false + a sandbox change).
    const outcome = await live1.postureControl?.apply({ patch: ELEVATED, scope: "current" })
    expect(outcome?.ok).toBe(true)
    // The record persisted under the STABLE daemon key.
    expect(store1.getPosture(WEB_DAEMON_POSTURE_KEY)).toBeDefined()

    // SIMULATED RESTART: a brand-new store reloaded from the SAME file + a FRESH web
    // posture over it — no shared in-memory cell survives.
    const store2 = await freshStore()
    const live2 = await resolveWebLivePosture(BOTH_ON, async () => store2)

    // LOAD-BEARING: the fresh build RESTORED the mutated posture, NOT the "default"
    // seed. (RED-on-injection: drop the durable thread ⇒ these revert to default.)
    const eff = live2.postureControl?.read().effective
    expect(eff?.effectiveMode).toBe("acceptEdits")
    expect(eff?.askOutsidePlan).toBe(false)
    expect(eff?.threadPermission.sandboxPolicy.type).toBe("danger-full-access")
    // The mode accessor + E5 guard read the SAME restored authority.
    expect(live2.permission.mode).toBe("acceptEdits")
    expect(live2.questionGuard?.askOutsidePlan()).toBe(false)
  })

  test("[E3W-2] DURABLE_RESUME OFF (selector ON) ⇒ fresh build is 'default' + NO store record written", async () => {
    const env = { QUANTA_POSTURE_SELECTOR: "1" } // DURABLE_RESUME unset ⇒ default-OFF
    const store1 = await freshStore()
    const live1 = await resolveWebLivePosture(env, async () => store1)
    // A mutation stays PROCESS-LOCAL (in-memory seed) — nothing reaches the store.
    await live1.postureControl?.apply({ patch: ELEVATED, scope: "current" })
    expect(store1.getPosture(WEB_DAEMON_POSTURE_KEY)).toBeUndefined()

    // A fresh build over the same (untouched) store reads the "default" seed — the
    // in-memory restart-amnesia behavior, byte-identical to today.
    const store2 = await freshStore()
    const live2 = await resolveWebLivePosture(env, async () => store2)
    expect(live2.postureControl?.read().effective.effectiveMode).toBe("default")
    expect(live2.postureControl?.read().effective.askOutsidePlan).toBe(true)
    expect(store2.getPosture(WEB_DAEMON_POSTURE_KEY)).toBeUndefined()
  })

  test("[E3W-3] SELECTOR ON but NO loadPermissionStore dep ⇒ in-memory seed (byte-identical)", async () => {
    // The surface opted out of a durable store ⇒ resolveDurableLivePosture binds the
    // in-memory seed even with DURABLE_RESUME on.
    const live = await resolveWebLivePosture(BOTH_ON)
    expect(live.postureControl).toBeDefined()
    expect(live.postureControl?.read().effective.effectiveMode).toBe("default")
    expect(live.postureControl?.read().effective.askOutsidePlan).toBe(true)
  })

  test("[E3W-4] corrupt on-disk record ⇒ fail-soft to the current-behavior seed (no crash)", async () => {
    // Hand-write a state file with a corrupt posture record (unknown schemaVersion)
    // under the daemon key. The store DROPS it at load ⇒ the on-absent seed stands.
    const rawState = {
      version: 1,
      perThread: {},
      perHost: {},
      deniedActions: {},
      posture: {
        perThread: {
          [WEB_DAEMON_POSTURE_KEY]: {
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
    const live = await resolveWebLivePosture(BOTH_ON, async () => store)
    // The corrupt "bypass"/rev-9 never reaches the seed — current behavior stands.
    expect(live.postureControl?.read().effective.effectiveMode).toBe("default")
    expect(live.postureControl?.read().effective.askOutsidePlan).toBe(true)
  })
})
