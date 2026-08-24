/**
 * HELLGATE — the bootstrap PRODUCER of the live posture control/guard.
 *
 * RFC-05 E4/E5 shipped a CLI/web posture front-door (`session.posture.set`,
 * `/posture`) and a `request_user_input` question guard. Every EXISTING posture
 * hellgate proves the CONSUMER leg — `buildBaseFromBootstrap` lifting
 * `boot.postureControl`/`boot.questionGuard` onto the base, the `/posture`
 * command, the dispatch predicate — but they all HAND-INJECT the control (they
 * call `buildLivePosture` / `buildLivePostureRuntime` themselves, or pass a
 * `bootDouble({postureControl})`). NONE drives the REAL producer:
 *
 *   `bootstrap-session.ts:178` calls `resolveDurableLivePosture(...)` and
 *   `bootstrap-session.ts:220/221` assign `postureControl` / `questionGuard`
 *   onto the returned `SessionBootstrapResult`.
 *
 * Both fields are OPTIONAL on `SessionBootstrapResult`, so DELETING line 220 (or
 * 221), or breaking `resolveDurableLivePosture` so it stops returning the
 * control, COMPILES CLEANLY and silently kills the shipped feature (`base.posture
 * Control` becomes undefined ⇒ `session.posture.set` drops the rich patch,
 * `/posture` prints "not wired", the question guard subtracts nothing) — yet
 * every consumer hellgate stays GREEN because it never ran the producer.
 *
 * This suite closes that gap: it drives the REAL `bootstrapSession` (the shipping
 * CLI's own bootstrap) with a typed no-op dep bundle — no disk, no network, no
 * `mock.module` — and asserts the boot result CARRIES a live `postureControl` +
 * `questionGuard` wired over ONE authority (identity/behavior, not `toBeDefined`).
 *
 * RED-on-injection (captured in the task log, restored immediately):
 *   - delete `postureControl,` at bootstrap-session.ts:220 ⇒ §1/§2/§3 RED
 *     (undefined control); every existing posture hellgate STAYS GREEN.
 *   - delete `questionGuard,` at :221 ⇒ §1/§2 RED (undefined guard).
 *   - neutralize the `postureControl`/`questionGuard` return in
 *     live-posture-runtime.ts `buildLivePostureRuntime` ⇒ §1/§2 RED.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bootstrapSession } from "@/host/bootstrap"
import { buildLivePostureRuntime } from "@/host/bootstrap/live-posture-runtime"
import { createPermissionStore, type PermissionStore } from "@/permission/permission-store"
import type { PosturePatch } from "@/permission/posture/types"
import {
  makeFakeBootstrapDeps as makeFakeDeps,
  makeFakeBootstrapRuntime as makeRuntime,
} from "../../_support/bootstrap-fake-deps"

describe("HELLGATE — bootstrap PRODUCES the live posture control + question guard", () => {
  test("1. the REAL bootstrap threads postureControl + questionGuard onto its result", async () => {
    // Drives bootstrap-session.ts:178 (resolveDurableLivePosture) + :220/:221
    // (the result assembly). No hand-injected control — this is the shipping path.
    const result = await bootstrapSession(makeFakeDeps(), makeRuntime(), {})

    // The E4 front-door control (line 220 → base.postureControl).
    expect(result.postureControl).toBeDefined()
    expect(typeof result.postureControl?.describe).toBe("function")
    expect(typeof result.postureControl?.read).toBe("function")
    expect(typeof result.postureControl?.apply).toBe("function")

    // The E5 question-availability guard (line 221 → AgentConfig.questionGuard).
    expect(result.questionGuard).toBeDefined()
    expect(typeof result.questionGuard?.askOutsidePlan).toBe("function")
  })

  test("2. the produced control + guard read/mutate the SAME live authority (identity, not toBeDefined)", async () => {
    const result = await bootstrapSession(makeFakeDeps(), makeRuntime(), {})
    const control = result.postureControl
    const guard = result.questionGuard
    // Narrow AND make the producer-deletion failure explicit/readable.
    if (control === undefined || guard === undefined) {
      throw new Error(
        "bootstrap dropped postureControl/questionGuard — the producer leg is unwired",
      )
    }

    // Current-behavior default: the fresh authority publishes askOutsidePlan=true
    // through BOTH the control's projection AND the guard.
    expect(guard.askOutsidePlan()).toBe(true)
    expect(control.describe().effective.askOutsidePlan).toBe(true)

    // Mutate through the E4 front door (the `session.posture.set` / `/posture`
    // engine). If the guard were a SEPARATE authority it would still read true.
    const outcome = await control.apply({ patch: { askOutsidePlan: false }, scope: "current" })
    expect(outcome.ok).toBe(true)

    // The SAME authority the control mutated is what the guard re-reads AND what
    // the control re-describes — proving one live authority, threaded by the
    // REAL producer, backs both views on the boot result.
    expect(guard.askOutsidePlan()).toBe(false)
    expect(control.describe().effective.askOutsidePlan).toBe(false)
  })
})

/**
 * Paired control on the durable-resume gate, driven through the REAL bootstrap:
 * proves `resolveDurableLivePosture`'s store actually THREADS onto the boot
 * result's `postureControl` (line 178 → 220), and that the gate is real.
 *
 * A pre-seeded on-disk store holds an elevated posture (askOutsidePlan=false)
 * under the resolved session id. With `QUANTA_POSTURE_DURABLE_RESUME=1` the boot
 * result's control RESTORES it; with the gate OFF the store is IGNORED and the
 * control reads the in-memory current-behavior seed (byte-identical to today).
 */
describe("HELLGATE (paired) — durable store threads onto the boot result's postureControl", () => {
  const SID = "producer-hellgate-session"
  const ELEVATED: PosturePatch = { askOutsidePlan: false }

  let dir: string
  let filePath: string

  const freshStore = async (): Promise<PermissionStore> => {
    const store = createPermissionStore({ filePath, debounceMs: 0 })
    await store.load()
    return store
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "posture-producer-"))
    filePath = join(dir, "permission-state.json")
    // Seed disk: persist an elevated posture under SID via one durable runtime,
    // then let a reloaded store surface it (a true restart, not a shared cell).
    const seedStore = await freshStore()
    const seedRuntime = buildLivePostureRuntime("default", { store: seedStore, sessionId: SID })
    const outcome = await seedRuntime.postureControl.apply({ patch: ELEVATED, scope: "current" })
    expect(outcome.ok).toBe(true)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const bootWithStore = async (env: Record<string, string>) => {
    const store = await freshStore()
    const deps = makeFakeDeps({
      loadPermissionStore: async () => store,
      // Pin the resolved session id so the durable key matches the seeded record
      // (decoupled from the shared fixture's default id).
      resolveResume: async () => ({
        sessionId: SID,
        history: [],
        idMeta: undefined,
        inIdMode: false,
        conflictError: undefined,
        missingIdError: undefined,
      }),
    })
    return bootstrapSession(deps, makeRuntime({ env }), {})
  }

  test("gate ON ⇒ the boot result's postureControl RESTORES the persisted posture", async () => {
    const result = await bootWithStore({ QUANTA_POSTURE_DURABLE_RESUME: "1" })
    expect(result.postureControl).toBeDefined()
    // The store's askOutsidePlan=false surfaces on the boot result's control —
    // the durable store threaded through :178 → :220 with no mutation applied.
    expect(result.postureControl?.describe().effective.askOutsidePlan).toBe(false)
    expect(result.questionGuard?.askOutsidePlan()).toBe(false)
  })

  test("gate OFF ⇒ the store is IGNORED; the control reads the in-memory seed (byte-identical)", async () => {
    const result = await bootWithStore({})
    expect(result.postureControl).toBeDefined()
    // Same store present, but the gate is off ⇒ the persisted false is NOT read;
    // the current-behavior seed (askOutsidePlan=true) is byte-identical to today.
    expect(result.postureControl?.describe().effective.askOutsidePlan).toBe(true)
    expect(result.questionGuard?.askOutsidePlan()).toBe(true)
  })
})
